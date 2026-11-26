//! @file
//! What Cirrus can give an application in each namespace, written down
//! where whoever is making one can read it.
//!
//! Installs differ: one cluster has RabbitMQ and another doesn't, a
//! namespace may or may not be let in to the Gateway or SeaweedFS, and
//! a storage type exists only if its StorageClass does. Cirrus is what
//! finds out, one application at a time, when provisioning fails. This
//! finds out first, for every namespace, and keeps the answer in a
//! ConfigMap there, `cirrus-capabilities`, as JSON under
//! `capabilities.json`:
//!
//! - services: postgres, rabbitmq and bucket, each available or not,
//!   and why not
//! - storage: each storage type, and whether its StorageClass is there
//! - ingress: whether an application here can have public hostnames
//! - egress: whether any network policy limits what it can reach
//! - offerings: the ServiceOfferings it may connect to, its own and
//!   those shared with it
//! - shared: the values the namespace shares with its applications
//!   (spec.shared), plain ones with their values and secret ones by
//!   name alone, never what they are
//!
//! Anyone with view in the namespace may read that ConfigMap, and so
//! may an agent's token (cirrus-webapplications-edit grants `get` on
//! that one name), without being able to read anything else about the
//! cluster. Meteorologist's MCP tools read it to say what an
//! application can ask for, and to refuse what it can't
//! (ui/meteorologist/src/lib/mcp/capabilities.ts).
//!
//! The deciding is here, apart from the reading in ./controller.rs, so
//! it can be tested without a cluster.

pub mod controller;

use serde::{Deserialize, Serialize};

use crate::crd::StorageType;
// The labels a namespace is let in with, as the reconcilers check them
use crate::reconcile::bucket::BUCKETS_LABEL;
use crate::reconcile::network::{GATEWAY_LABEL, GATEWAY_LABEL_VALUE};
use crate::reconcile::volumes::bytes;

pub const CONFIG_MAP: &str = "cirrus-capabilities";
pub const KEY: &str = "capabilities.json";
// Bumped when the shape changes in a way a reader has to know about
pub const VERSION: u32 = 1;

