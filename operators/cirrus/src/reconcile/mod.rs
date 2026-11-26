//! @file
//! The reconciler: from a WebApplication to everything it asked for.
//!
//! Each pass runs the same steps in the same order, and each step is
//! safe to repeat:
//!
//! 1. What the application depends on — Postgres, a bucket, RabbitMQ.
//!    Until every one of them is ready there's nothing to roll out,
//!    since an application started without its database only crashes.
//! 2. The forge: its webhook, and a poll for a release it missed,
//!    which settles the image to run.
//! 3. The port it listens on: the spec's, or the one the image
//!    declares (see port.rs).
//! 4. How it's reached, through the cluster Gateway.
//! 5. The rollout. When the image to run differs from the one
//!    deployed, migrations run first, and the Deployment is only
//!    given the new image once they've finished. An image whose port
//!    can't be worked out isn't rolled out, nor migrated for.
//! 6. The pods, which can go wrong after a rollout as well as during
//!    one (see pods.rs). Cirrus watches them, so a crash loop or a
//!    failed image pull is reported as it happens.
//!
//! Problems a person has to fix — a service not installed, a
//! namespace missing a label, a migration that failed — are written
//! into conditions and retried slowly. Everything else is an error,
//! retried by the controller.
//!
//! The status is written with a merge patch of only the fields this
//! pass owns. The webhook writes `release` from another task, and a
//! whole-status write here would race it and could drop a release on
//! the floor.

pub mod bucket;
pub mod cleanup;
pub mod config_hash;
pub mod connections;
pub mod environment;
pub mod migrations;
pub mod network;
pub mod pods;
pub mod port;
pub mod postgres;
pub mod rabbitmq;
pub mod source;
pub mod volumes;
pub mod workload;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{ConfigMap, EnvVar, Pod, Secret, Service};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference;
use k8s_openapi::jiff::Timestamp;
use kube::api::{Api, Patch, PatchParams};
use kube::runtime::controller::{Action, Controller};
use kube::runtime::finalizer::{Event as Finalizer, finalizer};
use kube::runtime::reflector::ObjectRef;
use kube::runtime::watcher;
use kube::{Client, Resource, ResourceExt};
use serde_json::json;

use crate::conditions::{self, HEALTHY, PROVISIONED, READY, RELEASE_CHECKED, ROLLED_OUT, WEBHOOK};
use crate::crd::WebApplication;
use crate::error::{Error, Result};
use crate::offerings::ServiceOffering;
use crate::resources;
use crate::settings::Settings;

pub const FINALIZER: &str = "community-cloud.technology/cirrus";

// While something is still being made, look again soon
const PENDING_REQUEUE: Duration = Duration::from_secs(15);

// Once settled, often enough for the forge poll to come due
const SETTLED_REQUEUE: Duration = Duration::from_secs(5 * 60);

// For problems a person has to fix, which won't fix themselves in
// seconds
const BLOCKED_REQUEUE: Duration = Duration::from_secs(2 * 60);

pub struct Context {
    pub client: Client,
    pub settings: Settings,
}

/// What a dependency gives the application once it's ready: Secrets
/// to load whole, and single variables.
#[derive(Debug, Default)]
pub struct Provided {
    pub env_from: Vec<String>,
    pub env: Vec<EnvVar>,
}

#[derive(Debug)]
pub enum Outcome {
    Ready(Provided),
    Pending(String),
}

pub fn identity(app: &WebApplication) -> (String, String) {
    (app.namespace().unwrap_or_else(|| "default".to_string()), app.name_any())
}

pub fn owner_reference(app: &WebApplication) -> OwnerReference {
    app.controller_owner_ref(&())
        .expect("a WebApplication from the API has a name and uid")
}

/// Labels on what's made in another namespace, where an owner
/// reference can't say whose it is.
pub fn cross_namespace_labels(namespace: &str, name: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("app.kubernetes.io/managed-by".to_string(), "cirrus".to_string()),
        (
            "cirrus.community-cloud.technology/namespace".to_string(),
            namespace.to_string(),
        ),
        ("cirrus.community-cloud.technology/name".to_string(), name.to_string()),
    ])
}

