//! @file
//! The other operators' resources Cirrus writes, and how it writes
//! everything.
//!
//! CloudNativePG, SeaweedFS, RabbitMQ's topology operator and the
//! Gateway API each have Rust types somewhere, at versions that never
//! line up with each other or with kube-rs. Cirrus only ever writes a
//! handful of fields to each, so it builds them as JSON and sends them
//! as dynamic objects instead of taking on four more dependencies.
//! The shapes are the ones the hand-written manifests in k8s/apps
//! already use, which is what keeps them honest.
//!
//! Everything is written with server-side apply under one field
//! manager, so Cirrus owns exactly the fields it sets and a person or
//! another controller can add others without a fight.

use kube::Client;
use kube::api::{Api, DeleteParams, DynamicObject, Patch, PatchParams, PostParams};
use kube::core::{ApiResource, GroupVersionKind};
use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

pub const FIELD_MANAGER: &str = "cirrus";

/// A kind from another project, by group, version, kind and plural.
#[derive(Clone, Copy, Debug)]
pub struct Kind {
    pub group: &'static str,
    pub version: &'static str,
    pub kind: &'static str,
    pub plural: &'static str,
    /// Which service it belongs to, for the message when its CRD
    /// isn't installed.
    pub service: &'static str,
}

impl Kind {
    pub fn api_resource(&self) -> ApiResource {
        ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(self.group, self.version, self.kind), self.plural)
    }

    pub fn api_version(&self) -> String {
        format!("{}/{}", self.group, self.version)
    }

    pub fn api(&self, client: &Client, namespace: &str) -> Api<DynamicObject> {
        Api::namespaced_with(client.clone(), namespace, &self.api_resource())
    }
}

pub const POSTGRES_CLUSTER: Kind = Kind {
    group: "postgresql.cnpg.io",
    version: "v1",
    kind: "Cluster",
    plural: "clusters",
    service: "CloudNativePG",
};
pub const DATABASE: Kind = Kind {
    group: "postgresql.cnpg.io",
    version: "v1",
    kind: "Database",
    plural: "databases",
    service: "CloudNativePG",
};
pub const DATABASE_ROLE: Kind = Kind {
    group: "postgresql.cnpg.io",
    version: "v1",
    kind: "DatabaseRole",
    plural: "databaseroles",
    service: "CloudNativePG",
};
pub const S3_IDENTITY: Kind = Kind {
    group: "seaweed.seaweedfs.com",
    version: "v1",
    kind: "S3Identity",
    plural: "s3identities",
    service: "the SeaweedFS operator",
};
pub const S3_CREDENTIALS: Kind = Kind {
    group: "seaweed.seaweedfs.com",
    version: "v1",
    kind: "S3Credentials",
    plural: "s3credentials",
    service: "the SeaweedFS operator",
};
pub const BUCKET: Kind = Kind {
    group: "seaweed.seaweedfs.com",
    version: "v1",
    kind: "Bucket",
    plural: "buckets",
    service: "the SeaweedFS operator",
};
pub const VHOST: Kind = Kind {
    group: "rabbitmq.com",
    version: "v1beta1",
    kind: "Vhost",
    plural: "vhosts",
    service: "the RabbitMQ topology operator",
};
pub const RABBITMQ_USER: Kind = Kind {
    group: "rabbitmq.com",
    version: "v1beta1",
    kind: "User",
    plural: "users",
    service: "the RabbitMQ topology operator",
};
pub const PERMISSION: Kind = Kind {
    group: "rabbitmq.com",
    version: "v1beta1",
    kind: "Permission",
    plural: "permissions",
    service: "the RabbitMQ topology operator",
};
pub const LISTENER_SET: Kind = Kind {
    group: "gateway.networking.k8s.io",
    version: "v1",
    kind: "ListenerSet",
    plural: "listenersets",
    service: "the Gateway API",
};
pub const HTTP_ROUTE: Kind = Kind {
    group: "gateway.networking.k8s.io",
    version: "v1",
    kind: "HTTPRoute",
    plural: "httproutes",
    service: "the Gateway API",
};

/// Apply a dynamic object built as JSON. The object has to carry its
/// own apiVersion, kind, name and namespace.
pub async fn apply_dynamic(client: &Client, kind: &Kind, object: Value) -> Result<DynamicObject> {
    let name = object["metadata"]["name"].as_str().unwrap_or_default().to_string();
    let namespace = object["metadata"]["namespace"].as_str().unwrap_or_default().to_string();
    let api = kind.api(client, &namespace);
    api.patch(
        &name,
        &PatchParams::apply(FIELD_MANAGER).force(),
        &Patch::Apply(&object),
    )
    .await
    .map_err(|error| missing_kind(kind, error))
}

/// Create a dynamic object unless one by its name is already there,
/// and return whichever is. For what Cirrus starts off and a person
/// then looks after, where applying over their changes would undo
/// them.
pub async fn create_dynamic_if_missing(client: &Client, kind: &Kind, object: Value) -> Result<DynamicObject> {
    let name = object["metadata"]["name"].as_str().unwrap_or_default().to_string();
    let namespace = object["metadata"]["namespace"].as_str().unwrap_or_default().to_string();
    let api = kind.api(client, &namespace);
    if let Some(existing) = api.get_opt(&name).await.map_err(|error| missing_kind(kind, error))? {
        return Ok(existing);
    }
    let created: DynamicObject = serde_json::from_value(object).map_err(|error| Error::Config(error.to_string()))?;
    match api.create(&PostParams::default(), &created).await {
        Ok(made) => Ok(made),
        // Another application in the namespace got there first
        Err(kube::Error::Api(response)) if response.code == 409 => Ok(api.get(&name).await?),
        Err(error) => Err(missing_kind(kind, error)),
    }
}

/// Apply a typed object.
pub async fn apply<K>(api: &Api<K>, name: &str, object: &K) -> Result<K>
where
    K: Clone + Serialize + serde::de::DeserializeOwned + std::fmt::Debug,
{
    Ok(api
        .patch(name, &PatchParams::apply(FIELD_MANAGER).force(), &Patch::Apply(object))
        .await?)
}

/// Delete a dynamic object, treating "already gone" and "never could
/// have existed" as done.
pub async fn delete_dynamic(client: &Client, kind: &Kind, namespace: &str, name: &str) -> Result<()> {
    match kind.api(client, namespace).delete(name, &DeleteParams::default()).await {
        Ok(_) => Ok(()),
        Err(error) if is_not_found(&error) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn is_not_found(error: &kube::Error) -> bool {
    matches!(error, kube::Error::Api(response) if response.code == 404)
}

// A 404 on a write means the resource type doesn't exist: the service
// that would carry it out isn't installed. That's worth a sentence a
// person can act on rather than an HTTP status.
fn missing_kind(kind: &Kind, error: kube::Error) -> Error {
    if is_not_found(&error) {
        Error::MissingService(format!(
            "{} isn't installed: the cluster has no {} resource ({}).",
            kind.service,
            kind.kind,
            kind.api_version()
        ))
    } else {
        error.into()
    }
}
