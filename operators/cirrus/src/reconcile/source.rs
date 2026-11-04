//! @file
//! Keeping up with the forge: the webhook that tells Cirrus about new
//! images, and a slow poll in case it doesn't.
//!
//! The webhook is the fast path, but webhooks get lost — Cirrus
//! restarting at the wrong moment, GitLab giving up after retries, a
//! hook deleted by someone tidying the project settings. So every ten
//! minutes the reconciler also asks for the newest successful
//! pipeline itself. The two meet in the same place: a Release in the
//! status, which the rollout acts on whichever found it.
//!
//! The poll is also how a new application finds what to run first:
//! one never checked is due at once, so its first rollout is the
//! newest release rather than `spec.image.tag`. Only a check that
//! worked counts as checked. One that failed — a bad token, GitLab
//! down, a pipeline whose image tag isn't in the registry — is tried
//! again on the next pass rather than ten minutes later, since until
//! it works the application may be running a stale tag.
//!
//! Each webhook is registered with a token of its own, kept in
//! `<app>-cirrus-webhook`, so a request for one application can't be
//! forged by knowing another's.

use std::collections::BTreeMap;

use k8s_openapi::ByteString;
use k8s_openapi::api::core::v1::Secret;
use k8s_openapi::jiff::{SignedDuration, Timestamp};
use kube::Api;
use kube::api::{ObjectMeta, PostParams};

use super::postgres::{generate_password, secret_text};
use super::{Context, owner_reference};
use crate::crd::{Release, WebApplication, WebhookStatus, labels};
use crate::error::Result;
use crate::forge;

// Slow enough to be no burden on GitLab across many applications;
// quick enough that a lost webhook costs minutes, not a day
pub const POLL_INTERVAL_MINUTES: i64 = 10;

pub const WEBHOOK_TOKEN_KEY: &str = "token";

pub fn webhook_secret_name(name: &str) -> String {
    format!("{name}-cirrus-webhook")
}

/// What keeping up with the forge found this time.
#[derive(Default)]
pub struct SourceResult {
    pub webhook: Option<WebhookStatus>,
    pub webhook_problem: Option<String>,
    pub release: Option<Release>,
    // Set only when the forge was asked and answered
    pub checked_at: Option<String>,
    // Why the forge couldn't be asked, or didn't answer
    pub problem: Option<String>,
}

pub fn poll_due(last_checked: Option<&str>, now: Timestamp) -> bool {
    match last_checked.and_then(|text| text.parse::<Timestamp>().ok()) {
        Some(at) => now.duration_since(at) >= SignedDuration::from_mins(POLL_INTERVAL_MINUTES),
        None => true,
    }
}

/// The application's webhook token, made the first time it's needed.
pub async fn webhook_token(ctx: &Context, app: &WebApplication) -> Result<String> {
    let (namespace, name) = super::identity(app);
    let secrets = Api::<Secret>::namespaced(ctx.client.clone(), &namespace);
    let secret_name = webhook_secret_name(&name);
    if let Some(existing) = secrets.get_opt(&secret_name).await?
        && let Some(token) = secret_text(&existing, WEBHOOK_TOKEN_KEY)
    {
        return Ok(token);
    }
    let token = generate_password();
    let secret = Secret {
        metadata: ObjectMeta {
            name: Some(secret_name),
            namespace: Some(namespace),
            labels: Some(labels(&name)),
            owner_references: Some(vec![owner_reference(app)]),
            ..Default::default()
        },
        data: Some(BTreeMap::from([(
            WEBHOOK_TOKEN_KEY.to_string(),
            ByteString(token.clone().into_bytes()),
        )])),
        ..Default::default()
    };
    secrets.create(&PostParams::default(), &secret).await?;
    Ok(token)
}

pub async fn sync(ctx: &Context, app: &WebApplication) -> SourceResult {
    let mut result = SourceResult::default();
    let Some(source) = app.gitlab() else { return result };
    let (namespace, name) = super::identity(app);
    let status = app.status.clone().unwrap_or_default();

    let gitlab = match forge::gitlab_client(&ctx.client, app, source).await {
        Ok(gitlab) => gitlab,
        Err(error) => {
            result.problem = Some(error.to_string());
            result.webhook_problem = Some(error.to_string());
            return result;
        }
    };

    // The webhook, registered again only when its address changes
    match ctx.settings.webhook_url(&namespace, &name) {
        None => {
            result.webhook_problem = Some(
                "Cirrus has no public address (CIRRUS_WEBHOOK_BASE_URL), so new images are found by polling"
                    .to_string(),
            )
        }
        Some(url) if status.webhook.as_ref().is_some_and(|hook| hook.url == url) => {
            result.webhook = status.webhook.clone()
        }
        Some(url) => {
            let registered = async {
                let token = webhook_token(ctx, app).await?;
                gitlab.ensure_hook(&source.project, &url, &token).await
            };
            match registered.await {
                Ok(hook_id) => result.webhook = Some(WebhookStatus { hook_id, url }),
                Err(error) => result.webhook_problem = Some(error.to_string()),
            }
        }
    }

    // The poll
    let now = Timestamp::now();
    if poll_due(status.last_checked.as_deref(), now) {
        let known = status.release.as_ref().map(|release| release.commit.clone());
        let found = async {
            match gitlab
                .latest_successful_pipeline(&source.project, &source.git_ref)
                .await?
            {
                Some(pipeline) if Some(&pipeline.sha) != known.as_ref() => {
                    forge::release_for(&gitlab, app, source, &pipeline.sha).await.map(Some)
                }
                _ => Ok(None),
            }
        };
        match found.await {
            Ok(release) => {
                result.release = release;
                result.checked_at = Some(now.to_string());
            }
            Err(error) => result.problem = Some(error.to_string()),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polls_when_never_checked_or_stale() {
        let now = Timestamp::now();
        assert!(poll_due(None, now));
        assert!(poll_due(Some("not a time"), now));
        assert!(!poll_due(Some(&(now - SignedDuration::from_mins(2)).to_string()), now));
        assert!(poll_due(Some(&(now - SignedDuration::from_mins(11)).to_string()), now));
    }
}
