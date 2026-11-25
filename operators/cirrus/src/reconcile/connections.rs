//! @file
//! An application's connections to ServiceOfferings, as environment
//! variables, and the offering an application makes of itself.
//!
//! Each connection gives <NAME>_HOST, <NAME>_PORT, <NAME>_URL and
//! <NAME>_TYPE, then <NAME>_<KEY> for each of the offering's values;
//! and, from an offering in the same namespace, <NAME>_<KEY> for each
//! key of its Secret, read from the binding Secret Cirrus keeps beside
//! it. A pod can't read a Secret in another namespace, so a connection
//! from elsewhere gets the address and not the keys.
//!
//! A connection waits, rather than failing, while its offering isn't
//! there or hasn't found its Service yet: either may just be a moment
//! behind. One to an offering not shared with this namespace is
//! refused.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::{EnvVar, EnvVarSource, Secret, SecretKeySelector};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::Api;

use super::{Context, Outcome, Provided};
use crate::crd::{ConnectionSpec, WebApplication, labels};
use crate::error::{Error, Result};
use crate::offerings::{
    RESERVED_ENTRIES, ServiceOffering, ServiceOfferingSpec, ServiceTarget, env_prefix, may_connect,
};
use crate::resources;

/// Problems with the connections as written, before any is looked up:
/// two that would set the same variables.
pub fn problems(app: &WebApplication) -> Vec<String> {
    let mut problems = Vec::new();
    let mut seen: BTreeMap<String, &str> = BTreeMap::new();
    for connection in &app.spec.connections {
        let prefix = env_prefix(connection.name());
        if let Some(other) = seen.insert(prefix.clone(), connection.name()) {
            problems.push(format!(
                "the connections {other} and {} would both set {prefix}_*: give one a different name",
                connection.name()
            ));
        }
    }
    problems
}

/// A plain variable.
fn plain(name: String, value: String) -> EnvVar {
    EnvVar {
        name,
        value: Some(value),
        value_from: None,
    }
}

/// The variables one connection gives, or why it can't yet.
///
/// `secret_keys` are the binding Secret's keys beyond the well-known
/// ones and the offering's values: its own Secret's, which a
/// connection from the same namespace gets as references.
pub fn env_for(
    app_namespace: &str,
    connection: &ConnectionSpec,
    offering: &ServiceOffering,
    secret_keys: &[String],
) -> std::result::Result<Vec<EnvVar>, String> {
    let status = offering.status.clone().unwrap_or_default();
    let (Some(host), Some(port), Some(uri)) = (status.host, status.port, status.uri) else {
        return Err(format!(
            "waiting for the offering {} to find its Service",
            connection.offering
        ));
    };
    let prefix = env_prefix(connection.name());
    let mut env = vec![
        plain(format!("{prefix}_HOST"), host),
        plain(format!("{prefix}_PORT"), port.to_string()),
        plain(format!("{prefix}_URL"), uri),
        plain(format!("{prefix}_TYPE"), offering.spec.protocol.name().to_string()),
    ];
    for (key, value) in &offering.spec.values {
        if !RESERVED_ENTRIES.contains(&key.as_str()) {
            env.push(plain(format!("{prefix}_{}", env_prefix(key)), value.clone()));
        }
    }
    let same_namespace = offering.metadata.namespace.as_deref() == Some(app_namespace);
    if let (true, Some(binding)) = (same_namespace, status.binding) {
        for key in secret_keys {
            env.push(EnvVar {
                name: format!("{prefix}_{}", env_prefix(key)),
                value: None,
                value_from: Some(EnvVarSource {
                    secret_key_ref: Some(SecretKeySelector {
                        name: binding.name.clone(),
                        key: key.clone(),
                        optional: None,
                    }),
                    ..Default::default()
                }),
            });
        }
    }
    Ok(env)
}

