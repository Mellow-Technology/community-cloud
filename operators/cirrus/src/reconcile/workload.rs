//! @file
//! The application itself: its Deployment and the Service in front of
//! it.
//!
//! Built as plain functions from the WebApplication and the image to
//! run, so the shape can be tested without a cluster. Which image that
//! is — the old one while migrations run, the new one after — is the
//! reconciler's decision, not this module's.

use std::collections::BTreeMap;

use k8s_openapi::api::apps::v1::{Deployment, DeploymentSpec, DeploymentStatus};
use k8s_openapi::api::core::v1::{
    Container, ContainerPort, EnvFromSource, EnvVar, HTTPGetAction, LocalObjectReference, PodSpec, PodTemplateSpec,
    Probe, ResourceRequirements, SecretEnvSource, Service, ServicePort, ServiceSpec,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::ObjectMeta;

use super::owner_reference;
use crate::crd::{WebApplication, labels, selector};

// What the first draft of this resource promised an application that
// didn't say, and enough for most small web servers
const DEFAULT_MEMORY: &str = "256Mi";

/// What every container Cirrus runs for an application shares: the
/// image, the environment and the resources.
pub fn container(app: &WebApplication, image: &str, env_from: &[String], env: &[EnvVar]) -> Container {
    let mut variables = env.to_vec();
    variables.extend(app.spec.env.iter().cloned());
    let resources = app.spec.resources.clone().unwrap_or_else(|| {
        let memory = BTreeMap::from([("memory".to_string(), Quantity(DEFAULT_MEMORY.to_string()))]);
        ResourceRequirements {
            requests: Some(memory.clone()),
            limits: Some(memory),
            ..Default::default()
        }
    });
    Container {
        name: "app".to_string(),
        image: Some(image.to_string()),
        env: (!variables.is_empty()).then_some(variables),
        env_from: (!env_from.is_empty()).then(|| {
            env_from
                .iter()
                .map(|secret| EnvFromSource {
                    secret_ref: Some(SecretEnvSource {
                        name: secret.clone(),
                        optional: None,
                    }),
                    ..Default::default()
                })
                .collect()
        }),
        resources: Some(resources),
        ..Default::default()
    }
}

pub fn pull_secrets(app: &WebApplication) -> Option<Vec<LocalObjectReference>> {
    (!app.spec.image_pull_secrets.is_empty()).then(|| {
        app.spec
            .image_pull_secrets
            .iter()
            .map(|name| LocalObjectReference { name: name.clone() })
            .collect()
    })
}

pub fn deployment(app: &WebApplication, image: &str, env_from: &[String], env: &[EnvVar]) -> Deployment {
    let (namespace, name) = super::identity(app);
    let mut main = container(app, image, env_from, env);
    main.ports = Some(vec![ContainerPort {
        name: Some("http".to_string()),
        container_port: app.spec.port,
        ..Default::default()
    }]);
    if let Some(check) = &app.spec.health_check {
        main.readiness_probe = Some(Probe {
            http_get: Some(HTTPGetAction {
                path: Some(check.path.clone()),
                port: IntOrString::String("http".to_string()),
                ..Default::default()
            }),
            period_seconds: Some(5),
            ..Default::default()
        });
    }
    Deployment {
        metadata: ObjectMeta {
            name: Some(name.clone()),
            namespace: Some(namespace),
            labels: Some(labels(&name)),
            owner_references: Some(vec![owner_reference(app)]),
            ..Default::default()
        },
        spec: Some(DeploymentSpec {
            replicas: Some(app.spec.replicas),
            selector: LabelSelector {
                match_labels: Some(selector(&name)),
                ..Default::default()
            },
            template: PodTemplateSpec {
                metadata: Some(ObjectMeta {
                    labels: Some(labels(&name)),
                    ..Default::default()
                }),
                spec: Some(PodSpec {
                    containers: vec![main],
                    image_pull_secrets: pull_secrets(app),
                    ..Default::default()
                }),
            },
            ..Default::default()
        }),
        ..Default::default()
    }
}

pub fn service(app: &WebApplication) -> Service {
    let (namespace, name) = super::identity(app);
    Service {
        metadata: ObjectMeta {
            name: Some(name.clone()),
            namespace: Some(namespace),
            labels: Some(labels(&name)),
            owner_references: Some(vec![owner_reference(app)]),
            ..Default::default()
        },
        spec: Some(ServiceSpec {
            selector: Some(selector(&name)),
            ports: Some(vec![ServicePort {
                name: Some("http".to_string()),
                port: app.spec.port,
                target_port: Some(IntOrString::String("http".to_string())),
                ..Default::default()
            }]),
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// Whether every copy is running the newest template and available.
pub fn rolled_out(deployment: &Deployment, replicas: i32) -> bool {
    let generation = deployment.metadata.generation.unwrap_or_default();
    let Some(status) = &deployment.status else { return false };
    let DeploymentStatus {
        observed_generation,
        updated_replicas,
        available_replicas,
        replicas: total,
        ..
    } = status;
    observed_generation.unwrap_or_default() >= generation
        && updated_replicas.unwrap_or_default() == replicas
        && available_replicas.unwrap_or_default() == replicas
        && total.unwrap_or_default() == replicas
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reconcile::tests::app;

    #[test]
    fn spec_env_comes_after_provided_env() {
        let mut app = app();
        app.spec.env = vec![EnvVar {
            name: "S3_REGION".into(),
            value: Some("eu".into()),
            value_from: None,
        }];
        let provided = vec![EnvVar {
            name: "S3_REGION".into(),
            value: Some("us-east-1".into()),
            value_from: None,
        }];
        let built = deployment(&app, "img@sha256:1", &["shop-postgres".into()], &provided);
        let pod = built.spec.unwrap().template.spec.unwrap();
        let env = pod.containers[0].env.clone().unwrap();
        assert_eq!(env.last().unwrap().value.as_deref(), Some("eu"));
        assert_eq!(pod.containers[0].image.as_deref(), Some("img@sha256:1"));
        let env_from = pod.containers[0].env_from.clone().unwrap();
        assert_eq!(env_from[0].secret_ref.as_ref().unwrap().name, "shop-postgres");
    }

    #[test]
    fn defaults_to_256mi() {
        let built = deployment(&app(), "img", &[], &[]);
        let container = &built.spec.unwrap().template.spec.unwrap().containers[0];
        let limits = container.resources.as_ref().unwrap().limits.as_ref().unwrap();
        assert_eq!(limits["memory"].0, "256Mi");
    }
}
