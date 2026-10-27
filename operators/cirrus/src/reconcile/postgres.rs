//! @file
//! A database of its own, in its namespace's Postgres.
//!
//! Each namespace gets one CloudNativePG Cluster, shared by every
//! WebApplication in it that asks for Postgres, rather than every
//! application in the cluster sharing cc-postgres. Partly that's
//! isolation: one tenant's load, extensions and outages stay theirs.
//! Mostly it's placement. A namespace can be pinned to a region (see
//! installer/src/util/placement.ts), and that pins every pod made in
//! it, CloudNativePG's included, so the database lands beside the
//! application querying it. In cc-office it would be wherever
//! cc-office is, and an application a continent away pays that on
//! every query.
//!
//! Cirrus makes the Cluster once and then leaves it be. After that it
//! belongs to the namespace: its size, instances and backups are for
//! a person to change, and applying Cirrus's defaults over them on
//! every pass would undo that — or, for a volume, fail, since one can
//! only grow. It isn't owned by any WebApplication either, so deleting
//! the last one doesn't take the data with it.
//!
//! With the Cluster beside the application, so are its Database and
//! DatabaseRole, which CloudNativePG wants in the Cluster's namespace.
//! The application owns them and they go when it does; CloudNativePG
//! keeps the database itself. The password is made once and kept:
//! changing it would mean every running copy losing its connection at
//! once.

use std::collections::BTreeMap;

use k8s_openapi::ByteString;
use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use kube::api::{ObjectMeta, PostParams};
use rand::Rng;
use rand::distr::Alphanumeric;
use serde_json::{Value, json};

use super::{Context, Outcome, Provided, owner_reference};
use crate::crd::WebApplication;
use crate::error::Result;
use crate::naming::postgres_identifier;
use crate::resources::{self, DATABASE, DATABASE_ROLE, Kind, POSTGRES_CLUSTER};
use crate::settings::Settings;

// Long enough not to matter, and alphanumeric so it never needs
// escaping in a connection URL
const PASSWORD_LENGTH: usize = 32;

// CloudNativePG only notices a changed password Secret when it carries
// this; without it the first password is applied and no later one
const RELOAD_LABEL: &str = "cnpg.io/reload";

pub fn generate_password() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(PASSWORD_LENGTH)
        .map(char::from)
        .collect()
}

/// The Secret holding the role's password, beside the role.
pub fn password_secret_name(name: &str) -> String {
    format!("{name}-postgres-role")
}

/// The namespace's Postgres, as Cirrus first makes it.
pub fn cluster(settings: &Settings, namespace: &str) -> Value {
    let mut spec = json!({
        "instances": settings.postgres_instances,
        "storage": {
            "size": settings.postgres_storage_size,
            "storageClass": settings.postgres_storage_class,
        },
    });
    if let Some(image) = &settings.postgres_image {
        spec["imageName"] = json!(image);
    }
    json!({
        "apiVersion": POSTGRES_CLUSTER.api_version(),
        "kind": POSTGRES_CLUSTER.kind,
        "metadata": {
            "name": settings.postgres_cluster,
            "namespace": namespace,
            "labels": { "app.kubernetes.io/managed-by": "cirrus" },
        },
        "spec": spec,
    })
}

