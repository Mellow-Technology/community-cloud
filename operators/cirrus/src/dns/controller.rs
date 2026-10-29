//! @file
//! The DnsProvider controller: from a provider to an ExternalDNS for
//! each namespace it publishes.
//!
//! Each pass checks the provider on its own, then against every other
//! provider for a domain two sets of namespaces could both write, then
//! that its credentials are there. Any of those failing means nothing
//! runs: an instance with the wrong domains is how the wrong namespace
//! would get a name, and one without credentials only crash-loops. The
//! instances it has already are removed, so fixing the conflict is
//! what brings them back.
//!
//! Instances are owned by their provider, so deleting it takes them
//! with it; a namespace taken off the list loses its instance here,
//! found by label. Because a change to one provider can put another in
//! or out of conflict, a change to any provider's spec reconciles them
//! all.
//!
//! Owner references from these namespaced objects point at a
//! cluster-scoped provider, which kube-rs's `owns` would look up in
//! the child's namespace. So the instances are watched by label
//! instead, and mapped back to their provider by name.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Secret, ServiceAccount};
use k8s_openapi::api::rbac::v1::ClusterRoleBinding;
use kube::api::{Api, DeleteParams, ListParams, Patch, PatchParams};
use kube::runtime::controller::{Action, Controller};
use kube::runtime::reflector::ObjectRef;
use kube::runtime::watcher;
use kube::{Client, ResourceExt};
use serde_json::json;

use super::instance::{self, NAMESPACE_LABEL, PROVIDER_LABEL};
use super::{DnsInstanceStatus, DnsProvider, conflicts};
use crate::conditions::{self, READY};
use crate::error::{Error, Result};
use crate::naming::dns_instance_name;
use crate::resources::{self, is_not_found};
use crate::settings::Settings;

// While an instance is starting, look again soon
const PENDING_REQUEUE: Duration = Duration::from_secs(15);

// Once settled. Also what clears a conflict whose other side was
// deleted, should the deletion's event be missed.
const SETTLED_REQUEUE: Duration = Duration::from_secs(5 * 60);

// For problems a person has to fix
const BLOCKED_REQUEUE: Duration = Duration::from_secs(2 * 60);

pub struct Context {
    pub client: Client,
    pub settings: Settings,
}

pub async fn run(client: Client, settings: Settings) {
    let providers = Api::<DnsProvider>::all(client.clone());
    let instances = Api::<Deployment>::namespaced(client.clone(), &settings.dns_namespace);
    let context = Arc::new(Context {
        client: client.clone(),
        settings,
    });
    Controller::new(providers.clone(), watcher::Config::default())
        .watches(
            instances,
            watcher::Config::default().labels(&format!("app.kubernetes.io/managed-by=cirrus,{PROVIDER_LABEL}")),
            |deployment| {
                deployment
                    .labels()
                    .get(PROVIDER_LABEL)
                    .map(|name| ObjectRef::<DnsProvider>::new(name))
            },
        )
        .reconcile_all_on(spec_changes(providers))
        .shutdown_on_signal()
        .run(reconcile, error_policy, context)
        .for_each(|result| async move {
            if let Err(error) = result {
                tracing::warn!(%error, "DnsProvider reconcile failed");
            }
        })
        .await;
}

/// A tick whenever a provider's spec changes or a provider goes, but
/// not for status writes, which would otherwise have every provider
/// reconcile every other in a loop.
fn spec_changes(providers: Api<DnsProvider>) -> impl futures::Stream<Item = ()> + Send + 'static {
    watcher(providers, watcher::Config::default())
        .scan(HashMap::<String, Option<i64>>::new(), |seen, event| {
            let tick = match event {
                Ok(watcher::Event::InitApply(provider)) => {
                    seen.insert(provider.name_any(), provider.metadata.generation);
                    false
                }
                Ok(watcher::Event::Apply(provider)) => {
                    seen.insert(provider.name_any(), provider.metadata.generation) != Some(provider.metadata.generation)
                }
                Ok(watcher::Event::Delete(provider)) => {
                    seen.remove(&provider.name_any());
                    true
                }
                _ => false,
            };
            futures::future::ready(Some(tick))
        })
        .filter_map(|tick| futures::future::ready(tick.then_some(())))
}

fn error_policy(_provider: Arc<DnsProvider>, error: &Error, _ctx: Arc<Context>) -> Action {
    tracing::warn!(%error, "will retry");
    Action::requeue(Duration::from_secs(30))
}

/// Why nothing may run, if something stops it.
async fn blocked(ctx: &Context, provider: &DnsProvider) -> Result<Option<(&'static str, String)>> {
    let problems = provider.problems();
    if !problems.is_empty() {
        return Ok(Some(("Invalid", problems.join("; "))));
    }

    let all = Api::<DnsProvider>::all(ctx.client.clone())
        .list(&ListParams::default())
        .await?
        .items;
    let conflicts = conflicts::conflicts(provider, &all);
    if !conflicts.is_empty() {
        return Ok(Some(("DomainConflict", conflicts.join("; "))));
    }

    let secrets = Api::<Secret>::namespaced(ctx.client.clone(), &ctx.settings.dns_namespace);
    let secret = provider.credentials_secret();
    if secrets.get_opt(&secret).await?.is_none() {
        return Ok(Some((
            "MissingCredentials",
            format!(
                "the Secret {secret} isn't in {}; put the provider's credentials there, one environment variable to a key",
                ctx.settings.dns_namespace
            ),
        )));
    }
    Ok(None)
}

