//! @file
//! The ServiceOffering resource: a service saying what it is and how to
//! reach it, so applications can connect to it by name.
//!
//! An offering points at a Service in its own namespace, says what it
//! does in words, and what kind of thing it is (http, postgres, redis
//! and so on). Cirrus works out where it's reached (host, port and a
//! URL) and writes them to the offering's status. A WebApplication's
//! `connections` then pick offerings, and get environment variables
//! named for the connection: SEARCH_HOST, SEARCH_PORT, SEARCH_URL,
//! after the pattern Radius uses for the same thing.
//!
//! Namespaces are tenants, so an offering is usable from its own
//! namespace and from those it names in `shareWith`, and nowhere else.
//! Credentials go further only within the namespace: a pod can only
//! read Secrets in its own, so a connection from elsewhere gets the
//! address and not the keys to it.
//!
//! Each offering also gets a binding Secret, `<name>-binding`, with
//! the Service Binding Specification's well-known entries (type,
//! provider, host, port, uri, and whatever's in `secret`), named in
//! `status.binding` as the specification's "provisioned service" does.
//! Cirrus reads credentials from it for its own consumers, and any
//! implementation of that specification could bind to it too.

pub mod controller;

use std::collections::BTreeMap;

use k8s_openapi::apimachinery::pkg::apis::meta::v1::Condition;
use kube::CustomResource;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A service, what it does, and who may connect to it.
#[derive(CustomResource, Deserialize, Serialize, Clone, Debug, Default, JsonSchema, PartialEq)]
#[kube(
    group = "community-cloud.technology",
    version = "v1alpha1",
    kind = "ServiceOffering",
    plural = "serviceofferings",
    shortname = "offering",
    namespaced,
    status = "ServiceOfferingStatus",
    printcolumn = r#"{"name":"Title","type":"string","jsonPath":".spec.title"}"#,
    printcolumn = r#"{"name":"Protocol","type":"string","jsonPath":".spec.protocol"}"#,
    printcolumn = r#"{"name":"URL","type":"string","jsonPath":".status.uri"}"#,
    printcolumn = r#"{"name":"Ready","type":"string","jsonPath":".status.conditions[?(@.type==\"Ready\")].status"}"#,
    printcolumn = r#"{"name":"Age","type":"date","jsonPath":".metadata.creationTimestamp"}"#
)]
#[serde(rename_all = "camelCase")]
pub struct ServiceOfferingSpec {
    /// What it is, in a few words: "Product search".
    pub title: String,

    /// What it does and how to use it, for whoever's choosing what to
    /// connect to.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,

    /// What kind of service it is, which decides the URL's scheme.
    #[serde(default)]
    pub protocol: Protocol,

    /// The Service in this namespace that serves it.
    pub service: ServiceTarget,

    /// Added to the URL: an HTTP path prefix, a Postgres database
    /// ("/shop"), an AMQP vhost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,

    /// Other namespaces whose applications may connect. Its own
    /// namespace always may.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub share_with: Vec<String>,

    /// A Secret in this namespace whose keys are handed to connections
    /// from this namespace: username and password, say, become
    /// <NAME>_USERNAME and <NAME>_PASSWORD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,

    /// More that every connection is given, by name: {"region": "sea"}
    /// becomes <NAME>_REGION.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub values: BTreeMap<String, String>,
}

/// The Service an offering is, and which of its ports.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTarget {
    pub name: String,
    /// A port's name or number. Left out, the Service's only port, or
    /// the one named http.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
}

/// What kind of service an offering is.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Http,
    Https,
    Grpc,
    Postgres,
    Mysql,
    Redis,
    Amqp,
    Tcp,
}

impl Protocol {
    /// What it's called in the resource, and in <NAME>_TYPE.
    pub fn name(self) -> &'static str {
        match self {
            Protocol::Http => "http",
            Protocol::Https => "https",
            Protocol::Grpc => "grpc",
            Protocol::Postgres => "postgres",
            Protocol::Mysql => "mysql",
            Protocol::Redis => "redis",
            Protocol::Amqp => "amqp",
            Protocol::Tcp => "tcp",
        }
    }

    /// The scheme its URLs start with: what clients for it expect.
    pub fn scheme(self) -> &'static str {
        match self {
            Protocol::Postgres => "postgresql",
            other => other.name(),
        }
    }
}

