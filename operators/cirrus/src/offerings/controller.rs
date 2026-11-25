//! @file
//! Keeps each ServiceOffering's status: where it's reached, whether its
//! Service has anything ready behind it, its binding Secret, and which
//! applications are connected to it.
//!
//! It looks again when an offering changes, when an application's
//! connections do (so its consumers are current), and every minute,
//! which is what notices a Service's pods coming and going without
//! watching every EndpointSlice in the cluster.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use k8s_openapi::api::core::v1::{Secret, Service};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::runtime::controller::{Action, Controller};
use kube::runtime::reflector::ObjectRef;
use kube::runtime::watcher;
use kube::{Client, Resource, ResourceExt};
use serde_json::json;

use super::{BindingRef, ConsumerRef, RESERVED_ENTRIES, ServiceOffering, binding_name, host, may_connect, uri};
use crate::conditions::{self, READY};
use crate::crd::WebApplication;
use crate::error::{Error, Result};
use crate::resources;

// How often an offering is looked at again on its own, which is how
// pods becoming ready behind its Service are noticed
const REQUEUE: Duration = Duration::from_secs(60);

pub struct Context {
    pub client: Client,
}

pub async fn run(client: Client) {
    let offerings = Api::<ServiceOffering>::all(client.clone());
    let context = Arc::new(Context { client: client.clone() });
    Controller::new(offerings, watcher::Config::default())
        .owns(Api::<Secret>::all(client.clone()), watcher::Config::default())
        // An application's connections name the offerings it uses
        .watches(
            Api::<WebApplication>::all(client.clone()),
            watcher::Config::default(),
            |app| {
                let namespace = app.namespace().unwrap_or_default();
                app.spec
                    .connections
                    .iter()
                    .map(|connection| {
                        ObjectRef::<ServiceOffering>::new(&connection.offering)
                            .within(connection.namespace.as_deref().unwrap_or(&namespace))
                    })
                    .collect::<Vec<_>>()
            },
        )
        .shutdown_on_signal()
        .run(reconcile, error_policy, context)
        .for_each(|result| async move {
            if let Err(error) = result {
                tracing::warn!(%error, "ServiceOffering reconcile failed");
            }
        })
        .await;
}

fn error_policy(_offering: Arc<ServiceOffering>, error: &Error, _ctx: Arc<Context>) -> Action {
    tracing::warn!(%error, "will retry");
    Action::requeue(Duration::from_secs(30))
}

/// The port a Service serves an offering on: the one named or numbered,
/// or its only one, or the one named http.
pub fn resolve_port(service: &Service, wanted: Option<&str>) -> std::result::Result<i32, String> {
    let ports = service
        .spec
        .as_ref()
        .and_then(|spec| spec.ports.clone())
        .unwrap_or_default();
    if let Some(wanted) = wanted.map(str::trim).filter(|wanted| !wanted.is_empty()) {
        return ports
            .iter()
            .find(|port| port.name.as_deref() == Some(wanted) || port.port.to_string() == wanted)
            .map(|port| port.port)
            .ok_or_else(|| format!("the Service has no port {wanted}"));
    }
    match ports.as_slice() {
        [] => Err("the Service has no ports".to_string()),
        [only] => Ok(only.port),
        several => several
            .iter()
            .find(|port| port.name.as_deref() == Some("http"))
            .map(|port| port.port)
            .ok_or_else(|| {
                "the Service has several ports and none is named http: say which in service.port".to_string()
            }),
    }
}

/// Whether anything behind a Service is ready to answer.
pub fn any_ready(slices: &[EndpointSlice]) -> bool {
    slices.iter().any(|slice| {
        slice.endpoints.iter().any(|endpoint| {
            endpoint
                .conditions
                .as_ref()
                .and_then(|conditions| conditions.ready)
                .unwrap_or(true)
        })
    })
}

/// What goes in the binding Secret: the Service Binding
/// Specification's well-known entries, then the offering's values and
/// its Secret's keys, none of which may replace the first.
pub fn binding_data(
    offering: &ServiceOffering,
    host: &str,
    port: i32,
    uri: &str,
    secret: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut data = BTreeMap::new();
    for (key, value) in offering.spec.values.iter().chain(secret) {
        if !RESERVED_ENTRIES.contains(&key.as_str()) {
            data.insert(key.clone(), value.clone());
        }
    }
    data.insert("type".to_string(), offering.spec.protocol.name().to_string());
    data.insert("provider".to_string(), "community-cloud".to_string());
    data.insert("host".to_string(), host.to_string());
    data.insert("port".to_string(), port.to_string());
    data.insert("uri".to_string(), uri.to_string());
    data
}