pub async fn run(client: Client, settings: Settings) {
    let apps = Api::<WebApplication>::all(client.clone());
    let context = Arc::new(Context {
        client: client.clone(),
        settings,
    });
    let controller = Controller::new(apps, watcher::Config::default());
    // The applications as last seen, to find which read a Secret or
    // ConfigMap that changed
    let secret_readers = controller.store();
    let config_readers = controller.store();
    controller
        .owns(Api::<Deployment>::all(client.clone()), watcher::Config::default())
        .owns(Api::<Service>::all(client.clone()), watcher::Config::default())
        .owns(Api::<Job>::all(client.clone()), watcher::Config::default())
        // Pods belong to a ReplicaSet, not to the WebApplication, so
        // they're found by the labels Cirrus gives them
        .watches(
            Api::<Pod>::all(client.clone()),
            watcher::Config::default().labels("app.kubernetes.io/managed-by=cirrus"),
            |pod| {
                let name = pod.labels().get("app.kubernetes.io/name")?;
                Some(ObjectRef::<WebApplication>::new(name).within(&pod.namespace()?))
            },
        )
        // An offering's consumers are the applications its address and
        // credentials go to, so they're looked at again when it changes
        .watches(
            Api::<ServiceOffering>::all(client.clone()),
            watcher::Config::default(),
            |offering| {
                offering
                    .status
                    .map(|status| status.consumers)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|consumer| ObjectRef::<WebApplication>::new(&consumer.name).within(&consumer.namespace))
                    .collect::<Vec<_>>()
            },
        )
        // A value it reads changing restarts it (config_hash.rs)
        .watches(
            Api::<Secret>::all(client.clone()),
            watcher::Config::default(),
            move |secret| readers(&secret_readers, config_hash::Source::Secret, &secret),
        )
        .watches(
            Api::<ConfigMap>::all(client.clone()),
            watcher::Config::default(),
            move |config| readers(&config_readers, config_hash::Source::ConfigMap, &config),
        )
        .shutdown_on_signal()
        .run(reconcile, error_policy, context)
        .for_each(|result| async move {
            if let Err(error) = result {
                tracing::warn!(%error, "reconcile failed");
            }
        })
        .await;
}

/// The applications in an object's namespace that read from it.
fn readers<K: kube::Resource>(
    store: &kube::runtime::reflector::Store<WebApplication>,
    source: config_hash::Source,
    object: &K,
) -> Vec<ObjectRef<WebApplication>> {
    let (Some(namespace), Some(name)) = (object.meta().namespace.as_deref(), object.meta().name.as_deref()) else {
        return Vec::new();
    };
    store
        .state()
        .iter()
        .filter(|app| app.namespace().as_deref() == Some(namespace))
        .filter(|app| config_hash::references_object(app, source, name))
        .map(|app| ObjectRef::from_obj(app.as_ref()))
        .collect()
}

async fn reconcile(app: Arc<WebApplication>, ctx: Arc<Context>) -> Result<Action> {
    let namespace = app.namespace().unwrap_or_else(|| "default".to_string());
    let api = Api::<WebApplication>::namespaced(ctx.client.clone(), &namespace);
    finalizer(&api, FINALIZER, app, |event| async {
        match event {
            Finalizer::Apply(app) => apply(&ctx, &app).await,
            Finalizer::Cleanup(app) => cleanup::run(&ctx, &app).await.map(|()| Action::await_change()),
        }
    })
    .await
    .map_err(|error| Error::Finalizer(error.to_string()))
}

fn error_policy(_app: Arc<WebApplication>, error: &Error, _ctx: Arc<Context>) -> Action {
    tracing::warn!(%error, "will retry");
    Action::requeue(Duration::from_secs(30))
}

// A dependency's outcome, with the problems a person has to fix kept
// as messages rather than errors
fn settle(
    outcome: Result<Outcome>,
    provided: &mut Provided,
    problems: &mut Vec<String>,
    pending: &mut Vec<String>,
) -> Result<()> {
    match outcome {
        Ok(Outcome::Ready(more)) => {
            provided.env_from.extend(more.env_from);
            provided.env.extend(more.env);
            Ok(())
        }
        Ok(Outcome::Pending(message)) => {
            pending.push(message);
            Ok(())
        }
        Err(Error::MissingService(message) | Error::NotPermitted(message)) => {
            problems.push(message);
            Ok(())
        }
        Err(error) => Err(error),
    }
}

