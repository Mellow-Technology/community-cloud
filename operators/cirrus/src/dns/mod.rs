//! @file
//! The DnsProvider resource: one DNS provider account, the domains it
//! holds, and the namespaces whose hostnames it publishes.
//!
//! The installer can already run ExternalDNS, from the dns section of
//! its configuration (installer/src/util/dns.ts explains the design).
//! That suits the cluster's own domains, which change when the cluster
//! does. A namespace given to a team or a client is different: their
//! domain comes and goes with them, and editing the installer's
//! configuration and re-running a bundle for that is a lot of ceremony.
//! A DnsProvider is the same thing as one entry of that section, kept in
//! the cluster instead, so it can be made from Meteorologist.
//!
//! Each one is run the way the installer runs its entries: one
//! ExternalDNS per namespace, told to read only that namespace's routes
//! and write only the provider's domains, with the account's
//! credentials kept beside it in a namespace nobody's applications run
//! in. A route naming a domain its namespace wasn't given is ignored,
//! because nothing reading that namespace may write there.
//!
//! The resource is cluster-scoped on purpose. Which namespace may write
//! which domain is a decision about the whole cluster, and a namespace
//! able to make one could hand itself someone else's domain.

pub mod conflicts;
pub mod controller;
pub mod instance;

use k8s_openapi::apimachinery::pkg::apis::meta::v1::Condition;
use kube::CustomResource;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A DNS provider account, and who may publish through it.
#[derive(CustomResource, Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[kube(
    group = "community-cloud.technology",
    version = "v1alpha1",
    kind = "DnsProvider",
    plural = "dnsproviders",
    shortname = "dnsp",
    status = "DnsProviderStatus",
    printcolumn = r#"{"name":"Provider","type":"string","jsonPath":".spec.provider"}"#,
    printcolumn = r#"{"name":"Domains","type":"string","jsonPath":".spec.domains"}"#,
    printcolumn = r#"{"name":"Ready","type":"string","jsonPath":".status.conditions[?(@.type==\"Ready\")].status"}"#,
    printcolumn = r#"{"name":"Age","type":"date","jsonPath":".metadata.creationTimestamp"}"#
)]
#[serde(rename_all = "camelCase")]
pub struct DnsProviderSpec {
    /// The ExternalDNS provider: cloudflare, aws, google, digitalocean,
    /// rfc2136 and so on.
    pub provider: String,

    /// The domains its instances may write. A record outside them is
    /// never touched.
    pub domains: Vec<String>,

    /// Parts of those domains that belong to someone else, typically a
    /// subdomain given to another provider.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude_domains: Vec<String>,

    /// The namespaces whose routes are published, one ExternalDNS each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub namespaces: Vec<String>,

    /// A Secret in Cirrus's DNS namespace (external-dns, unless set
    /// otherwise) whose every key is given to ExternalDNS as an
    /// environment variable: CF_API_TOKEN for Cloudflare, say.
    /// "cirrus-dns-<name>" when left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials_secret: Option<String>,

    /// What the records point at, when the Gateway's own address isn't
    /// what the world reaches it by: behind a router forwarding ports,
    /// the router's public address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,

    /// "sync", the default, removes a record when its route goes;
    /// "upsert-only" never removes anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<String>,

    /// Further ExternalDNS flags, for provider settings like
    /// "--cloudflare-proxied".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
}

/// What Cirrus has made of a DnsProvider.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DnsProviderStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_generation: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conditions: Vec<Condition>,
    /// The ExternalDNS running for each namespace.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instances: Vec<DnsInstanceStatus>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DnsInstanceStatus {
    pub namespace: String,
    pub deployment: String,
    pub ready: bool,
}

// The policies ExternalDNS has
pub const POLICIES: [&str; 2] = ["sync", "upsert-only"];

impl DnsProvider {
    /// The Secret holding the account's credentials.
    pub fn credentials_secret(&self) -> String {
        use kube::ResourceExt;
        self.spec
            .credentials_secret
            .clone()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("cirrus-dns-{}", self.name_any()))
    }

    pub fn policy(&self) -> &str {
        self.spec
            .policy
            .as_deref()
            .filter(|policy| !policy.is_empty())
            .unwrap_or("sync")
    }

    /// What's wrong with the spec on its own, as sentences.
    pub fn problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        if self.spec.provider.trim().is_empty() {
            problems.push("it doesn't say which provider it is: cloudflare, aws, google and so on".to_string());
        }
        if self.spec.domains.iter().all(|domain| domain.trim().is_empty()) {
            problems.push(
                "it has no domains, and without them it could write records in any zone its credentials reach"
                    .to_string(),
            );
        }
        if !POLICIES.contains(&self.policy()) {
            problems.push(format!(
                "its policy is \"{}\", where ExternalDNS has sync and upsert-only",
                self.policy()
            ));
        }
        problems
    }
}
