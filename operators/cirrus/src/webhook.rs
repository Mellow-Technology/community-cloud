//! @file
//! The HTTP side of Cirrus: forge webhooks, and health checks.
//!
//! A webhook does as little as it can. It checks the request came
//! from the forge, decides whether the pipeline is one to roll out,
//! works out which image that pipeline published, and records it as
//! the application's release. The rollout itself — migrations, the
//! Deployment — is left to the reconciler, which the status change
//! wakes. That keeps one place deciding what runs, and lets GitLab
//! have its answer well inside its ten-second timeout.
//!
//! Each application has its own address and its own token, so the
//! token is checked against that application's Secret, in constant
//! time. Anything that isn't a successful pipeline on the tracked ref
//! is acknowledged and ignored: GitLab disables a hook that keeps
//! failing, and an ignored event isn't a failure.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use kube::Api;
use kube::api::{Patch, PatchParams};
use serde::Deserialize;
use serde_json::json;
use subtle::ConstantTimeEq;

use crate::crd::{GitLabSource, WebApplication};
use crate::forge;
use crate::reconcile::Context;
use crate::reconcile::source::{WEBHOOK_TOKEN_KEY, webhook_secret_name};

#[derive(Debug, Deserialize)]
pub struct PipelineEvent {
    pub object_attributes: PipelineAttributes,
}

#[derive(Debug, Deserialize)]
pub struct PipelineAttributes {
    pub status: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub sha: String,
}

pub fn router(ctx: Arc<Context>) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(|| async { "ok" }))
        .route("/hooks/gitlab/{namespace}/{name}", post(gitlab))
        .with_state(ctx)
}

pub fn token_matches(given: &str, expected: &str) -> bool {
    !expected.is_empty() && bool::from(given.as_bytes().ct_eq(expected.as_bytes()))
}

/// The commit to roll out, if this event is a successful pipeline on
/// the tracked ref.
pub fn commit_to_roll_out(event: &str, body: &[u8], source: &GitLabSource) -> Result<Option<String>, String> {
    if event != "Pipeline Hook" {
        return Ok(None);
    }
    let pipeline: PipelineEvent = serde_json::from_slice(body).map_err(|error| error.to_string())?;
    let attributes = pipeline.object_attributes;
    Ok((attributes.status == "success" && attributes.git_ref == source.git_ref).then_some(attributes.sha))
}

async fn gitlab(
    State(ctx): State<Arc<Context>>,
    Path((namespace, name)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, String) {
    let header = |key: &str| {
        headers
            .get(key)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string()
    };

    let apps = Api::<WebApplication>::namespaced(ctx.client.clone(), &namespace);
    // A 5xx when Kubernetes can't be asked, so GitLab retries; a 404
    // only when the application really isn't there
    let app = match apps.get_opt(&name).await {
        Ok(Some(app)) => app,
        Ok(None) => return (StatusCode::NOT_FOUND, "no such application".to_string()),
        Err(error) => {
            tracing::warn!(%namespace, %name, %error, "couldn't read the application");
            return (StatusCode::SERVICE_UNAVAILABLE, "try again later".to_string());
        }
    };
    let Some(source) = app.gitlab() else {
        return (
            StatusCode::NOT_FOUND,
            "this application has no GitLab source".to_string(),
        );
    };

    let expected = forge::read_secret_key(&ctx.client, &namespace, &webhook_secret_name(&name), WEBHOOK_TOKEN_KEY)
        .await
        .unwrap_or_default();
    if !token_matches(&header("X-Gitlab-Token"), &expected) {
        return (StatusCode::UNAUTHORIZED, "wrong token".to_string());
    }

    let sha = match commit_to_roll_out(&header("X-Gitlab-Event"), &body, source) {
        Ok(Some(sha)) => sha,
        Ok(None) => return (StatusCode::OK, "ignored".to_string()),
        Err(error) => return (StatusCode::BAD_REQUEST, error),
    };

    let release = async {
        let gitlab = forge::gitlab_client(&ctx.client, &app, source).await?;
        forge::release_for(&gitlab, &app, source, &sha).await
    };
    let release = match release.await {
        Ok(release) => release,
        Err(error) => {
            tracing::warn!(%namespace, %name, %error, "couldn't work out the pipeline's image");
            return (StatusCode::BAD_GATEWAY, error.to_string());
        }
    };

    let patch = json!({ "status": { "release": release } });
    if let Err(error) = apps
        .patch_status(&name, &PatchParams::default(), &Patch::Merge(patch))
        .await
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    tracing::info!(%namespace, %name, image = %release.reference(), "new release");
    (StatusCode::OK, format!("rolling out {}", release.reference()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> GitLabSource {
        GitLabSource {
            project: "acme/shop".into(),
            git_ref: "main".into(),
            ..Default::default()
        }
    }

    fn pipeline(status: &str, git_ref: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "object_kind": "pipeline",
            "object_attributes": { "id": 1, "status": status, "ref": git_ref, "sha": "abc123" }
        }))
        .unwrap()
    }

    #[test]
    fn rolls_out_successful_pipelines_on_the_ref() {
        assert_eq!(
            commit_to_roll_out("Pipeline Hook", &pipeline("success", "main"), &source()),
            Ok(Some("abc123".into()))
        );
    }

    #[test]
    fn ignores_everything_else() {
        assert_eq!(
            commit_to_roll_out("Pipeline Hook", &pipeline("running", "main"), &source()),
            Ok(None)
        );
        assert_eq!(
            commit_to_roll_out("Pipeline Hook", &pipeline("success", "feature"), &source()),
            Ok(None)
        );
        assert_eq!(commit_to_roll_out("Push Hook", b"{}", &source()), Ok(None));
        assert!(commit_to_roll_out("Pipeline Hook", b"not json", &source()).is_err());
    }

    #[test]
    fn tokens() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abd", "abc"));
        assert!(!token_matches("", ""));
    }
}
