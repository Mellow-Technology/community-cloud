//! @file
//! What has to be removed by hand when a WebApplication is deleted.
//!
//! Everything in the application's own namespace is owned by the
//! WebApplication and goes with it, its Postgres role and database
//! included. (CloudNativePG keeps the database itself when its
//! Database resource goes, and the namespace's Postgres isn't owned by
//! any application, so no data goes.) What's in cc-office for RabbitMQ
//! can't be — an owner reference can't cross namespaces — and neither
//! can the webhook on the GitLab project. Those are removed here,
//! before the finalizer lets the WebApplication go.
//!
//! A webhook that can't be removed — the token revoked, GitLab down —
//! is logged and left, rather than holding the deletion up forever.

use super::Context;
use crate::crd::WebApplication;
use crate::error::Result;
use crate::forge;
use crate::naming::shared_name;
use crate::resources::{self, PERMISSION, RABBITMQ_USER, VHOST};

pub async fn run(ctx: &Context, app: &WebApplication) -> Result<()> {
    let (namespace, name) = super::identity(app);
    let services = &ctx.settings.services_namespace;
    let shared = shared_name(&namespace, &name);

    // Whatever the spec says now, since a block removed earlier may
    // have left these behind
    for kind in [&PERMISSION, &RABBITMQ_USER, &VHOST] {
        resources::delete_dynamic(&ctx.client, kind, services, &shared).await?;
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