async fn apply(ctx: &Context, app: &WebApplication) -> Result<Action> {
    let (namespace, name) = identity(app);
    let generation = app.metadata.generation;
    let previous = app.status.clone().unwrap_or_default();
    let mut conditions = previous.conditions.clone();

    // 1. What it depends on
    let mut provided = Provided::default();
    let mut problems = Vec::new();
    let mut pending = Vec::new();
    if app.spec.postgres.is_some() {
        settle(
            postgres::ensure(ctx, app).await,
            &mut provided,
            &mut problems,
            &mut pending,
        )?;
    }
    if app.spec.bucket.is_some() {
        settle(
            bucket::ensure(ctx, app).await,
            &mut provided,
            &mut problems,
            &mut pending,
        )?;
    }
    if app.spec.rabbitmq.is_some() {
        settle(
            rabbitmq::ensure(ctx, app).await,
            &mut provided,
            &mut problems,
            &mut pending,
        )?;
    }
    if !app.spec.volumes.is_empty() {
        settle(
            volumes::ensure(ctx, app).await,
            &mut provided,
            &mut problems,
            &mut pending,
        )?;
    }
    if !app.spec.connections.is_empty() {
        settle(
            connections::ensure(ctx, app).await,
            &mut provided,
            &mut problems,
            &mut pending,
        )?;
    }
    // Its secrets and the namespace's shared values, which hold the
    // rollout until each has a value
    let mut environment_status = None;
    let mut given_env = Vec::new();
    if !app.spec.secrets.is_empty() || !app.spec.shared.is_empty() {
        let (outcome, status) = environment::ensure(ctx, app).await;
        if let Ok(Outcome::Ready(ready)) = &outcome {
            given_env.clone_from(&ready.env);
        }
        environment_status = Some(status);
        settle(outcome, &mut provided, &mut problems, &mut pending)?;
    }
    // Its own offering, which waits on nothing: the offering's status
    // says when its Service is there
    connections::ensure_offered(ctx, app).await?;

    // 2. The forge
    let found = source::sync(ctx, app).await;
    if app.gitlab().is_some() {
        match &found.webhook_problem {
            None => conditions::set(&mut conditions, WEBHOOK, true, "Registered", "", generation),
            Some(problem) => conditions::set(
                &mut conditions,
                WEBHOOK,
                false,
                "NotRegistered",
                problem.clone(),
                generation,
            ),
        }
    }
    if let Some(problem) = &found.problem {
        tracing::warn!(%namespace, %name, %problem, "couldn't check the forge");
        conditions::set(
            &mut conditions,
            RELEASE_CHECKED,
            false,
            "CheckFailed",
            format!("couldn't check GitLab for the newest release, so it's tried again shortly: {problem}"),
            generation,
        );
    } else if found.checked_at.is_some() {
        match &found.no_image {
            None => conditions::set(&mut conditions, RELEASE_CHECKED, true, "Checked", "", generation),
            // GitLab answered, so this waits for the next poll rather
            // than being tried again shortly
            Some(why) => conditions::set(
                &mut conditions,
                RELEASE_CHECKED,
                false,
                "NoImage",
                why.clone(),
                generation,
            ),
        }
    }
    let release = found.release.clone().or(previous.release.clone());
    let mut current = app.clone();
    current.status.get_or_insert_with(Default::default).release = release;
    let desired = current.desired_image();

    // 3. The port, for the image about to run. The Service and the
    // route follow it, or keep the port they had while it isn't known.
    let mut image_ports = previous.image_ports.clone();
    let desired_port = port::resolve(ctx, app, &desired, &mut image_ports).await?;
    let port_problem = desired_port.as_ref().err().cloned();
    let service_port = desired_port.as_ref().ok().copied().or(previous.port);

    // 4. How it's reached
    let url = match service_port {
        Some(port) => match network::ensure(ctx, app, port).await {
            Ok(url) => url,
            Err(Error::MissingService(message) | Error::NotPermitted(message)) => {
                problems.push(message);
                None
            }
            Err(error) => return Err(error),
        },
        // Nothing to point a route at until there's a port
        None => previous.url.clone(),
    };

    let provisioned = problems.is_empty() && pending.is_empty();
    let (reason, message) = if !problems.is_empty() {
        ("Blocked", problems.join("; "))
    } else if !pending.is_empty() {
        ("Waiting", pending.join("; "))
    } else {
        ("Provisioned", String::new())
    };
    conditions::set(&mut conditions, PROVISIONED, provisioned, reason, message, generation);

    // 5. The rollout
    let mut deployed = previous.deployed_image.clone();
    let mut migration_job = None;
    let mut rolled_out = false;
    if provisioned {
        if let Some(port) = service_port {
            resources::apply(
                &Api::<Service>::namespaced(ctx.client.clone(), &namespace),
                &name,
                &workload::service(app, port),
            )
            .await?;
        }

        let mut run = deployed.clone();
        if deployed.as_deref() != Some(desired.as_str()) {
            if let Some(problem) = &port_problem {
                // Not migrated for either: the schema shouldn't move
                // ahead of an image that can't be run
                conditions::set(
                    &mut conditions,
                    ROLLED_OUT,
                    false,
                    "PortUnknown",
                    problem.clone(),
                    generation,
                );
            } else if app.spec.migrations.is_some() {
                let (job, state) = migrations::ensure(ctx, app, &desired, &provided.env_from, &provided.env).await?;
                match state {
                    migrations::JobState::Succeeded => run = Some(desired.clone()),
                    migrations::JobState::Running => {
                        conditions::set(
                            &mut conditions,
                            ROLLED_OUT,
                            false,
                            "Migrating",
                            format!("running {job} for {desired}"),
                            generation,
                        );
                        migration_job = Some(job);
                    }
                    migrations::JobState::Waiting(running) => {
                        conditions::set(
                            &mut conditions,
                            ROLLED_OUT,
                            false,
                            "Migrating",
                            format!("waiting for {running} to finish before migrating for {desired}"),
                            generation,
                        );
                        migration_job = Some(job);
                    }
                    migrations::JobState::Failed(message) => {
                        conditions::set(
                            &mut conditions,
                            ROLLED_OUT,
                            false,
                            "MigrationFailed",
                            format!("{job} failed, so {desired} wasn't rolled out: {message}"),
                            generation,
                        );
                        migration_job = Some(job);
                    }
                }
            } else {
                run = Some(desired.clone());
            }
        }

        // The port of the image actually running, which is the old
        // image's own while migrations run for a new one
        let run_port = run.as_deref().and_then(|image| {
            if image == desired {
                desired_port.as_ref().ok().copied()
            } else {
                app.spec
                    .port
                    .or_else(|| port::cached(&image_ports, image))
                    .or(previous.port)
            }
        });

        if let (Some(image), Some(port)) = (run, run_port) {
            let deployments = Api::<Deployment>::namespaced(ctx.client.clone(), &namespace);
            let mut deployment = workload::deployment(app, &image, port, &provided.env_from, &provided.env);
            // A changed value it reads restarts it
            config_hash::annotate(
                &mut deployment,
                config_hash::compute(&ctx.client, &namespace, app, &given_env).await?,
            );
            let applied = resources::apply(&deployments, &name, &deployment).await?;
            rolled_out = workload::rolled_out(&applied, app.spec.replicas) && image == desired;
            deployed = Some(image);
            if migration_job.is_none() && port_problem.is_none() {
                let (reason, message) = if rolled_out {
                    ("RolledOut", String::new())
                } else {
                    ("Progressing", format!("rolling out {desired}"))
                };
                conditions::set(&mut conditions, ROLLED_OUT, rolled_out, reason, message, generation);
            }
        }
    } else {
        conditions::set(
            &mut conditions,
            ROLLED_OUT,
            false,
            "WaitingForDependencies",
            "",
            generation,
        );
    }

    // 6. The pods
    if deployed.is_some() {
        let health = pods::assess(&pods::list(ctx, app).await?, app.spec.replicas, Timestamp::now());
        conditions::set(
            &mut conditions,
            HEALTHY,
            health.state == pods::State::Healthy,
            health.reason(),
            health.message,
            generation,
        );
    } else {
        conditions::set(&mut conditions, HEALTHY, false, "NotDeployed", "", generation);
    }

    let ready = provisioned && rolled_out;
    conditions::set(
        &mut conditions,
        READY,
        ready,
        if ready { "Ready" } else { "NotReady" },
        "",
        generation,
    );

    // Only the images still in play; the spec's own port needs none
    port::prune(&mut image_ports, &[deployed.as_deref(), Some(desired.as_str())]);
    let mut status = json!({
        "observedGeneration": generation,
        "conditions": conditions,
        "deployedImage": deployed,
        "migrationJob": migration_job,
        "url": url,
        "port": service_port,
        "imagePorts": image_ports,
        // Null when it has none, so a merge patch takes away an old one
        "environment": environment_status,
    });
    if let Some(webhook) = &found.webhook {
        status["webhook"] = json!(webhook);
    }
    if let Some(release) = &found.release {
        status["release"] = json!(release);
    }
    if let Some(checked) = &found.checked_at {
        status["lastChecked"] = json!(checked);
    }
    let api = Api::<WebApplication>::namespaced(ctx.client.clone(), &namespace);
    api.patch_status(
        &name,
        &PatchParams::default(),
        &Patch::Merge(json!({ "status": status })),
    )
    .await?;

    // A failed forge check is tried again within minutes, not at the
    // settled pace, since the rollout may be on a stale tag until it
    // works
    Ok(
        if !problems.is_empty() || found.problem.is_some() || port_problem.is_some() {
            Action::requeue(BLOCKED_REQUEUE)
        } else if !ready {
            Action::requeue(PENDING_REQUEUE)
        } else {
            Action::requeue(SETTLED_REQUEUE)
        },
    )
}

#[cfg(test)]
pub mod tests {
    use crate::crd::{ImageSpec, WebApplication, WebApplicationSpec};

    /// An application as the API would hand it over, with a uid.
    pub fn app() -> WebApplication {
        let mut app = WebApplication::new(
            "shop",
            WebApplicationSpec {
                image: ImageSpec {
                    repository: "registry.gitlab.com/acme/shop".into(),
                    tag: "main".into(),
                },
                replicas: 1,
                port: Some(8080),
                ..Default::default()
            },
        );
        app.metadata.namespace = Some("team".into());
        app.metadata.uid = Some("0000-1111".into());
        app
    }
}