/// Whether something can be had, and why not if it can't.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Availability {
    pub fn yes() -> Self {
        Self {
            available: true,
            reason: None,
        }
    }

    /// Available, with something worth knowing about it.
    pub fn yes_but(note: impl Into<String>) -> Self {
        Self {
            available: true,
            reason: Some(note.into()),
        }
    }

    pub fn no(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Services {
    pub postgres: Availability,
    pub rabbitmq: Availability,
    pub bucket: Availability,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    #[serde(rename = "type")]
    pub storage_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_class: Option<String>,
    pub available: bool,
}

/// What may limit where an application's traffic can go.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Egress {
    /// Whether any policy in the namespace limits egress. Cluster-wide
    /// policies are listed apart, since whether they select this
    /// namespace's pods isn't worked out here.
    pub restricted: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub policies: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cluster_policies: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Offering {
    pub name: String,
    pub namespace: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub protocol: String,
    pub ready: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub version: u32,
    pub namespace: String,
    pub services: Services,
    pub storage: Vec<Storage>,
    pub ingress: Availability,
    pub egress: Egress,
    pub offerings: Vec<Offering>,
    #[serde(default)]
    pub shared: Vec<SharedValue>,
}

/// One of the namespace's shared values: a plain one's value, a secret
/// one's name alone.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedValue {
    pub name: String,
    /// "plain" or "secret"
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// What's known about a namespace and the cluster, as read.
#[derive(Clone, Debug, Default)]
pub struct Facts {
    pub namespace: String,
    /// Whether each kind's CRD is installed
    pub postgres_installed: bool,
    pub rabbitmq_topology_installed: bool,
    pub buckets_installed: bool,
    /// Whether the shared RabbitmqCluster is there, and what it's called
    pub rabbitmq_cluster_present: bool,
    pub rabbitmq_cluster_name: String,
    pub rabbitmq_namespace: String,
    /// Whether the namespace's Postgres has been started already
    pub postgres_running: bool,
    pub postgres_storage: String,
    /// The room left under the namespace's storage quotas, in bytes,
    /// or nothing when no quota limits storage
    pub storage_room: Option<f64>,
    pub gateway_label: bool,
    pub buckets_label: bool,
    pub storage_classes: Vec<String>,
    pub egress_policies: Vec<String>,
    pub cluster_egress_policies: Vec<String>,
    pub offerings: Vec<Offering>,
    /// The namespace's shared plain values, and its secret ones' names
    pub shared_plain: std::collections::BTreeMap<String, String>,
    pub shared_secret: Vec<String>,
}

/// What a namespace can have, from what was read.
pub fn decide(facts: &Facts) -> Capabilities {
    let postgres = if !facts.postgres_installed {
        Availability::no("CloudNativePG isn't installed in this cluster.")
    } else if facts.postgres_running {
        Availability::yes()
    } else {
        let needed = bytes(&facts.postgres_storage).unwrap_or(0.0);
        match facts.storage_room {
            Some(room) if room < needed => Availability::no(format!(
                "The first database here starts the namespace's Postgres with a {} volume, and the storage quota doesn't have room for it.",
                facts.postgres_storage
            )),
            _ => Availability::yes_but(format!(
                "The first database here starts the namespace's Postgres, with a {} volume.",
                facts.postgres_storage
            )),
        }
    };

    let rabbitmq = if !facts.rabbitmq_topology_installed {
        Availability::no("RabbitMQ's topology operator isn't installed in this cluster.")
    } else if !facts.rabbitmq_cluster_present {
        Availability::no(format!(
            "There's no RabbitMQ cluster {} in {} for vhosts to go on.",
            facts.rabbitmq_cluster_name, facts.rabbitmq_namespace
        ))
    } else {
        Availability::yes()
    };

    let bucket = if !facts.buckets_installed {
        Availability::no("The SeaweedFS operator isn't installed in this cluster.")
    } else if !facts.buckets_label {
        Availability::no(format!(
            "This namespace can't have buckets until a person gives it the label {BUCKETS_LABEL}=\"true\" (the Buckets capability in Meteorologist)."
        ))
    } else {
        Availability::yes()
    };

    let storage = [StorageType::Fast, StorageType::Sata, StorageType::Hdd, StorageType::Ram]
        .into_iter()
        .map(|kind| Storage {
            storage_type: kind.name().to_string(),
            storage_class: kind.storage_class().map(str::to_string),
            available: kind
                .storage_class()
                .is_none_or(|class| facts.storage_classes.iter().any(|each| each == class)),
        })
        .collect();

    let ingress = if facts.gateway_label {
        Availability::yes_but("A person gives an application its hostnames, in Meteorologist.")
    } else {
        Availability::no(format!(
            "Applications here are only reachable inside the cluster: the Gateway takes listeners only from namespaces with the label {GATEWAY_LABEL}=\"{GATEWAY_LABEL_VALUE}\"."
        ))
    };

    let mut offerings = facts.offerings.clone();
    offerings.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));

    Capabilities {
        version: VERSION,
        namespace: facts.namespace.clone(),
        services: Services {
            postgres,
            rabbitmq,
            bucket,
        },
        storage,
        ingress,
        egress: Egress {
            restricted: !facts.egress_policies.is_empty(),
            policies: facts.egress_policies.clone(),
            cluster_policies: facts.cluster_egress_policies.clone(),
        },
        offerings,
        shared: facts
            .shared_plain
            .iter()
            .map(|(name, value)| SharedValue {
                name: name.clone(),
                kind: "plain".to_string(),
                value: Some(value.clone()),
            })
            .chain(facts.shared_secret.iter().map(|name| SharedValue {
                name: name.clone(),
                kind: "secret".to_string(),
                value: None,
            }))
            .collect(),
    }
}

/// Whether a NetworkPolicy limits egress: it names Egress among its
/// policy types, or has egress rules, which imply it.
pub fn network_policy_limits_egress(policy: &serde_json::Value) -> bool {
    let spec = &policy["spec"];
    spec["policyTypes"]
        .as_array()
        .is_some_and(|types| types.iter().any(|each| each == "Egress"))
        || spec.get("egress").is_some()
}

