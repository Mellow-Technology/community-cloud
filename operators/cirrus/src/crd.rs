//! @file
//! The WebApplication resource: one application, and everything it
//! needs to run on Community Cloud.
//!
//! Before Cirrus, an application here was a handful of hand-written
//! manifests that had to agree with each other — a role and database
//! in Postgres, a bucket and keys in SeaweedFS, a vhost in the
//! shared RabbitMQ, a ListenerSet and routes on the cluster Gateway,
//! and a Deployment wired to all of it (k8s/apps/plane is the fullest
//! example). Every one of those was copied from the last application
//! and edited, and a new image meant editing the Deployment again.
//!
//! This resource says what the application needs rather than how to
//! build it. A block being present — `postgres: {}` — is the request;
//! its fields are only for the cases the defaults don't suit. That
//! keeps a typical application to a dozen lines, and leaves the
//! decisions about how each service is shared to Cirrus, where they
//! can change in one place.
//!
//! The version is v1alpha1 on purpose: this is the first shape, and
//! nothing outside this repository depends on it yet.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::{EnvVar, ResourceRequirements};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Condition;
use kube::CustomResource;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// What an application is and what it needs.
#[derive(CustomResource, Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[kube(
    group = "community-cloud.technology",
    version = "v1alpha1",
    kind = "WebApplication",
    plural = "webapplications",
    shortname = "webapp",
    namespaced,
    status = "WebApplicationStatus",
    printcolumn = r#"{"name":"Image","type":"string","jsonPath":".status.deployedImage"}"#,
    printcolumn = r#"{"name":"Ready","type":"string","jsonPath":".status.conditions[?(@.type==\"Ready\")].status"}"#,
    printcolumn = r#"{"name":"URL","type":"string","jsonPath":".status.url"}"#,
    printcolumn = r#"{"name":"Age","type":"date","jsonPath":".metadata.creationTimestamp"}"#
)]
#[serde(rename_all = "camelCase")]
pub struct WebApplicationSpec {
    /// The image to run until a forge publishes a newer one.
    pub image: ImageSpec,

    /// How many copies of the application to run.
    #[serde(default = "default_replicas")]
    pub replicas: i32,

    /// The port the application listens on for HTTP.
    #[serde(default = "default_port")]
    pub port: i32,

    /// Environment variables, added after the ones Cirrus provides,
    /// so one set here wins.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<EnvVar>,

    /// CPU and memory. Left out, the application gets 256Mi.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<ResourceRequirements>,

    /// Secrets holding credentials for a registry the nodes can't
    /// already pull from.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_pull_secrets: Vec<String>,

    /// A path that answers 2xx once the application can serve. Used
    /// for readiness, so a rollout waits for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_check: Option<HealthCheckSpec>,

    /// Hostnames the application is served on, over HTTPS, through
    /// the cluster Gateway.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hostnames: Vec<String>,

    /// A database of its own in the namespace's Postgres, which
    /// Cirrus makes for the first application asking for one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postgres: Option<PostgresSpec>,

    /// A bucket of its own in the cluster's SeaweedFS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bucket: Option<BucketSpec>,

    /// A vhost of its own in the cluster's shared RabbitMQ.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rabbitmq: Option<RabbitMqSpec>,

    /// A command run to completion, with the new image, before each
    /// rollout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrations: Option<MigrationsSpec>,

    /// Where new images come from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceSpec>,
}

fn default_replicas() -> i32 {
    1
}