/// The applications connected to an offering, and whether each may.
pub fn consumers(namespace: &str, name: &str, share_with: &[String], apps: &[WebApplication]) -> Vec<ConsumerRef> {
    let mut found: Vec<ConsumerRef> = apps
        .iter()
        .filter_map(|app| {
            let app_namespace = app.namespace()?;
            app.spec
                .connections
                .iter()
                .any(|connection| {
                    connection.offering == name
                        && connection.namespace.as_deref().unwrap_or(&app_namespace) == namespace
                })
                .then(|| ConsumerRef {
                    allowed: may_connect(namespace, share_with, &app_namespace),
                    namespace: app_namespace,
                    name: app.name_any(),
                })
        })
        .collect();
    found.sort();
    found
}

async fn reconcile(offering: Arc<ServiceOffering>, ctx: Arc<Context>) -> Result<Action> {
    let namespace = offering.namespace().unwrap_or_default();
    let name = offering.name_any();
    let generation = offering.metadata.generation;
    let previous = offering.status.clone().unwrap_or_default();
    let mut conditions = previous.conditions.clone();
    let mut status = json!({ "observedGeneration": generation });

    let apps = Api::<WebApplication>::all(ctx.client.clone())
        .list(&ListParams::default())
        .await?
        .items;
    status["consumers"] = json!(consumers(&namespace, &name, &offering.spec.share_with, &apps));

    let service = Api::<Service>::namespaced(ctx.client.clone(), &namespace)
        .get_opt(&offering.spec.service.name)
        .await?;
    let found = match service {
        None => Err(format!(
            "there's no Service {} in {namespace}",
            offering.spec.service.name
        )),
        Some(service) => resolve_port(&service, offering.spec.service.port.as_deref())
            .map_err(|problem| format!("{}: {problem}", offering.spec.service.name)),
    };

    let (ok, reason, message) = match found {
        Err(problem) => (false, "NoService", problem),
        Ok(port) => {
            let host = host(&offering.spec.service.name, &namespace);
            let uri = uri(offering.spec.protocol, &host, port, offering.spec.path.as_deref());

            // Its credentials, if it has any; a missing Secret is said,
            // and the address still given
            let mut secret_problem = None;
            let mut secret_data = BTreeMap::new();
            if let Some(secret_name) = &offering.spec.secret {
                match Api::<Secret>::namespaced(ctx.client.clone(), &namespace)
                    .get_opt(secret_name)
                    .await?
                {
                    Some(secret) => {
                        for (key, value) in secret.data.unwrap_or_default() {
                            secret_data.insert(key, String::from_utf8_lossy(&value.0).into_owned());
                        }
                    }
                    None => secret_problem = Some(format!("there's no Secret {secret_name} in {namespace}")),
                }
            }

            let binding = binding_name(&name);
            let owner = offering
                .controller_owner_ref(&())
                .expect("an offering from the API has a uid");
            resources::apply(
                &Api::<Secret>::namespaced(ctx.client.clone(), &namespace),
                &binding,
                &Secret {
                    metadata: ObjectMeta {
                        name: Some(binding.clone()),
                        namespace: Some(namespace.clone()),
                        owner_references: Some(vec![owner]),
                        labels: Some(BTreeMap::from([(
                            "app.kubernetes.io/managed-by".to_string(),
                            "cirrus".to_string(),
                        )])),
                        ..Default::default()
                    },
                    // The Service Binding Specification's type for it
                    type_: Some(format!("servicebinding.io/{}", offering.spec.protocol.name())),
                    string_data: Some(binding_data(&offering, &host, port, &uri, &secret_data)),
                    ..Default::default()
                },
            )
            .await?;

            status["host"] = json!(host);
            status["port"] = json!(port);
            status["uri"] = json!(uri);
            status["binding"] = json!(BindingRef { name: binding });

            let slices = Api::<EndpointSlice>::namespaced(ctx.client.clone(), &namespace)
                .list(
                    &ListParams::default()
                        .labels(&format!("kubernetes.io/service-name={}", offering.spec.service.name)),
                )
                .await?
                .items;
            match (secret_problem, any_ready(&slices)) {
                (Some(problem), _) => (false, "NoSecret", problem),
                (None, true) => (true, "Ready", String::new()),
                (None, false) => (
                    false,
                    "NothingReady",
                    format!("nothing behind {} is ready yet", offering.spec.service.name),
                ),
            }
        }
    };
    conditions::set(&mut conditions, READY, ok, reason, message, generation);
    status["conditions"] = json!(conditions);

    Api::<ServiceOffering>::namespaced(ctx.client.clone(), &namespace)
        .patch_status(
            &name,
            &PatchParams::default(),
            &Patch::Merge(json!({ "status": status })),
        )
        .await?;
    Ok(Action::requeue(REQUEUE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::ConnectionSpec;
    use crate::offerings::{Protocol, ServiceOfferingSpec, ServiceTarget};
    use k8s_openapi::api::core::v1::{ServicePort, ServiceSpec};
    use k8s_openapi::api::discovery::v1::{Endpoint, EndpointConditions};

    fn service(ports: &[(Option<&str>, i32)]) -> Service {
        Service {
            spec: Some(ServiceSpec {
                ports: Some(
                    ports
                        .iter()
                        .map(|(name, port)| ServicePort {
                            name: name.map(str::to_string),
                            port: *port,
                            ..Default::default()
                        })
                        .collect(),
                ),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn the_port_is_the_one_asked_for_or_the_only_or_http() {
        let several = service(&[(Some("http"), 8080), (Some("metrics"), 9090)]);
        assert_eq!(resolve_port(&several, None), Ok(8080));
        assert_eq!(resolve_port(&several, Some("metrics")), Ok(9090));
        assert_eq!(resolve_port(&several, Some("9090")), Ok(9090));
        assert!(
            resolve_port(&several, Some("grpc"))
                .unwrap_err()
                .contains("no port grpc")
        );
        assert_eq!(resolve_port(&service(&[(None, 5432)]), None), Ok(5432));
        let unnamed = service(&[(Some("a"), 1), (Some("b"), 2)]);
        assert!(resolve_port(&unnamed, None).unwrap_err().contains("say which"));
        assert!(resolve_port(&service(&[]), None).is_err());
    }

    #[test]
    fn ready_when_anything_behind_it_is() {
        let slice = |ready: Option<bool>| EndpointSlice {
            endpoints: vec![Endpoint {
                conditions: Some(EndpointConditions {
                    ready,
                    ..Default::default()
                }),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(!any_ready(&[]));
        assert!(!any_ready(&[slice(Some(false))]));
        assert!(any_ready(&[slice(Some(false)), slice(Some(true))]));
        // Unknown counts as ready, as Kubernetes says to read it
        assert!(any_ready(&[slice(None)]));
    }

    fn offering() -> ServiceOffering {
        let mut offering = ServiceOffering::new(
            "search",
            ServiceOfferingSpec {
                title: "Search".into(),
                protocol: Protocol::Http,
                service: ServiceTarget {
                    name: "search".into(),
                    port: None,
                },
                values: BTreeMap::from([
                    ("region".to_string(), "sea".to_string()),
                    ("host".to_string(), "x".to_string()),
                ]),
                ..Default::default()
            },
        );
        offering.metadata.namespace = Some("catalogue".into());
        offering
    }

    #[test]
    fn the_binding_has_the_well_known_entries_which_nothing_replaces() {
        let secret = BTreeMap::from([
            ("username".to_string(), "search".to_string()),
            ("uri".to_string(), "not-this".to_string()),
        ]);
        let data = binding_data(
            &offering(),
            "search.catalogue.svc.cluster.local",
            8080,
            "http://h:8080",
            &secret,
        );
        assert_eq!(data["type"], "http");
        assert_eq!(data["provider"], "community-cloud");
        assert_eq!(data["host"], "search.catalogue.svc.cluster.local");
        assert_eq!(data["port"], "8080");
        assert_eq!(data["uri"], "http://h:8080");
        assert_eq!(data["region"], "sea");
        assert_eq!(data["username"], "search");
    }

    #[test]
    fn consumers_are_the_applications_connected_and_whether_they_may_be() {
        let app = |namespace: &str, name: &str, connections: Vec<ConnectionSpec>| {
            let mut app = crate::reconcile::tests::app();
            app.metadata.name = Some(name.into());
            app.metadata.namespace = Some(namespace.into());
            app.spec.connections = connections;
            app
        };
        let to = |offering: &str, namespace: Option<&str>| ConnectionSpec {
            offering: offering.into(),
            namespace: namespace.map(str::to_string),
            name: None,
        };
        let apps = vec![
            app("catalogue", "admin", vec![to("search", None)]),
            app("shop", "web", vec![to("search", Some("catalogue"))]),
            app("other", "nosy", vec![to("search", Some("catalogue"))]),
            app("shop", "unrelated", vec![to("search", None)]),
        ];
        let found = consumers("catalogue", "search", &["shop".to_string()], &apps);
        assert_eq!(
            found,
            vec![
                ConsumerRef {
                    namespace: "catalogue".into(),
                    name: "admin".into(),
                    allowed: true
                },
                ConsumerRef {
                    namespace: "other".into(),
                    name: "nosy".into(),
                    allowed: false
                },
                ConsumerRef {
                    namespace: "shop".into(),
                    name: "web".into(),
                    allowed: true
                },
            ]
        );
    }
}