/// Whether a Cilium policy limits egress: a spec, or any of its specs,
/// with egress or egressDeny rules. Selecting endpoints for egress at
/// all puts them in default deny for it.
pub fn cilium_policy_limits_egress(policy: &serde_json::Value) -> bool {
    let limits = |spec: &serde_json::Value| spec.get("egress").is_some() || spec.get("egressDeny").is_some();
    limits(&policy["spec"]) || policy["specs"].as_array().is_some_and(|specs| specs.iter().any(limits))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn everything() -> Facts {
        Facts {
            namespace: "team-shop".to_string(),
            postgres_installed: true,
            rabbitmq_topology_installed: true,
            buckets_installed: true,
            rabbitmq_cluster_present: true,
            rabbitmq_cluster_name: "rabbitmq".to_string(),
            rabbitmq_namespace: "cc-office".to_string(),
            postgres_running: true,
            postgres_storage: "20Gi".to_string(),
            storage_room: None,
            gateway_label: true,
            buckets_label: true,
            storage_classes: vec!["cc-local-ssd-fast".to_string()],
            ..Facts::default()
        }
    }

    #[test]
    fn everything_installed_and_allowed_is_available() {
        let capabilities = decide(&everything());
        assert!(capabilities.services.postgres.available);
        assert!(capabilities.services.rabbitmq.available);
        assert!(capabilities.services.bucket.available);
        assert!(capabilities.ingress.available);
        assert!(!capabilities.egress.restricted);
    }

    #[test]
    fn a_service_not_installed_says_so() {
        let facts = Facts {
            rabbitmq_topology_installed: false,
            ..everything()
        };
        let rabbitmq = decide(&facts).services.rabbitmq;
        assert!(!rabbitmq.available);
        assert!(rabbitmq.reason.unwrap().contains("isn't installed"));
    }

    #[test]
    fn rabbitmq_needs_its_cluster_too() {
        let facts = Facts {
            rabbitmq_cluster_present: false,
            ..everything()
        };
        assert!(!decide(&facts).services.rabbitmq.available);
    }

    #[test]
    fn buckets_need_the_namespace_label() {
        let facts = Facts {
            buckets_label: false,
            ..everything()
        };
        assert!(decide(&facts).services.bucket.reason.unwrap().contains(BUCKETS_LABEL));
    }

    #[test]
    fn the_first_database_needs_room_for_postgres() {
        let tight = Facts {
            postgres_running: false,
            storage_room: Some(10.0 * 1024f64.powi(3)),
            ..everything()
        };
        assert!(!decide(&tight).services.postgres.available);

        let roomy = Facts {
            storage_room: Some(50.0 * 1024f64.powi(3)),
            ..tight.clone()
        };
        assert!(decide(&roomy).services.postgres.available);

        // Once it's running, a database is only a database
        let running = Facts {
            postgres_running: true,
            ..tight
        };
        assert!(decide(&running).services.postgres.available);
    }

    #[test]
    fn a_storage_type_needs_its_class_and_ram_needs_nothing() {
        let storage = decide(&everything()).storage;
        let available = |name: &str| storage.iter().find(|each| each.storage_type == name).unwrap().available;
        assert!(available("fast"));
        assert!(!available("hdd"));
        assert!(available("ram"));
    }

    #[test]
    fn without_the_gateway_label_it_stays_inside() {
        let facts = Facts {
            gateway_label: false,
            ..everything()
        };
        assert!(!decide(&facts).ingress.available);
    }

    #[test]
    fn a_policy_with_egress_restricts_it() {
        let facts = Facts {
            egress_policies: vec!["NetworkPolicy/deny-out".to_string()],
            ..everything()
        };
        assert!(decide(&facts).egress.restricted);
    }

    #[test]
    fn which_policies_limit_egress() {
        assert!(network_policy_limits_egress(
            &json!({"spec": {"policyTypes": ["Ingress", "Egress"]}})
        ));
        assert!(!network_policy_limits_egress(&json!({"spec": {"ingress": []}})));
        assert!(cilium_policy_limits_egress(&json!({"spec": {"egressDeny": [{}]}})));
        assert!(cilium_policy_limits_egress(
            &json!({"specs": [{"ingress": []}, {"egress": []}]})
        ));
        assert!(!cilium_policy_limits_egress(&json!({"spec": {"ingress": [{}]}})));
    }

    #[test]
    fn shared_values_show_plain_ones_and_only_the_names_of_secret_ones() {
        let facts = Facts {
            shared_plain: [("SMTP_HOST".to_string(), "smtp.example.org".to_string())].into(),
            shared_secret: vec!["SENDGRID".to_string()],
            ..everything()
        };
        let json = serde_json::to_value(decide(&facts)).unwrap();
        assert_eq!(
            json["shared"],
            json!([
                {"name": "SMTP_HOST", "kind": "plain", "value": "smtp.example.org"},
                {"name": "SENDGRID", "kind": "secret"}
            ])
        );
    }

    #[test]
    fn it_reads_as_camel_case_json() {
        let json = serde_json::to_value(decide(&everything())).unwrap();
        assert_eq!(json["storage"][0]["storageClass"], "cc-local-ssd-fast");
        assert_eq!(json["storage"][0]["type"], "fast");
        assert_eq!(json["services"]["postgres"], json!({"available": true}));
    }
}