fn default_port() -> i32 {
    8080
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageSpec {
    /// The image without its tag, e.g. registry.gitlab.com/group/app.
    pub repository: String,
    /// The tag to start from.
    #[serde(default = "default_tag")]
    pub tag: String,
}

fn default_tag() -> String {
    "latest".to_string()
}

impl ImageSpec {
    /// The image as a reference a container can be given.
    pub fn reference(&self) -> String {
        format!("{}:{}", self.repository, self.tag)
    }
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckSpec {
    pub path: String,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PostgresSpec {}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BucketSpec {
    /// The most the bucket may hold, as a Kubernetes quantity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RabbitMqSpec {}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MigrationsSpec {
    /// Replaces the image's entrypoint.
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// How long the migrations may run before they count as failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<i64>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gitlab: Option<GitLabSource>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitLabSource {
    /// The GitLab instance.
    #[serde(default = "default_gitlab_url")]
    pub url: String,
    /// The project's path, e.g. group/app, or its numeric id.
    pub project: String,
    /// The branch or tag whose successful pipelines are rolled out.
    #[serde(rename = "ref", default = "default_ref")]
    pub git_ref: String,
    /// A Secret in this namespace with an access token for the
    /// project. It needs the api scope and the Maintainer role, to
    /// manage the project's webhook.
    pub token_secret: SecretKeyRef,
    /// The tag a successful pipeline publishes the image under.
    /// "{commit_sha}", "{short_sha}" and "{ref}" are replaced.
    #[serde(default = "default_image_tag")]
    pub image_tag: String,
}

fn default_gitlab_url() -> String {
    "https://gitlab.com".to_string()
}

fn default_ref() -> String {
    "main".to_string()
}

fn default_image_tag() -> String {
    "{commit_sha}".to_string()
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretKeyRef {
    pub name: String,
    #[serde(default = "default_token_key")]
    pub key: String,
}

fn default_token_key() -> String {
    "token".to_string()
}

/// What Cirrus has done, and what it's waiting on.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebApplicationStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_generation: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conditions: Vec<Condition>,
    /// The newest image a forge has published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<Release>,
    /// The image the Deployment runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployed_image: Option<String>,
    /// The migration Job for the image being rolled out, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration_job: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook: Option<WebhookStatus>,
    /// When the forge was last asked for the newest pipeline, as
    /// RFC 3339.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_checked: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub commit: String,
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    /// The repository it was published to, so a release for an image
    /// the spec no longer names is ignored.
    pub repository: String,
}

impl Release {
    /// By digest when the registry gave one, so a tag that moves
    /// can't change what's running.
    pub fn reference(&self) -> String {
        match &self.digest {
            Some(digest) => format!("{}@{}", self.repository, digest),
            None => format!("{}:{}", self.repository, self.tag),
        }
    }
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebhookStatus {
    pub hook_id: u64,
    pub url: String,
}

impl WebApplication {
    /// The image the application should be running: the newest
    /// release for the repository the spec names, or the spec's own.
    pub fn desired_image(&self) -> String {
        let release = self.status.as_ref().and_then(|status| status.release.as_ref());
        match release {
            Some(release) if release.repository == self.spec.image.repository => release.reference(),
            _ => self.spec.image.reference(),
        }
    }

    pub fn gitlab(&self) -> Option<&GitLabSource> {
        self.spec.source.as_ref().and_then(|source| source.gitlab.as_ref())
    }
}

/// Cirrus's CRDs as YAML — WebApplication and DnsProvider, as one
/// file the installer applies — with a note saying where they came
/// from.
pub fn crd_yaml() -> String {
    use kube::CustomResourceExt;
    let application = serde_yaml::to_string(&WebApplication::crd()).expect("the CRD serializes");
    let dns = serde_yaml::to_string(&crate::dns::DnsProvider::crd()).expect("the CRD serializes");
    format!(
        "# Generated by `cargo run --bin crdgen` in operators/cirrus. Edit\n\
         # src/crd.rs and src/dns/mod.rs and regenerate rather than\n\
         # changing this by hand.\n{application}---\n{dns}"
    )
}

/// The labels on everything made for an application. The selector is
/// the name alone, since a Deployment's selector can never change.
pub fn labels(name: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("app.kubernetes.io/name".to_string(), name.to_string()),
        ("app.kubernetes.io/managed-by".to_string(), "cirrus".to_string()),
    ])
}

pub fn selector(name: &str) -> BTreeMap<String, String> {
    BTreeMap::from([("app.kubernetes.io/name".to_string(), name.to_string())])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(release: Option<Release>) -> WebApplication {
        let mut app = WebApplication::new(
            "shop",
            WebApplicationSpec {
                image: ImageSpec {
                    repository: "registry.gitlab.com/acme/shop".into(),
                    tag: "main".into(),
                },
                ..Default::default()
            },
        );
        app.status = Some(WebApplicationStatus {
            release,
            ..Default::default()
        });
        app
    }

    #[test]
    fn spec_image_until_a_release() {
        assert_eq!(app(None).desired_image(), "registry.gitlab.com/acme/shop:main");
    }

    #[test]
    fn release_by_digest() {
        let release = Release {
            commit: "abc".into(),
            tag: "abc".into(),
            digest: Some("sha256:1234".into()),
            repository: "registry.gitlab.com/acme/shop".into(),
        };
        assert_eq!(
            app(Some(release)).desired_image(),
            "registry.gitlab.com/acme/shop@sha256:1234"
        );
    }

    #[test]
    fn release_for_another_repository_is_ignored() {
        let release = Release {
            commit: "abc".into(),
            tag: "abc".into(),
            digest: None,
            repository: "registry.gitlab.com/acme/old".into(),
        };
        assert_eq!(app(Some(release)).desired_image(), "registry.gitlab.com/acme/shop:main");
    }

    #[test]
    fn defaults_fill_in() {
        let spec: WebApplicationSpec =
            serde_json::from_value(serde_json::json!({"image": {"repository": "r"}})).unwrap();
        assert_eq!(spec.replicas, 1);
        assert_eq!(spec.port, 8080);
        assert_eq!(spec.image.tag, "latest");
    }
}
