//! @file
//! Keeps every namespace's `cirrus-capabilities` ConfigMap current.
//!
//! It looks again when a namespace changes, since its labels are what
//! let it in to the Gateway and SeaweedFS, and every few minutes,
//! which is what notices an operator being installed, a quota filling
//! up or an offering being shared, without watching all of them.
//!
//! Whether a service is installed is found by listing its kind, which
//! Cirrus may already do: a 404 means the CRD isn't there. The
//! Kubernetes system namespaces are left out, since nothing is deployed
//! to them through Cirrus.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, ResourceQuota};
use k8s_openapi::api::networking::v1::NetworkPolicy;
use k8s_openapi::api::storage::v1::StorageClass;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::runtime::controller::{Action, Controller};
use kube::runtime::watcher;
use kube::{Client, ResourceExt};
use serde_json::json;

use super::{CONFIG_MAP, Facts, KEY, Offering, cilium_policy_limits_egress, decide, network_policy_limits_egress};
use crate::conditions::READY;
use crate::error::{Error, Result};
use crate::offerings::{ServiceOffering, may_connect};
use crate::reconcile::bucket::BUCKETS_LABEL;
use crate::reconcile::network::{GATEWAY_LABEL, GATEWAY_LABEL_VALUE};
use crate::reconcile::volumes::bytes;
use crate::resources::{self, BUCKET, FIELD_MANAGER, Kind, POSTGRES_CLUSTER, VHOST};
use crate::settings::Settings;

// How often a namespace is looked at again on its own
const REQUEUE: Duration = Duration::from_secs(180);

const RABBITMQ_CLUSTER: Kind = Kind {
    group: "rabbitmq.com",
    version: "v1beta1",
    kind: "RabbitmqCluster",
    plural: "rabbitmqclusters",
    service: "the RabbitMQ cluster operator",
};
const CILIUM_POLICY: Kind = Kind {
    group: "cilium.io",
    version: "v2",
    kind: "CiliumNetworkPolicy",
    plural: "ciliumnetworkpolicies",
    service: "Cilium",
};
const CILIUM_CLUSTER_POLICY: Kind = Kind {
    group: "cilium.io",
    version: "v2",
    kind: "CiliumClusterwideNetworkPolicy",
    plural: "ciliumclusterwidenetworkpolicies",
    service: "Cilium",
};

pub struct Context {
    pub client: Client,
    pub settings: Settings,
}

pub async fn run(client: Client, settings: Settings) {
    let namespaces = Api::<Namespace>::all(client.clone());
    let context = Arc::new(Context { client, settings });
    Controller::new(namespaces, watcher::Config::default())
        .shutdown_on_signal()
        .run(reconcile, error_policy, context)
        .for_each(|result| async move {
            if let Err(error) = result {
                tracing::warn!(%error, "capabilities reconcile failed");
            }
        })
        .await;
}

fn error_policy(_namespace: Arc<Namespace>, error: &Error, _ctx: Arc<Context>) -> Action {
    tracing::warn!(%error, "will retry");
    Action::requeue(Duration::from_secs(60))
}

/// Whether a namespace is one of Kubernetes's own.
pub fn is_system(name: &str) -> bool {
    matches!(name, "kube-system" | "kube-public" | "kube-node-lease")
}

async fn reconcile(namespace: Arc<Namespace>, ctx: Arc<Context>) -> Result<Action> {
    let name = namespace.name_any();
    if is_system(&name) || namespace.metadata.deletion_timestamp.is_some() {
        return Ok(Action::await_change());
    }
    let facts = gather(&ctx, &namespace).await?;
    write(&ctx.client, &name, &decide(&facts)).await?;
    Ok(Action::requeue(REQUEUE))
}

