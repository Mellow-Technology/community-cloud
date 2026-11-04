//! @file
//! Cirrus's entry point: the controllers — WebApplications and
//! DnsProviders — and the webhook server, side by side in one process.
//!
//! They share a Kubernetes client and nothing else; the webhook only
//! writes a release into a WebApplication's status, and the controller
//! picks it up from there. If any of them stops, the process exits, so
//! the Deployment restarts the lot rather than leaving part of Cirrus
//! running.

use std::sync::Arc;

use cirrus::dns;
use cirrus::reconcile::{self, Context};
use cirrus::settings::Settings;
use cirrus::webhook;
use kube::Client;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .json()
        .init();

    cirrus::install_crypto_provider();
    let settings = Settings::from_env();
    let client = Client::try_default().await?;
    if settings.webhook_base_url.is_none() {
        tracing::warn!(
            "CIRRUS_WEBHOOK_BASE_URL isn't set: no webhooks will be registered, and releases are found by polling"
        );
    }

    let listener = tokio::net::TcpListener::bind(&settings.listen_address).await?;
    tracing::info!(address = %settings.listen_address, "listening");
    let router = webhook::router(Arc::new(Context {
        client: client.clone(),
        settings: settings.clone(),
    }));
    let server = axum::serve(listener, router).with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    });

    tokio::select! {
        result = server => result?,
        () = reconcile::run(client.clone(), settings.clone()) => {}
        () = dns::controller::run(client, settings) => {}
    }
    Ok(())
}