/// Looks up each connection's offering and makes its variables.
pub async fn ensure(ctx: &Context, app: &WebApplication) -> Result<Outcome> {
    let problems = problems(app);
    if !problems.is_empty() {
        return Err(Error::NotPermitted(problems.join("; ")));
    }
    let (namespace, _) = super::identity(app);
    let mut env = Vec::new();
    let mut waiting = Vec::new();
    let mut refused = Vec::new();
    for connection in &app.spec.connections {
        let offering_namespace = connection.namespace.clone().unwrap_or_else(|| namespace.clone());
        let Some(offering) = Api::<ServiceOffering>::namespaced(ctx.client.clone(), &offering_namespace)
            .get_opt(&connection.offering)
            .await?
        else {
            waiting.push(format!(
                "waiting for a ServiceOffering {} in {offering_namespace}",
                connection.offering
            ));
            continue;
        };
        if !may_connect(&offering_namespace, &offering.spec.share_with, &namespace) {
            refused.push(format!(
                "the offering {} in {offering_namespace} isn't shared with {namespace}",
                connection.offering
            ));
            continue;
        }
        // Its own Secret's keys, from the binding, when it's this
        // namespace's and has one
        let mut secret_keys = Vec::new();
        if offering_namespace == namespace
            && offering.spec.secret.is_some()
            && let Some(binding) = offering.status.as_ref().and_then(|status| status.binding.as_ref())
            && let Some(secret) = Api::<Secret>::namespaced(ctx.client.clone(), &namespace)
                .get_opt(&binding.name)
                .await?
        {
            secret_keys = secret
                .data
                .unwrap_or_default()
                .into_keys()
                .filter(|key| !RESERVED_ENTRIES.contains(&key.as_str()) && !offering.spec.values.contains_key(key))
                .collect();
        }
        match env_for(&namespace, connection, &offering, &secret_keys) {
            Ok(more) => env.extend(more),
            Err(message) => waiting.push(message),
        }
    }
    if !refused.is_empty() {
        return Err(Error::NotPermitted(refused.join("; ")));
    }
    if !waiting.is_empty() {
        return Ok(Outcome::Pending(waiting.join("; ")));
    }
    Ok(Outcome::Ready(Provided { env_from: vec![], env }))
}

/// The ServiceOffering an application makes of itself: its own Service,
/// named for it, owned by it.
pub fn own_offering(app: &WebApplication) -> Option<ServiceOffering> {
    let offer = app.spec.offers.as_ref()?;
    let (namespace, name) = super::identity(app);
    let mut offering = ServiceOffering::new(
        &name,
        ServiceOfferingSpec {
            title: offer
                .title
                .clone()
                .filter(|title| !title.trim().is_empty())
                .unwrap_or_else(|| name.clone()),
            description: offer.description.clone(),
            protocol: offer.protocol,
            service: ServiceTarget {
                name: name.clone(),
                port: Some("http".to_string()),
            },
            path: offer.path.clone(),
            share_with: offer.share_with.clone(),
            ..Default::default()
        },
    );
    offering.metadata = ObjectMeta {
        name: Some(name.clone()),
        namespace: Some(namespace),
        labels: Some(labels(&name)),
        owner_references: Some(vec![super::owner_reference(app)]),
        ..Default::default()
    };
    Some(offering)
}

