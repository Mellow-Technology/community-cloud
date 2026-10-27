//! @file
//! A vhost of its own in the cluster's shared RabbitMQ, and a user
//! that can only use that vhost.
//!
//! The topology operator only acts on resources that can see the
//! RabbitmqCluster, which is in cc-office, so these go there as they
//! do in k8s/apps/plane/Plane.queue.yaml — and are removed by the
//! finalizer, since nothing in another namespace can own them. The
//! operator makes up the user's name and password into
//! `<user>-user-credentials` beside them; those are copied into the
//! application's namespace as `<app>-rabbitmq`, with an AMQP_URL.

use std::collections::BTreeMap;

use k8s_openapi::ByteString;
use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use kube::api::ObjectMeta;
use serde_json::{Value, json};

use super::postgres::secret_text;
use super::{Context, Outcome, Provided, owner_reference};
use crate::crd::{WebApplication, labels};
use crate::error::Result;
use crate::naming::shared_name;
use crate::resources::{self, PERMISSION, RABBITMQ_USER, VHOST};
use crate::settings::Settings;

pub async fn ensure(ctx: &Context, app: &WebApplication) -> Result<Outcome> {
    let (namespace, name) = super::identity(app);
    let settings = &ctx.settings;
    for (kind, object) in build(app, settings) {
        resources::apply_dynamic(&ctx.client, kind, object).await?;
    }

    let shared = shared_name(&namespace, &name);
    let generated = Api::<Secret>::namespaced(ctx.client.clone(), &settings.services_namespace)
        .get_opt(&format!("{shared}-user-credentials"))
        .await?;
    let credentials = generated
        .as_ref()
        .and_then(|secret| Some((secret_text(secret, "username")?, secret_text(secret, "password")?)));
    let Some((username, password)) = credentials else {
        return Ok(Outcome::Pending(
            "waiting for RabbitMQ's topology operator to make the user".to_string(),
        ));
    };

    let secret = connection_secret(app, settings, &username, &password);
    let secret_name = secret.metadata.name.clone().unwrap_or_default();
    resources::apply(
        &Api::<Secret>::namespaced(ctx.client.clone(), &namespace),
        &secret_name,
        &secret,
    )
    .await?;
    Ok(Outcome::Ready(Provided {
        env_from: vec![secret_name],
        env: vec![],
    }))
}

/// The vhost, user and permission, in the services namespace.
pub fn build(app: &WebApplication, settings: &Settings) -> Vec<(&'static resources::Kind, Value)> {
    let (namespace, name) = super::identity(app);
    let shared = shared_name(&namespace, &name);
    let metadata = json!({
        "name": shared,
        "namespace": settings.services_namespace,
        "labels": super::cross_namespace_labels(&namespace, &name),
    });
    let cluster = json!({ "name": settings.rabbitmq_cluster });
    vec![
        (
            &VHOST,
            json!({
                "apiVersion": VHOST.api_version(),
                "kind": VHOST.kind,
                "metadata": metadata,
                "spec": { "name": shared, "rabbitmqClusterReference": cluster },
            }),
        ),
        (
            &RABBITMQ_USER,
            json!({
                "apiVersion": RABBITMQ_USER.api_version(),
                "kind": RABBITMQ_USER.kind,
                "metadata": metadata,
                "spec": { "rabbitmqClusterReference": cluster },
            }),
        ),
        (
            &PERMISSION,
            json!({
                "apiVersion": PERMISSION.api_version(),
                "kind": PERMISSION.kind,
                "metadata": metadata,
                "spec": {
                    "vhost": shared,
                    "userReference": { "name": shared },
                    "permissions": { "configure": ".*", "write": ".*", "read": ".*" },
                    "rabbitmqClusterReference": cluster,
                },
            }),
        ),
    ]
}

pub fn connection_secret(app: &WebApplication, settings: &Settings, username: &str, password: &str) -> Secret {
    let (namespace, name) = super::identity(app);
    let vhost = shared_name(&namespace, &name);
    let host = settings.rabbitmq_host();
    let url = format!(
        "amqp://{}:{}@{host}:5672/{}",
        urlencoding::encode(username),
        urlencoding::encode(password),
        urlencoding::encode(&vhost)
    );
    let values = [
        ("RABBITMQ_HOST", host.clone()),
        ("RABBITMQ_PORT", "5672".to_string()),
        ("RABBITMQ_USERNAME", username.to_string()),
        ("RABBITMQ_PASSWORD", password.to_string()),
        ("RABBITMQ_VHOST", vhost),
        ("AMQP_URL", url),
    ];
    Secret {
        metadata: ObjectMeta {
            name: Some(format!("{name}-rabbitmq")),
            namespace: Some(namespace),
            labels: Some(labels(&name)),
            owner_references: Some(vec![owner_reference(app)]),
            ..Default::default()
        },
        data: Some(
            values
                .into_iter()
                .map(|(k, v)| (k.to_string(), ByteString(v.into_bytes())))
                .collect::<BTreeMap<_, _>>(),
        ),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reconcile::tests::app;

    #[test]
    fn everything_lands_beside_the_cluster() {
        let built = build(&app(), &Settings::default());
        assert!(built.iter().all(|(_, o)| o["metadata"]["namespace"] == "cc-office"));
        assert_eq!(built[2].1["spec"]["vhost"], "team-shop");
    }

    #[test]
    fn url_escapes_credentials() {
        let secret = connection_secret(&app(), &Settings::default(), "u/x", "p@ss");
        let url = secret_text(&secret, "AMQP_URL").unwrap();
        assert_eq!(url, "amqp://u%2Fx:p%40ss@rabbitmq.cc-office.svc:5672/team-shop");
    }
}
