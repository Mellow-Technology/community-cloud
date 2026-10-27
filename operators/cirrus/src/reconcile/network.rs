//! @file
//! How an application is reached: its own listeners on the cluster
//! Gateway, a route to it, and plain HTTP sent to HTTPS.
//!
//! The same arrangement every application in k8s/apps uses (see
//! Plane.network.yaml): a ListenerSet attached to the one Gateway,
//! with an HTTP and an HTTPS listener per hostname, and cert-manager
//! asked for the certificate by an annotation. cert-manager answers
//! the HTTP-01 challenge on the HTTP listener, so the redirect route
//! there has to stay less specific than the challenge's.
//!
//! The Gateway only accepts ListenerSets from namespaces carrying its
//! label, and refuses others quietly. That's checked first, so the
//! WebApplication says why rather than serving nothing.

use k8s_openapi::api::core::v1::Namespace;
use kube::Api;
use serde_json::{Value, json};

use super::{Context, owner_reference};
use crate::crd::{WebApplication, labels};
use crate::error::{Error, Result};
use crate::resources::{self, HTTP_ROUTE, LISTENER_SET};
use crate::settings::Settings;

// What the cluster Gateway's allowedListeners selects on, in
// k8s/networking/cilium/gateway/Gateway.yaml
pub const GATEWAY_LABEL: &str = "whereWereGoing";
pub const GATEWAY_LABEL_VALUE: &str = "weDontNeedRoads";

/// Make the listeners and routes, or remove them when the application
/// no longer has a hostname. Returns the address it's served on.
pub async fn ensure(ctx: &Context, app: &WebApplication) -> Result<Option<String>> {
    let (namespace, name) = super::identity(app);
    if app.spec.hostnames.is_empty() {
        for (kind, object_name) in [
            (&HTTP_ROUTE, format!("{name}-redirect")),
            (&HTTP_ROUTE, name.clone()),
            (&LISTENER_SET, name.clone()),
        ] {
            resources::delete_dynamic(&ctx.client, kind, &namespace, &object_name).await?;
        }
        return Ok(None);
    }

    let ns = Api::<Namespace>::all(ctx.client.clone()).get(&namespace).await?;
    let allowed = ns
        .metadata
        .labels
        .as_ref()
        .and_then(|labels| labels.get(GATEWAY_LABEL))
        .is_some_and(|value| value == GATEWAY_LABEL_VALUE);
    if !allowed {
        return Err(Error::NotPermitted(format!(
            "the cluster Gateway won't take listeners from {namespace}: it needs the label {GATEWAY_LABEL}=\"{GATEWAY_LABEL_VALUE}\""
        )));
    }

    for (kind, object) in build(app, &ctx.settings) {
        resources::apply_dynamic(&ctx.client, kind, object).await?;
    }
    Ok(Some(format!("https://{}", app.spec.hostnames[0])))
}

pub fn build(app: &WebApplication, settings: &Settings) -> Vec<(&'static resources::Kind, Value)> {
    let (namespace, name) = super::identity(app);
    let hostnames = &app.spec.hostnames;
    let metadata = |object_name: String, annotations: Value| {
        json!({
            "name": object_name,
            "namespace": namespace,
            "labels": labels(&name),
            "annotations": annotations,
            "ownerReferences": [owner_reference(app)],
        })
    };

    let mut listeners = Vec::new();
    for (index, hostname) in hostnames.iter().enumerate() {
        listeners
            .push(json!({ "name": format!("http-{index}"), "port": 80, "protocol": "HTTP", "hostname": hostname }));
        listeners.push(json!({
            "name": format!("https-{index}"),
            "port": 443,
            "protocol": "HTTPS",
            "hostname": hostname,
            "tls": { "mode": "Terminate", "certificateRefs": [{ "kind": "Secret", "name": format!("{name}-tls") }] },
        }));
    }
    let parents = |prefix: &str| -> Vec<Value> {
        (0..hostnames.len())
            .map(|index| {
                json!({
                    "group": LISTENER_SET.group,
                    "kind": LISTENER_SET.kind,
                    "name": name,
                    "sectionName": format!("{prefix}-{index}"),
                })
            })
            .collect()
    };

    vec![
        (
            &LISTENER_SET,
            json!({
                "apiVersion": LISTENER_SET.api_version(),
                "kind": LISTENER_SET.kind,
                "metadata": metadata(name.clone(), json!({ "cert-manager.io/cluster-issuer": settings.cluster_issuer })),
                "spec": {
                    "parentRef": {
                        "group": "gateway.networking.k8s.io",
                        "kind": "Gateway",
                        "name": settings.gateway_name,
                        "namespace": settings.gateway_namespace,
                    },
                    "listeners": listeners,
                },
            }),
        ),
        (
            &HTTP_ROUTE,
            json!({
                "apiVersion": HTTP_ROUTE.api_version(),
                "kind": HTTP_ROUTE.kind,
                "metadata": metadata(name.clone(), json!({})),
                "spec": {
                    "parentRefs": parents("https"),
                    "hostnames": hostnames,
                    "rules": [{ "backendRefs": [{ "name": name, "port": app.spec.port }] }],
                },
            }),
        ),
        (
            &HTTP_ROUTE,
            json!({
                "apiVersion": HTTP_ROUTE.api_version(),
                "kind": HTTP_ROUTE.kind,
                "metadata": metadata(format!("{name}-redirect"), json!({})),
                "spec": {
                    "parentRefs": parents("http"),
                    "hostnames": hostnames,
                    "rules": [{
                        "filters": [{ "type": "RequestRedirect", "requestRedirect": { "scheme": "https", "statusCode": 301 } }],
                    }],
                },
            }),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reconcile::tests::app;

    #[test]
    fn a_listener_pair_per_hostname() {
        let mut app = app();
        app.spec.hostnames = vec!["shop.example.com".into(), "www.shop.example.com".into()];
        let built = build(&app, &Settings::default());
        let listeners = built[0].1["spec"]["listeners"].as_array().unwrap();
        assert_eq!(listeners.len(), 4);
        assert_eq!(
            built[0].1["metadata"]["annotations"]["cert-manager.io/cluster-issuer"],
            "cc-lets-encrypt"
        );
        assert_eq!(built[1].1["spec"]["parentRefs"][1]["sectionName"], "https-1");
        assert_eq!(built[2].1["spec"]["parentRefs"][0]["sectionName"], "http-0");
        assert_eq!(built[1].1["spec"]["rules"][0]["backendRefs"][0]["port"], 8080);
    }
}