/// Makes or updates the application's own offering, or removes it once
/// it no longer offers itself; only one it owns, never one a person
/// wrote by the same name.
pub async fn ensure_offered(ctx: &Context, app: &WebApplication) -> Result<()> {
    let (namespace, name) = super::identity(app);
    let api = Api::<ServiceOffering>::namespaced(ctx.client.clone(), &namespace);
    match own_offering(app) {
        Some(offering) => {
            resources::apply(&api, &name, &offering).await?;
        }
        None => {
            let uid = app.metadata.uid.clone();
            if let Some(existing) = api.get_opt(&name).await?
                && existing
                    .metadata
                    .owner_references
                    .unwrap_or_default()
                    .iter()
                    .any(|owner| Some(&owner.uid) == uid.as_ref())
            {
                api.delete(&name, &Default::default()).await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::OfferSpec;
    use crate::offerings::{BindingRef, Protocol, ServiceOfferingStatus};

    fn offering(namespace: &str, ready: bool) -> ServiceOffering {
        let mut offering = ServiceOffering::new(
            "search",
            ServiceOfferingSpec {
                title: "Search".into(),
                protocol: Protocol::Http,
                service: ServiceTarget {
                    name: "search".into(),
                    port: None,
                },
                secret: Some("search-credentials".into()),
                values: BTreeMap::from([("region".to_string(), "sea".to_string())]),
                ..Default::default()
            },
        );
        offering.metadata.namespace = Some(namespace.into());
        if ready {
            offering.status = Some(ServiceOfferingStatus {
                host: Some("search.catalogue.svc.cluster.local".into()),
                port: Some(8080),
                uri: Some("http://search.catalogue.svc.cluster.local:8080".into()),
                binding: Some(BindingRef {
                    name: "search-binding".into(),
                }),
                ..Default::default()
            });
        }
        offering
    }

    fn connection(name: Option<&str>) -> ConnectionSpec {
        ConnectionSpec {
            offering: "search".into(),
            namespace: Some("catalogue".into()),
            name: name.map(str::to_string),
        }
    }

    fn names(env: &[EnvVar]) -> Vec<&str> {
        env.iter().map(|var| var.name.as_str()).collect()
    }

    #[test]
    fn a_connection_gives_the_address_and_values_under_its_name() {
        let env = env_for(
            "shop",
            &connection(Some("product-search")),
            &offering("catalogue", true),
            &[],
        )
        .unwrap();
        assert_eq!(
            names(&env),
            [
                "PRODUCT_SEARCH_HOST",
                "PRODUCT_SEARCH_PORT",
                "PRODUCT_SEARCH_URL",
                "PRODUCT_SEARCH_TYPE",
                "PRODUCT_SEARCH_REGION"
            ]
        );
        assert_eq!(env[1].value.as_deref(), Some("8080"));
        assert_eq!(
            env[2].value.as_deref(),
            Some("http://search.catalogue.svc.cluster.local:8080")
        );
    }

    #[test]
    fn credentials_go_only_to_the_same_namespace_and_by_reference() {
        let keys = vec!["password".to_string()];
        let elsewhere = env_for("shop", &connection(None), &offering("catalogue", true), &keys).unwrap();
        assert!(!names(&elsewhere).contains(&"SEARCH_PASSWORD"));

        let here = env_for("catalogue", &connection(None), &offering("catalogue", true), &keys).unwrap();
        let password = here.iter().find(|var| var.name == "SEARCH_PASSWORD").unwrap();
        assert!(password.value.is_none());
        let reference = password.value_from.as_ref().unwrap().secret_key_ref.as_ref().unwrap();
        assert_eq!(
            (reference.name.as_str(), reference.key.as_str()),
            ("search-binding", "password")
        );
    }

    #[test]
    fn a_connection_waits_for_its_offering_to_find_its_service() {
        let waiting = env_for("shop", &connection(None), &offering("catalogue", false), &[]).unwrap_err();
        assert!(waiting.contains("waiting for the offering search"));
    }

    #[test]
    fn two_connections_can_t_set_the_same_variables() {
        let mut app = crate::reconcile::tests::app();
        app.spec.connections = vec![connection(Some("search")), connection(None)];
        assert!(problems(&app)[0].contains("both set SEARCH_*"));
        app.spec.connections = vec![connection(Some("search")), connection(Some("other"))];
        assert!(problems(&app).is_empty());
    }

    #[test]
    fn an_application_offers_its_own_service_named_for_it() {
        let mut app = crate::reconcile::tests::app();
        assert!(own_offering(&app).is_none());
        app.spec.offers = Some(OfferSpec {
            description: "The shop's API".into(),
            path: Some("/api".into()),
            share_with: vec!["web".into()],
            ..Default::default()
        });
        let offering = own_offering(&app).unwrap();
        assert_eq!(offering.metadata.name.as_deref(), Some("shop"));
        assert_eq!(offering.metadata.namespace.as_deref(), Some("team"));
        assert_eq!(offering.metadata.owner_references.as_ref().unwrap()[0].name, "shop");
        assert_eq!(offering.spec.title, "shop");
        assert_eq!(offering.spec.service.name, "shop");
        assert_eq!(offering.spec.service.port.as_deref(), Some("http"));
        assert_eq!(offering.spec.path.as_deref(), Some("/api"));
        assert_eq!(offering.spec.share_with, vec!["web".to_string()]);
    }
}
