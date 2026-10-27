//! @file
//! A bucket of its own in the cluster's SeaweedFS, and keys to it and
//! nothing else.
//!
//! The same three requests k8s/apps/plane/Plane.bucket.yaml makes by
//! hand: an S3 user, a key pair for it written into a Secret, and a
//! bucket only that user can reach. Unlike Postgres and RabbitMQ these
//! may live in the application's own namespace — SeaweedFS's operator
//! accepts them from any namespace its ResourceReferenceGrant lets in
//! — so they're owned by the WebApplication and go with it.
//!
//! Deleting the Bucket resource leaves the bucket and its contents:
//! "Retain" is the operator's default, and deliberately not changed
//! here. The user and its keys do go.
//!
//! Names carry the namespace, since S3 users and bucket names are one
//! list for the whole of SeaweedFS.

use k8s_openapi::api::core::v1::{EnvVar, EnvVarSource, Namespace, Secret, SecretKeySelector};
use kube::Api;
use serde_json::{Value, json};

use super::{Context, Outcome, Provided, owner_reference};
use crate::crd::{WebApplication, labels};
use crate::error::{Error, Result};
use crate::naming::shared_name;
use crate::resources::{self, BUCKET, S3_CREDENTIALS, S3_IDENTITY};

// What SeaweedFS's ResourceReferenceGrant selects on, in
// k8s/storage/SeaweedFS/SeaweedFS.yaml. A namespace without it can't
// have buckets, and the operator says so only in its own log.
pub const BUCKETS_LABEL: &str = "storage.community-cloud.technology/buckets";

// SeaweedFS takes any region; SDKs insist on being told one
const REGION: &str = "us-east-1";

pub async fn ensure(ctx: &Context, app: &WebApplication) -> Result<Outcome> {
    let (namespace, name) = super::identity(app);
    let ns = Api::<Namespace>::all(ctx.client.clone()).get(&namespace).await?;
    let allowed = ns
        .metadata
        .labels
        .as_ref()
        .and_then(|labels| labels.get(BUCKETS_LABEL))
        .is_some_and(|value| value == "true");
    if !allowed {
        return Err(Error::NotPermitted(format!(
            "the namespace {namespace} can't have buckets: it needs the label {BUCKETS_LABEL}=\"true\""
        )));
    }

    for (kind, object) in build(app, &ctx.settings) {
        resources::apply_dynamic(&ctx.client, kind, object).await?;
    }

    // The operator writes the keys once the user exists
    let secret_name = format!("{name}-s3");
    let secret = Api::<Secret>::namespaced(ctx.client.clone(), &namespace)
        .get_opt(&secret_name)
        .await?;
    if secret.is_none() {
        return Ok(Outcome::Pending(
            "waiting for SeaweedFS to make the bucket's keys".to_string(),
        ));
    }
    Ok(Outcome::Ready(Provided {
        env_from: vec![],
        env: env(app, &ctx.settings),
    }))
}

/// The identity, credentials and bucket, as the SeaweedFS operator
/// takes them.
pub fn build(app: &WebApplication, settings: &crate::settings::Settings) -> Vec<(&'static resources::Kind, Value)> {
    let (namespace, name) = super::identity(app);
    let shared = shared_name(&namespace, &name);
    let owner = owner_reference(app);
    let metadata = |object_name: &str| {
        json!({
            "name": object_name,
            "namespace": namespace,
            "labels": labels(&name),
            "ownerReferences": [owner],
        })
    };
    let seaweed = json!({ "name": settings.seaweed_name, "namespace": settings.seaweed_namespace });
    let quota = app.spec.bucket.as_ref().and_then(|bucket| bucket.quota.clone());

    let mut bucket_spec = json!({
        "name": shared,
        "clusterRef": seaweed,
        "access": [{ "user": shared, "actions": ["Read", "Write", "List", "Tagging"] }],
    });
    if let Some(quota) = quota {
        bucket_spec["quota"] = json!({ "size": quota });
    }

    vec![
        (
            &S3_IDENTITY,
            json!({
                "apiVersion": S3_IDENTITY.api_version(),
                "kind": S3_IDENTITY.kind,
                "metadata": metadata(&shared),
                "spec": { "seaweedRef": seaweed },
            }),
        ),
        (
            &S3_CREDENTIALS,
            json!({
                "apiVersion": S3_CREDENTIALS.api_version(),
                "kind": S3_CREDENTIALS.kind,
                "metadata": metadata(&shared),
                "spec": {
                    "seaweedRef": seaweed,
                    "identityRef": { "name": shared },
                    "secretRef": { "name": format!("{name}-s3") },
                },
            }),
        ),
        (
            &BUCKET,
            json!({
                "apiVersion": BUCKET.api_version(),
                "kind": BUCKET.kind,
                "metadata": metadata(&shared),
                "spec": bucket_spec,
            }),
        ),
    ]
}

/// The variables AWS's SDKs read on their own, and plainer ones for
/// everything else.
pub fn env(app: &WebApplication, settings: &crate::settings::Settings) -> Vec<EnvVar> {
    let (namespace, name) = super::identity(app);
    let secret = format!("{name}-s3");
    let plain = |key: &str, value: String| EnvVar {
        name: key.to_string(),
        value: Some(value),
        value_from: None,
    };
    let from_secret = |key: &str, secret_key: &str| EnvVar {
        name: key.to_string(),
        value: None,
        value_from: Some(EnvVarSource {
            secret_key_ref: Some(SecretKeySelector {
                name: secret.clone(),
                key: secret_key.to_string(),
                optional: None,
            }),
            ..Default::default()
        }),
    };
    vec![
        plain("S3_ENDPOINT", settings.s3_endpoint.clone()),
        plain("S3_BUCKET", shared_name(&namespace, &name)),
        plain("S3_REGION", REGION.to_string()),
        from_secret("S3_ACCESS_KEY_ID", "accessKey"),
        from_secret("S3_SECRET_ACCESS_KEY", "secretKey"),
        plain("AWS_ENDPOINT_URL_S3", settings.s3_endpoint.clone()),
        plain("AWS_REGION", REGION.to_string()),
        from_secret("AWS_ACCESS_KEY_ID", "accessKey"),
        from_secret("AWS_SECRET_ACCESS_KEY", "secretKey"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reconcile::tests::app;
    use crate::settings::Settings;

    #[test]
    fn bucket_is_named_for_its_namespace_and_limited_to_its_user() {
        let mut app = app();
        app.spec.bucket = Some(crate::crd::BucketSpec {
            quota: Some("5Gi".into()),
        });
        let built = build(&app, &Settings::default());
        let (kind, bucket) = &built[2];
        assert_eq!(kind.kind, "Bucket");
        assert_eq!(bucket["spec"]["name"], "team-shop");
        assert_eq!(bucket["spec"]["access"][0]["user"], "team-shop");
        assert_eq!(bucket["spec"]["quota"]["size"], "5Gi");
        assert_eq!(bucket["spec"]["clusterRef"]["namespace"], "seaweedfs");
        assert_eq!(built[1].1["spec"]["secretRef"]["name"], "shop-s3");
    }
}
