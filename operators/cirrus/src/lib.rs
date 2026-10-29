//! @file
//! Cirrus: runs web applications on Community Cloud.
//!
//! A WebApplication says what an application needs — a database, a
//! bucket, a queue, hostnames, migrations, where its images come
//! from — and Cirrus makes it so with the services the cluster
//! already runs: CloudNativePG, the SeaweedFS operator, RabbitMQ's
//! topology operator and the cluster Gateway. It provisions nothing
//! of its own, so an application it runs looks exactly like one
//! written out by hand in k8s/apps.
//!
//! Split into a library so the CRD generator and the tests see the
//! same types the operator runs with.

pub mod conditions;
pub mod crd;
pub mod dns;
pub mod error;
pub mod forge;
pub mod naming;
pub mod reconcile;
pub mod resources;
pub mod settings;
pub mod webhook;

/// Choose rustls's cryptography: ring, which kube-rs already uses.
///
/// reqwest's own TLS feature brings aws-lc-rs beside kube-rs's ring,
/// and rustls panics rather than choose between them the first time a
/// TLS client is made. So reqwest is built without a provider, and
/// ring is installed here, explicitly, rather than left to whichever
/// features happen to be unified. Safe to call more than once.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
