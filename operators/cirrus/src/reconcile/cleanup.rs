//! @file
//! What has to be removed by hand when a WebApplication is deleted.
//!
//! Everything in the application's own namespace is owned by the
//! WebApplication and goes with it. What's in cc-office can't be — an
//! owner reference can't cross namespaces — and neither can the
//! webhook on the GitLab project. Those are removed here, before the
//! finalizer lets the WebApplication go.
//!
//! The Postgres database itself stays: CloudNativePG retains a
//! database when its Database resource is deleted, unless told
//! otherwise, and a deleted resource is too easy a way to lose data.
//! The role goes, so nothing can sign in to it until it's claimed.
//!
//! A webhook that can't be removed — the token revoked, GitLab down —
//! is logged and left, rather than holding the deletion up forever.

use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use kube::api::DeleteParams;

use super::Context;
use crate::crd::WebApplication;
use crate::error::Result;
use crate::forge;
use crate::naming::shared_name;
use crate::reconcile::postgres::password_secret_name;
use crate::resources::{self, DATABASE, DATABASE_ROLE, PERMISSION, RABBITMQ_USER, VHOST, is_not_found};

pub async fn run(ctx: &Context, app: &WebApplication) -> Result<()> {
    let (namespace, name) = super::identity(app);
    let services = &ctx.settings.services_namespace;
    let shared = shared_name(&namespace, &name);

    // Whatever the spec says now, since a block removed earlier may
    // have left these behind
    for kind in [&DATABASE, &DATABASE_ROLE, &PERMISSION, &RABBITMQ_USER, &VHOST] {
        resources::delete_dynamic(&ctx.client, kind, services, &shared).await?;
    }
    let secrets = Api::<Secret>::namespaced(ctx.client.clone(), services);
    match secrets
        .delete(&password_secret_name(&namespace, &name), &DeleteParams::default())
        .await
    {
        Ok(_) => {}
        Err(error) if is_not_found(&error) => {}
        Err(error) => return Err(error.into()),
    }

    let hook = app.status.as_ref().and_then(|status| status.webhook.clone());
    if let (Some(hook), Some(source)) = (hook, app.gitlab()) {
        let removed = async {
            let gitlab = forge::gitlab_client(&ctx.client, app, source).await?;
            gitlab.delete_hook(&source.project, hook.hook_id).await
        };
        if let Err(error) = removed.await {
            tracing::warn!(%namespace, %name, %error, "couldn't remove the GitLab webhook; leaving it");
        }
    }
    Ok(())
}