/// Where an offering is reached, and who's connected to it.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceOfferingStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_generation: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conditions: Vec<Condition>,
    /// The Service's name inside the cluster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<i32>,
    /// host and port as a URL of the protocol's scheme, with the path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    /// The binding Secret, as the Service Binding Specification's
    /// provisioned services name it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<BindingRef>,
    /// The applications connected to it, from any namespace.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consumers: Vec<ConsumerRef>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema, PartialEq)]
pub struct BindingRef {
    pub name: String,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema, PartialEq, Eq, PartialOrd, Ord)]
pub struct ConsumerRef {
    pub namespace: String,
    pub name: String,
    /// Whether it may connect: false for one in a namespace the
    /// offering isn't shared with.
    pub allowed: bool,
}

/// The binding Secret for an offering.
pub fn binding_name(offering: &str) -> String {
    format!("{offering}-binding")
}

/// The name a Service has inside the cluster.
pub fn host(service: &str, namespace: &str) -> String {
    format!("{service}.{namespace}.svc.cluster.local")
}

/// An offering's URL, from where it's reached.
pub fn uri(protocol: Protocol, host: &str, port: i32, path: Option<&str>) -> String {
    let path = path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| {
            if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            }
        })
        .unwrap_or_default();
    format!("{}://{host}:{port}{path}", protocol.scheme())
}

/// Whether an application in `namespace` may connect to an offering.
pub fn may_connect(offering_namespace: &str, share_with: &[String], namespace: &str) -> bool {
    offering_namespace == namespace || share_with.iter().any(|shared| shared == namespace)
}

/// A connection's name as the start of environment variables: upper
/// case, with anything but letters and digits as underscores.
pub fn env_prefix(name: &str) -> String {
    let mut prefix: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    if prefix.starts_with(|c: char| c.is_ascii_digit()) {
        prefix.insert(0, '_');
    }
    prefix
}

// The binding entries Cirrus writes itself, which a key of the same
// name in `secret` or `values` can't replace
pub const RESERVED_ENTRIES: [&str; 5] = ["type", "provider", "host", "port", "uri"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_use_the_scheme_clients_expect() {
        let host = host("search", "catalogue");
        assert_eq!(host, "search.catalogue.svc.cluster.local");
        assert_eq!(
            uri(Protocol::Http, &host, 8080, None),
            "http://search.catalogue.svc.cluster.local:8080"
        );
        assert_eq!(
            uri(Protocol::Postgres, "db", 5432, Some("shop")),
            "postgresql://db:5432/shop"
        );
        assert_eq!(uri(Protocol::Amqp, "mq", 5672, Some("/team")), "amqp://mq:5672/team");
        assert_eq!(uri(Protocol::Redis, "cache", 6379, Some("  ")), "redis://cache:6379");
    }

    #[test]
    fn its_own_namespace_and_those_it_shares_with_may_connect() {
        let shared = vec!["shop".to_string()];
        assert!(may_connect("catalogue", &shared, "catalogue"));
        assert!(may_connect("catalogue", &shared, "shop"));
        assert!(!may_connect("catalogue", &shared, "elsewhere"));
        assert!(!may_connect("catalogue", &[], "shop"));
    }

    #[test]
    fn connection_names_become_environment_prefixes() {
        assert_eq!(env_prefix("search"), "SEARCH");
        assert_eq!(env_prefix("product-search.v2"), "PRODUCT_SEARCH_V2");
        assert_eq!(env_prefix("3d"), "_3D");
    }

    #[test]
    fn the_protocol_is_http_unless_said() {
        let spec: ServiceOfferingSpec = serde_json::from_value(serde_json::json!({
            "title": "Search",
            "service": {"name": "search"},
        }))
        .unwrap();
        assert_eq!(spec.protocol, Protocol::Http);
        assert_eq!(spec.service.port, None);
    }
}