/// Whether a kind's CRD is installed: listing it works, or is a 404.
async fn installed(client: &Client, kind: &Kind, namespace: &str) -> Result<bool> {
    match kind.api(client, namespace).list(&ListParams::default().limit(1)).await {
        Ok(_) => Ok(true),
        Err(error) if resources::is_not_found(&error) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// Whether an object of a kind is there, false too when its CRD isn't.
async fn exists(client: &Client, kind: &Kind, namespace: &str, name: &str) -> Result<bool> {
    match kind.api(client, namespace).get_opt(name).await {
        Ok(found) => Ok(found.is_some()),
        Err(error) if resources::is_not_found(&error) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// The room left under a namespace's storage quotas, the tightest of
/// them, or nothing when none limits storage.
pub fn storage_room(quotas: &[ResourceQuota]) -> Option<f64> {
    quotas
        .iter()
        .filter_map(|quota| {
            let hard = quota.status.as_ref()?.hard.as_ref()?.get("requests.storage")?;
            let used = quota
                .status
                .as_ref()?
                .used
                .as_ref()
                .and_then(|used| used.get("requests.storage"))
                .and_then(|used| bytes(&used.0))
                .unwrap_or(0.0);
            Some(bytes(&hard.0)? - used)
        })
        .reduce(f64::min)
}

async fn gather(ctx: &Context, namespace: &Namespace) -> Result<Facts> {
    let client = &ctx.client;
    let settings = &ctx.settings;
    let name = namespace.name_any();
    let labels = namespace.labels();

    let quotas = Api::<ResourceQuota>::namespaced(client.clone(), &name)
        .list(&ListParams::default())
        .await?
        .items;
    let storage_classes = Api::<StorageClass>::all(client.clone())
        .list(&ListParams::default())
        .await?
        .items
        .iter()
        .map(ResourceExt::name_any)
        .collect();

    let mut egress_policies: Vec<String> = Api::<NetworkPolicy>::namespaced(client.clone(), &name)
        .list(&ListParams::default())
        .await?
        .items
        .iter()
        .filter(|policy| network_policy_limits_egress(&json!(policy)))
        .map(|policy| format!("NetworkPolicy/{}", policy.name_any()))
        .collect();
    egress_policies.extend(
        cilium_policies(client, &CILIUM_POLICY, &name)
            .await?
            .into_iter()
            .map(|policy| format!("CiliumNetworkPolicy/{policy}")),
    );
    let cluster_egress_policies = cilium_policies(client, &CILIUM_CLUSTER_POLICY, "")
        .await?
        .into_iter()
        .map(|policy| format!("CiliumClusterwideNetworkPolicy/{policy}"))
        .collect();

    let offerings = Api::<ServiceOffering>::all(client.clone())
        .list(&ListParams::default())
        .await?
        .items
        .into_iter()
        .filter_map(|offering| {
            let offering_namespace = offering.namespace()?;
            if !may_connect(&offering_namespace, &offering.spec.share_with, &name) {
                return None;
            }
            let ready = offering
                .status
                .as_ref()
                .is_some_and(|status| status.conditions.iter().any(|c| c.type_ == READY && c.status == "True"));
            Some(Offering {
                name: offering.name_any(),
                namespace: offering_namespace,
                title: offering.spec.title.clone(),
                description: offering.spec.description.clone(),
                protocol: offering.spec.protocol.name().to_string(),
                ready,
            })
        })
        .collect();

    Ok(Facts {
        namespace: name.clone(),
        postgres_installed: installed(client, &POSTGRES_CLUSTER, &name).await?,
        rabbitmq_topology_installed: installed(client, &VHOST, &settings.services_namespace).await?,
        buckets_installed: installed(client, &BUCKET, &name).await?,
        rabbitmq_cluster_present: exists(
            client,
            &RABBITMQ_CLUSTER,
            &settings.services_namespace,
            &settings.rabbitmq_cluster,
        )
        .await?,
        rabbitmq_cluster_name: settings.rabbitmq_cluster.clone(),
        rabbitmq_namespace: settings.services_namespace.clone(),
        postgres_running: exists(client, &POSTGRES_CLUSTER, &name, &settings.postgres_cluster).await?,
        postgres_storage: settings.postgres_storage_size.clone(),
        storage_room: storage_room(&quotas),
        gateway_label: labels
            .get(GATEWAY_LABEL)
            .is_some_and(|value| value == GATEWAY_LABEL_VALUE),
        buckets_label: labels.get(BUCKETS_LABEL).is_some_and(|value| value == "true"),
        storage_classes,
        egress_policies,
        cluster_egress_policies,
        offerings,
    })
}

/// The Cilium policies of a kind that limit egress, by name; none when
/// Cilium isn't there. An empty namespace means cluster-wide.
async fn cilium_policies(client: &Client, kind: &Kind, namespace: &str) -> Result<Vec<String>> {
    let api = if namespace.is_empty() {
        Api::all_with(client.clone(), &kind.api_resource())
    } else {
        kind.api(client, namespace)
    };
    match api.list(&ListParams::default()).await {
        Ok(list) => Ok(list
            .items
            .iter()
            .filter(|policy| cilium_policy_limits_egress(&policy.data))
            .map(ResourceExt::name_any)
            .collect()),
        Err(error) if resources::is_not_found(&error) => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

/// Writes the ConfigMap, owning only what it sets.
async fn write(client: &Client, namespace: &str, capabilities: &super::Capabilities) -> Result<()> {
    let config_map = ConfigMap {
        metadata: ObjectMeta {
            name: Some(CONFIG_MAP.to_string()),
            namespace: Some(namespace.to_string()),
            labels: Some(
                [
                    ("app.kubernetes.io/managed-by".to_string(), "cirrus".to_string()),
                    ("app.kubernetes.io/component".to_string(), "capabilities".to_string()),
                ]
                .into(),
            ),
            ..ObjectMeta::default()
        },
        data: Some(
            [(
                KEY.to_string(),
                serde_json::to_string_pretty(capabilities).map_err(|error| Error::Config(error.to_string()))?,
            )]
            .into(),
        ),
        ..ConfigMap::default()
    };
    Api::<ConfigMap>::namespaced(client.clone(), namespace)
        .patch(
            CONFIG_MAP,
            &PatchParams::apply(FIELD_MANAGER).force(),
            &Patch::Apply(&config_map),
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::ResourceQuotaStatus;
    use k8s_openapi::apimachinery::pkg::api::resource::Quantity;

    fn quota(hard: &str, used: &str) -> ResourceQuota {
        ResourceQuota {
            status: Some(ResourceQuotaStatus {
                hard: Some([("requests.storage".to_string(), Quantity(hard.to_string()))].into()),
                used: Some([("requests.storage".to_string(), Quantity(used.to_string()))].into()),
            }),
            ..ResourceQuota::default()
        }
    }

    #[test]
    fn the_tightest_quota_decides_the_room() {
        let gib = 1024f64.powi(3);
        assert_eq!(
            storage_room(&[quota("100Gi", "10Gi"), quota("50Gi", "45Gi")]),
            Some(5.0 * gib)
        );
    }

    #[test]
    fn no_storage_quota_is_no_limit() {
        assert_eq!(storage_room(&[]), None);
        let cpu_only = ResourceQuota {
            status: Some(ResourceQuotaStatus {
                hard: Some([("requests.cpu".to_string(), Quantity("4".to_string()))].into()),
                used: None,
            }),
            ..ResourceQuota::default()
        };
        assert_eq!(storage_room(&[cpu_only]), None);
    }

    #[test]
    fn kubernetes_own_namespaces_are_left_alone() {
        assert!(is_system("kube-system"));
        assert!(!is_system("cc-office"));
    }
}