/// Remove one instance, whatever of it is there.
async fn remove(ctx: &Context, name: &str) -> Result<()> {
    let namespace = &ctx.settings.dns_namespace;
    let params = DeleteParams::background();
    let gone = |result: Result<_, kube::Error>| match result {
        Ok(_) => Ok(()),
        Err(error) if is_not_found(&error) => Ok(()),
        Err(error) => Err(Error::from(error)),
    };
    gone(
        Api::<Deployment>::namespaced(ctx.client.clone(), namespace)
            .delete(name, &params)
            .await
            .map(|_| ()),
    )?;
    gone(
        Api::<ServiceAccount>::namespaced(ctx.client.clone(), namespace)
            .delete(name, &params)
            .await
            .map(|_| ()),
    )?;
    gone(
        Api::<ClusterRoleBinding>::all(ctx.client.clone())
            .delete(name, &params)
            .await
            .map(|_| ()),
    )
}

/// The namespaces this provider has instances for now.
async fn running(ctx: &Context, provider: &str) -> Result<Vec<(String, String)>> {
    let deployments = Api::<Deployment>::namespaced(ctx.client.clone(), &ctx.settings.dns_namespace);
    let found = deployments
        .list(&ListParams::default().labels(&format!(
            "app.kubernetes.io/managed-by=cirrus,{PROVIDER_LABEL}={provider}"
        )))
        .await?;
    Ok(found
        .items
        .iter()
        .map(|deployment| {
            (
                deployment.labels().get(NAMESPACE_LABEL).cloned().unwrap_or_default(),
                deployment.name_any(),
            )
        })
        .collect())
}

fn is_available(deployment: &Deployment) -> bool {
    deployment
        .status
        .as_ref()
        .and_then(|status| status.available_replicas)
        .unwrap_or(0)
        >= 1
}

async fn reconcile(provider: Arc<DnsProvider>, ctx: Arc<Context>) -> Result<Action> {
    let name = provider.name_any();
    let generation = provider.metadata.generation;
    let mut conditions = provider.status.clone().unwrap_or_default().conditions;
    let mut wanted: Vec<&str> = provider.spec.namespaces.iter().map(String::as_str).collect();
    wanted.sort_unstable();
    wanted.dedup();

    let stop = blocked(&ctx, &provider).await?;
    let mut instances = Vec::new();
    if stop.is_none() {
        let namespace = &ctx.settings.dns_namespace;
        let accounts = Api::<ServiceAccount>::namespaced(ctx.client.clone(), namespace);
        let bindings = Api::<ClusterRoleBinding>::all(ctx.client.clone());
        let deployments = Api::<Deployment>::namespaced(ctx.client.clone(), namespace);
        for watched in &wanted {
            let instance_name = dns_instance_name(&name, watched);
            resources::apply(
                &accounts,
                &instance_name,
                &instance::service_account(&provider, &ctx.settings, watched),
            )
            .await?;
            resources::apply(
                &bindings,
                &instance_name,
                &instance::cluster_role_binding(&provider, &ctx.settings, watched),
            )
            .await?;
            let applied = resources::apply(
                &deployments,
                &instance_name,
                &instance::deployment(&provider, &ctx.settings, watched),
            )
            .await?;
            instances.push(DnsInstanceStatus {
                namespace: watched.to_string(),
                deployment: instance_name,
                ready: is_available(&applied),
            });
        }
    }

    // Whatever runs that shouldn't: every instance when something
    // stops them, or one for a namespace no longer listed
    for (watched, deployment) in running(&ctx, &name).await? {
        if stop.is_some() || !wanted.contains(&watched.as_str()) {
            tracing::info!(provider = %name, namespace = %watched, "removing ExternalDNS");
            remove(&ctx, &deployment).await?;
        }
    }

    let (ok, reason, message, requeue) = match &stop {
        Some((reason, message)) => (false, *reason, message.clone(), BLOCKED_REQUEUE),
        None if instances.iter().all(|instance| instance.ready) => {
            let message = if wanted.is_empty() {
                "no namespaces are listed, so nothing is published".to_string()
            } else {
                String::new()
            };
            (true, "Ready", message, SETTLED_REQUEUE)
        }
        None => {
            let starting: Vec<&str> = instances
                .iter()
                .filter(|instance| !instance.ready)
                .map(|instance| instance.namespace.as_str())
                .collect();
            (
                false,
                "Progressing",
                format!("starting ExternalDNS for {}", starting.join(", ")),
                PENDING_REQUEUE,
            )
        }
    };
    conditions::set(&mut conditions, READY, ok, reason, message, generation);

    Api::<DnsProvider>::all(ctx.client.clone())
        .patch_status(
            &name,
            &PatchParams::default(),
            &Patch::Merge(json!({
                "status": {
                    "observedGeneration": generation,
                    "conditions": conditions,
                    "instances": instances,
                }
            })),
        )
        .await?;
    Ok(Action::requeue(requeue))
}
