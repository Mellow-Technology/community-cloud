//! @file
//! A database of its own in the cluster's shared Postgres.
//!
//! CloudNativePG only acts on a Database or DatabaseRole in the
//! Cluster's own namespace, so these go in cc-office beside
//! cc-postgres rather than beside the application — the same split
//! k8s/apps/plane/Plane.database.yaml makes by hand. Nothing in
//! another namespace can own them, so they're removed by the
//! finalizer rather than by garbage collection (see cleanup.rs).
//!
//! The application can't read a Secret in cc-office either, so its
//! credentials are copied into its own namespace as `<app>-postgres`,
//! with the variables libpq reads and a DATABASE_URL besides. The
//! password is made once and kept: changing it would mean every
//! running copy losing its connection at once.

use std::collections::BTreeMap;

use k8s_openapi::ByteString;
use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use kube::api::{ObjectMeta, PostParams};
use rand::Rng;
use rand::distr::Alphanumeric;
use serde_json::json;

use super::{Context, Outcome, Provided, owner_reference};
use crate::crd::WebApplication;
use crate::error::Result;
use crate::naming::{postgres_identifier, shared_name};
use crate::resources::{self, DATABASE, DATABASE_ROLE};

// Long enough not to matter, and alphanumeric so it never needs
// escaping in a connection URL
const PASSWORD_LENGTH: usize = 32;

pub fn generate_password() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(PASSWORD_LENGTH)
        .map(char::from)
        .collect()
}

/// The Secret in cc-office holding the role's password.
pub fn password_secret_name(namespace: &str, name: &str) -> String {
    format!("{}-db", shared_name(namespace, name))
}

pub async fn ensure(ctx: &Context, app: &WebApplication) -> Result<Outcome> {
    let (namespace, name) = super::identity(app);
    let settings = &ctx.settings;
    let services = &settings.services_namespace;
    let identifier = postgres_identifier(&namespace, &name);
    let shared = shared_name(&namespace, &name);
    let owner_labels = super::cross_namespace_labels(&namespace, &name);

    // The password, made once
    let secrets_there = Api::<Secret>::namespaced(ctx.client.clone(), services);
    let password_secret = password_secret_name(&namespace, &name);
    let password = match secrets_there.get_opt(&password_secret).await? {
        Some(secret) => secret_text(&secret, "password").unwrap_or_default(),
        None => {
            let password = generate_password();
            let secret = Secret {
                metadata: ObjectMeta {
                    name: Some(password_secret.clone()),
                    namespace: Some(services.clone()),
                    labels: Some(owner_labels.clone()),
                    ..Default::default()
                },
                type_: Some("kubernetes.io/basic-auth".to_string()),
                data: Some(BTreeMap::from([
                    ("username".to_string(), ByteString(identifier.clone().into_bytes())),
                    ("password".to_string(), ByteString(password.clone().into_bytes())),
                ])),
                ..Default::default()
            };
            secrets_there.create(&PostParams::default(), &secret).await?;
            password
        }
    };

    resources::apply_dynamic(
        &ctx.client,
        &DATABASE_ROLE,
        json!({
            "apiVersion": DATABASE_ROLE.api_version(),
            "kind": DATABASE_ROLE.kind,
            "metadata": { "name": shared, "namespace": services, "labels": owner_labels },
            "spec": {
                "name": identifier,
                "cluster": { "name": settings.postgres_cluster },
                "ensure": "present",
                "login": true,
                "comment": format!("{namespace}/{name}, through Cirrus"),
                "passwordSecret": { "name": password_secret },
            },
        }),
    )
    .await?;

    let database = resources::apply_dynamic(
        &ctx.client,
        &DATABASE,
        json!({
            "apiVersion": DATABASE.api_version(),
            "kind": DATABASE.kind,
            "metadata": { "name": shared, "namespace": services, "labels": owner_labels },
            "spec": {
                "name": identifier,
                "owner": identifier,
                "cluster": { "name": settings.postgres_cluster },
            },
        }),
    )
    .await?;

    // The credentials, where the application can read them
    let host = settings.postgres_host();
    let connection = connection_secret(app, &host, &identifier, &password);
    let secret_name = connection.metadata.name.clone().unwrap_or_default();
    resources::apply(
        &Api::<Secret>::namespaced(ctx.client.clone(), &namespace),
        &secret_name,
        &connection,
    )
    .await?;

    let applied = database.data["status"]["applied"].as_bool().unwrap_or(false);
    if !applied {
        return Ok(Outcome::Pending(format!(
            "waiting for CloudNativePG to create the database {identifier} in {}",
            settings.postgres_cluster
        )));
    }
    Ok(Outcome::Ready(Provided {
        env_from: vec![secret_name],
        env: vec![],
    }))
}

/// The Secret the application reads its database from.
pub fn connection_secret(app: &WebApplication, host: &str, identifier: &str, password: &str) -> Secret {
    let (namespace, name) = super::identity(app);
    let url = format!("postgresql://{identifier}:{password}@{host}:5432/{identifier}");
    let values = [
        ("PGHOST", host.to_string()),
        ("PGPORT", "5432".to_string()),
        ("PGDATABASE", identifier.to_string()),
        ("PGUSER", identifier.to_string()),
        ("PGPASSWORD", password.to_string()),
        ("DATABASE_URL", url),
    ];
    Secret {
        metadata: ObjectMeta {
            name: Some(format!("{name}-postgres")),
            namespace: Some(namespace),
            labels: Some(crate::crd::labels(&name)),
            owner_references: Some(vec![owner_reference(app)]),
            ..Default::default()
        },
        data: Some(
            values
                .into_iter()
                .map(|(k, v)| (k.to_string(), ByteString(v.into_bytes())))
                .collect(),
        ),
        ..Default::default()
    }
}

pub fn secret_text(secret: &Secret, key: &str) -> Option<String> {
    secret
        .data
        .as_ref()
        .and_then(|data| data.get(key))
        .and_then(|value| String::from_utf8(value.0.clone()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reconcile::tests::app;

    #[test]
    fn connection_secret_carries_a_url() {
        let secret = connection_secret(&app(), "cc-postgres-rw.cc-office.svc", "team_shop", "pw");
        assert_eq!(secret.metadata.name.as_deref(), Some("shop-postgres"));
        let url = secret_text(&secret, "DATABASE_URL").unwrap();
        assert_eq!(
            url,
            "postgresql://team_shop:pw@cc-postgres-rw.cc-office.svc:5432/team_shop"
        );
    }

    #[test]
    fn passwords_are_url_safe() {
        let password = generate_password();
        assert_eq!(password.len(), PASSWORD_LENGTH);
        assert!(password.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
