//! @file
//! Where the cluster's shared services are, and how Cirrus is reached.
//!
//! The defaults are the names the installer gives everything
//! (k8s/apps/office, k8s/storage/SeaweedFS), so on a cluster the
//! installer built nothing needs setting. They're read from the
//! environment anyway, because a cluster assembled by hand may have
//! named them otherwise, and because tests need somewhere to point.

use std::env;

#[derive(Clone, Debug)]
pub struct Settings {
    /// The address Cirrus's webhooks are reached on from outside,
    /// e.g. https://cirrus.example.com. Without it no webhook is
    /// registered, and new images are only found by polling.
    pub webhook_base_url: Option<String>,
    pub listen_address: String,

    /// Where the shared RabbitMQ lives. Its resources have to be made
    /// beside it.
    pub services_namespace: String,
    pub rabbitmq_cluster: String,

    /// The Postgres each namespace gets, as first made. Only a new one
    /// is made from these; an existing one is left as it is.
    pub postgres_cluster: String,
    pub postgres_instances: u32,
    pub postgres_storage_size: String,
    pub postgres_storage_class: String,
    /// CloudNativePG's own default when unset
    pub postgres_image: Option<String>,

    pub seaweed_name: String,
    pub seaweed_namespace: String,
    pub s3_endpoint: String,

    pub gateway_name: String,
    pub gateway_namespace: String,
    pub cluster_issuer: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            webhook_base_url: None,
            listen_address: "0.0.0.0:8080".to_string(),
            services_namespace: "cc-office".to_string(),
            rabbitmq_cluster: "rabbitmq".to_string(),
            // Named for its maker, so it can't be mistaken for, or take
            // over, a Cluster someone made in the namespace themselves
            postgres_cluster: "cirrus-postgres".to_string(),
            // As cc-postgres: one instance until the cluster has the
            // nodes for more
            postgres_instances: 1,
            postgres_storage_size: "20Gi".to_string(),
            postgres_storage_class: "cc-local-ssd-fast".to_string(),
            postgres_image: None,
            seaweed_name: "seaweed".to_string(),
            seaweed_namespace: "seaweedfs".to_string(),
            s3_endpoint: "http://seaweed-s3.seaweedfs.svc:8333".to_string(),
            gateway_name: "cc-letsencrypt-web-gateway".to_string(),
            gateway_namespace: "community-cloud".to_string(),
            cluster_issuer: "cc-lets-encrypt".to_string(),
        }
    }
}

impl Settings {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let read = |name: &str, default: String| env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or(default);
        Self {
            webhook_base_url: env::var("CIRRUS_WEBHOOK_BASE_URL")
                .ok()
                .filter(|v| !v.is_empty())
                .map(|v| v.trim_end_matches('/').to_string()),
            listen_address: read("CIRRUS_LISTEN_ADDRESS", defaults.listen_address),
            services_namespace: read("CIRRUS_SERVICES_NAMESPACE", defaults.services_namespace),
            rabbitmq_cluster: read("CIRRUS_RABBITMQ_CLUSTER", defaults.rabbitmq_cluster),
            postgres_cluster: read("CIRRUS_POSTGRES_CLUSTER", defaults.postgres_cluster),
            postgres_instances: env::var("CIRRUS_POSTGRES_INSTANCES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(defaults.postgres_instances),
            postgres_storage_size: read("CIRRUS_POSTGRES_STORAGE_SIZE", defaults.postgres_storage_size),
            postgres_storage_class: read("CIRRUS_POSTGRES_STORAGE_CLASS", defaults.postgres_storage_class),
            postgres_image: env::var("CIRRUS_POSTGRES_IMAGE").ok().filter(|v| !v.is_empty()),
            seaweed_name: read("CIRRUS_SEAWEED_NAME", defaults.seaweed_name),
            seaweed_namespace: read("CIRRUS_SEAWEED_NAMESPACE", defaults.seaweed_namespace),
            s3_endpoint: read("CIRRUS_S3_ENDPOINT", defaults.s3_endpoint),
            gateway_name: read("CIRRUS_GATEWAY_NAME", defaults.gateway_name),
            gateway_namespace: read("CIRRUS_GATEWAY_NAMESPACE", defaults.gateway_namespace),
            cluster_issuer: read("CIRRUS_CLUSTER_ISSUER", defaults.cluster_issuer),
        }
    }

    pub fn postgres_host(&self, namespace: &str) -> String {
        // CloudNativePG's read-write Service
        format!("{}-rw.{namespace}.svc", self.postgres_cluster)
    }

    pub fn rabbitmq_host(&self) -> String {
        format!("{}.{}.svc", self.rabbitmq_cluster, self.services_namespace)
    }

    pub fn webhook_url(&self, namespace: &str, name: &str) -> Option<String> {
        self.webhook_base_url
            .as_ref()
            .map(|base| format!("{base}/hooks/gitlab/{namespace}/{name}"))
    }
}