/// The application's role and database in the namespace's Postgres.
pub fn role_and_database(settings: &Settings, app: &WebApplication) -> [(&'static Kind, Value); 2] {
    let (namespace, name) = super::identity(app);
    let identifier = postgres_identifier(&name);
    let metadata = json!({
        "name": name,
        "namespace": namespace,
        "labels": crate::crd::labels(&name),
        "ownerReferences": [owner_reference(app)],
    });
    let cluster = json!({ "name": settings.postgres_cluster });
    [
        (
            &DATABASE_ROLE,
            json!({
                "apiVersion": DATABASE_ROLE.api_version(),
                "kind": DATABASE_ROLE.kind,
                "metadata": metadata,
                "spec": {
                    "name": identifier,
                    "cluster": cluster,
                    "ensure": "present",
                    "login": true,
                    "comment": format!("{namespace}/{name}, through Cirrus"),
                    "passwordSecret": { "name": password_secret_name(&name) },
                },
            }),
        ),
        (
            &DATABASE,
            json!({
                "apiVersion": DATABASE.api_version(),
                "kind": DATABASE.kind,
                "metadata": metadata,
                "spec": {
                    "name": identifier,
                    "owner": identifier,
                    "cluster": cluster,
                },
            }),
        ),
    ]
}

pub async fn ensure(ctx: &Context, app: &WebApplication) -> Result<Outcome> {
    let (namespace, name) = super::identity(app);
    let settings = &ctx.settings;
    let identifier = postgres_identifier(&name);

    let cluster =
        resources::create_dynamic_if_missing(&ctx.client, &POSTGRES_CLUSTER, cluster(settings, &namespace)).await?;

    // The password, made once
    let secrets = Api::<Secret>::namespaced(ctx.client.clone(), &namespace);
    let password_secret = password_secret_name(&name);
    let password = match secrets.get_opt(&password_secret).await? {
        Some(secret) => secret_text(&secret, "password").unwrap_or_default(),
        None => {
            let password = generate_password();
            let mut labels = crate::crd::labels(&name);
            labels.insert(RELOAD_LABEL.to_string(), "true".to_string());
            let secret = Secret {
                metadata: ObjectMeta {
                    name: Some(password_secret.clone()),
                    namespace: Some(namespace.clone()),
                    labels: Some(labels),
                    owner_references: Some(vec![owner_reference(app)]),
                    ..Default::default()
                },
                type_: Some("kubernetes.io/basic-auth".to_string()),
                data: Some(BTreeMap::from([
                    ("username".to_string(), ByteString(identifier.clone().into_bytes())),
                    ("password".to_string(), ByteString(password.clone().into_bytes())),
                ])),
                ..Default::default()
            };
            secrets.create(&PostParams::default(), &secret).await?;
            password
        }
    };

    let mut applied = false;
    for (kind, object) in role_and_database(settings, app) {
        let made = resources::apply_dynamic(&ctx.client, kind, object).await?;
        if kind.kind == DATABASE.kind {
            applied = made.data["status"]["applied"].as_bool().unwrap_or(false);
        }
    }

    // The credentials, in what the application loads
    let host = settings.postgres_host(&namespace);
    let connection = connection_secret(app, &host, &identifier, &password);
    let secret_name = connection.metadata.name.clone().unwrap_or_default();
    resources::apply(&secrets, &secret_name, &connection).await?;

    if !applied {
        let phase = cluster.data["status"]["phase"].as_str().unwrap_or("starting");
        return Ok(Outcome::Pending(format!(
            "waiting for CloudNativePG to create the database {identifier} in {} ({phase})",
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
        let secret = connection_secret(&app(), "cirrus-postgres-rw.team.svc", "shop", "pw");
        assert_eq!(secret.metadata.name.as_deref(), Some("shop-postgres"));
        let url = secret_text(&secret, "DATABASE_URL").unwrap();
        assert_eq!(url, "postgresql://shop:pw@cirrus-postgres-rw.team.svc:5432/shop");
    }

    #[test]
    fn the_cluster_is_the_namespaces_own() {
        let settings = Settings::default();
        let cluster = cluster(&settings, "team");
        assert_eq!(cluster["metadata"]["namespace"], "team");
        assert_eq!(cluster["metadata"]["name"], "cirrus-postgres");
        // Nothing owns it, so deleting an application keeps the data
        assert!(cluster["metadata"]["ownerReferences"].is_null());
        assert_eq!(cluster["spec"]["storage"]["storageClass"], "cc-local-ssd-fast");
        assert!(cluster["spec"]["imageName"].is_null());
        assert_eq!(settings.postgres_host("team"), "cirrus-postgres-rw.team.svc");
    }

    #[test]
    fn role_and_database_sit_beside_the_application() {
        let built = role_and_database(&Settings::default(), &app());
        for (_, object) in &built {
            assert_eq!(object["metadata"]["namespace"], "team");
            assert_eq!(object["metadata"]["ownerReferences"][0]["name"], "shop");
            assert_eq!(object["spec"]["cluster"]["name"], "cirrus-postgres");
        }
        assert_eq!(built[0].1["spec"]["passwordSecret"]["name"], "shop-postgres-role");
        assert_eq!(built[1].1["spec"]["owner"], "shop");
    }

    #[test]
    fn passwords_are_url_safe() {
        let password = generate_password();
        assert_eq!(password.len(), PASSWORD_LENGTH);
        assert!(password.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
