//! @file
//! Restarting an application when a value it reads from a Secret or a
//! ConfigMap changes.
//!
//! A container reads its environment when it starts, so a variable
//! taken from a Secret or a ConfigMap (secretKeyRef, configMapKeyRef in
//! spec.env) keeps its old value until the pod is replaced: changing an
//! API key in Meteorologist would do nothing until something else
//! restarted it. So the values the application reads are hashed into an
//! annotation on the pod template, and a changed value is a changed
//! template, which the Deployment rolls out like any other change.
//!
//! Only the keys it reads count, so changing one of the namespace's
//! shared values restarts the applications that read that one and no
//! others. One that isn't there counts as missing, and its arriving is a
//! change too. An application that reads nothing from Secrets or
//! ConfigMaps has no annotation, so this changes nothing for it.
//!
//! The controller looks again whenever a Secret or ConfigMap an
//! application refers to changes (see `references_object`), its own
//! `<app>-secrets` and the namespace's `community-cloud-env` included.

use std::collections::BTreeSet;

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{ConfigMap, EnvVar, Secret};
use kube::{Api, Client};
use sha2::{Digest, Sha256};

use super::environment;
use crate::crd::WebApplication;
use crate::error::Result;

pub const ANNOTATION: &str = "community-cloud.technology/config-hash";

/// What a value is read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Source {
    Secret,
    ConfigMap,
}

/// One key of one Secret or ConfigMap that the application reads.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Reference {
    pub source: Source,
    pub name: String,
    pub key: String,
}

/// The keys an application reads from Secrets and ConfigMaps, each
/// once, in order: in its spec.env, and in the variables Cirrus gives
/// it for its secrets and shared values (environment.rs).
pub fn references(app: &WebApplication, given: &[EnvVar]) -> Vec<Reference> {
    let found: BTreeSet<Reference> = given
        .iter()
        .chain(app.spec.env.iter())
        .filter_map(|variable| variable.value_from.as_ref())
        .filter_map(|from| {
            if let Some(secret) = &from.secret_key_ref {
                Some(Reference {
                    source: Source::Secret,
                    name: secret.name.clone(),
                    key: secret.key.clone(),
                })
            } else {
                from.config_map_key_ref.as_ref().map(|config| Reference {
                    source: Source::ConfigMap,
                    name: config.name.clone(),
                    key: config.key.clone(),
                })
            }
        })
        .collect();
    found.into_iter().collect()
}

/// Whether an application reads anything from an object, for the
/// controller to look at it again when that changes.
pub fn references_object(app: &WebApplication, source: Source, name: &str) -> bool {
    let own = environment::secret_name(&app.metadata.name.clone().unwrap_or_default());
    (source == Source::Secret && name == own && !app.spec.secrets.is_empty())
        || (name == environment::SHARED && !app.spec.shared.is_empty())
        || references(app, &[])
            .iter()
            .any(|reference| reference.source == source && reference.name == name)
}

/// The hash of what was read: each reference with its value, or with
/// nothing when it isn't there.
pub fn digest(values: &[(Reference, Option<Vec<u8>>)]) -> String {
    let mut hasher = Sha256::new();
    for (reference, value) in values {
        hasher.update(format!("{:?}\0{}\0{}\0", reference.source, reference.name, reference.key).as_bytes());
        match value {
            Some(bytes) => {
                hasher.update(b"1");
                hasher.update((bytes.len() as u64).to_be_bytes());
                hasher.update(bytes);
            }
            None => hasher.update(b"0"),
        }
    }
    let digest = hasher.finalize();
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// The hash of everything an application reads from Secrets and
/// ConfigMaps, or nothing when it reads nothing.
pub async fn compute(
    client: &Client,
    namespace: &str,
    app: &WebApplication,
    given: &[EnvVar],
) -> Result<Option<String>> {
    let wanted = references(app, given);
    if wanted.is_empty() {
        return Ok(None);
    }
    let secrets = Api::<Secret>::namespaced(client.clone(), namespace);
    let config_maps = Api::<ConfigMap>::namespaced(client.clone(), namespace);
    let mut values = Vec::with_capacity(wanted.len());
    for reference in wanted {
        let value = match reference.source {
            Source::Secret => secrets
                .get_opt(&reference.name)
                .await?
                .and_then(|secret| secret.data)
                .and_then(|mut data| data.remove(&reference.key))
                .map(|bytes| bytes.0),
            Source::ConfigMap => config_maps.get_opt(&reference.name).await?.and_then(|config| {
                config
                    .data
                    .and_then(|mut data| data.remove(&reference.key))
                    .map(String::into_bytes)
                    .or_else(|| {
                        config
                            .binary_data
                            .and_then(|mut data| data.remove(&reference.key))
                            .map(|bytes| bytes.0)
                    })
            }),
        };
        values.push((reference, value));
    }
    Ok(Some(digest(&values)))
}

/// Puts the hash on the Deployment's pod template.
pub fn annotate(deployment: &mut Deployment, hash: Option<String>) {
    let Some(hash) = hash else { return };
    if let Some(template) = deployment.spec.as_mut().map(|spec| &mut spec.template) {
        template
            .metadata
            .get_or_insert_with(Default::default)
            .annotations
            .get_or_insert_with(Default::default)
            .insert(ANNOTATION.to_string(), hash);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::WebApplicationSpec;
    use k8s_openapi::api::core::v1::{ConfigMapKeySelector, EnvVarSource, SecretKeySelector};

    fn app(env: Vec<EnvVar>) -> WebApplication {
        let mut app = WebApplication::new(
            "shop",
            serde_json::from_value::<WebApplicationSpec>(serde_json::json!({"image": {"repository": "shop"}})).unwrap(),
        );
        app.spec.env = env;
        app
    }

    fn from_secret(name: &str, secret: &str, key: &str) -> EnvVar {
        EnvVar {
            name: name.to_string(),
            value_from: Some(EnvVarSource {
                secret_key_ref: Some(SecretKeySelector {
                    name: secret.to_string(),
                    key: key.to_string(),
                    optional: None,
                }),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn from_config(name: &str, config: &str, key: &str) -> EnvVar {
        EnvVar {
            name: name.to_string(),
            value_from: Some(EnvVarSource {
                config_map_key_ref: Some(ConfigMapKeySelector {
                    name: config.to_string(),
                    key: key.to_string(),
                    optional: None,
                }),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn only_what_it_reads_from_secrets_and_config_maps_counts() {
        let app = app(vec![
            EnvVar {
                name: "LOG_LEVEL".to_string(),
                value: Some("info".to_string()),
                ..Default::default()
            },
            from_secret("STRIPE_KEY", "shop-secrets", "STRIPE_KEY"),
            from_config("SMTP_HOST", "community-cloud-env", "SMTP_HOST"),
            // The same key twice is read once
            from_config("MAIL_HOST", "community-cloud-env", "SMTP_HOST"),
        ]);
        assert_eq!(
            references(&app, &[]),
            vec![
                Reference {
                    source: Source::Secret,
                    name: "shop-secrets".into(),
                    key: "STRIPE_KEY".into()
                },
                Reference {
                    source: Source::ConfigMap,
                    name: "community-cloud-env".into(),
                    key: "SMTP_HOST".into()
                },
            ]
        );
        assert!(references_object(&app, Source::Secret, "shop-secrets"));
        assert!(!references_object(&app, Source::Secret, "community-cloud-env"));
    }

    #[test]
    fn its_secrets_and_shared_values_are_watched_too() {
        let mut app = app(vec![]);
        assert!(!references_object(&app, Source::Secret, "shop-secrets"));
        app.spec.secrets = vec![crate::crd::SecretValueSpec {
            name: "STRIPE_KEY".into(),
            description: String::new(),
        }];
        app.spec.shared = vec![crate::crd::SharedValueSpec {
            name: "SMTP_HOST".into(),
            variable: None,
        }];
        assert!(references_object(&app, Source::Secret, "shop-secrets"));
        assert!(references_object(&app, Source::ConfigMap, "community-cloud-env"));
        assert!(references_object(&app, Source::Secret, "community-cloud-env"));
    }

    #[test]
    fn a_changed_value_changes_the_hash_and_the_same_value_does_not() {
        let reference = Reference {
            source: Source::Secret,
            name: "shop-secrets".into(),
            key: "STRIPE_KEY".into(),
        };
        let old = digest(&[(reference.clone(), Some(b"sk_old".to_vec()))]);
        assert_eq!(old, digest(&[(reference.clone(), Some(b"sk_old".to_vec()))]));
        assert_ne!(old, digest(&[(reference.clone(), Some(b"sk_new".to_vec()))]));
        // Missing isn't the same as empty
        assert_ne!(
            digest(&[(reference.clone(), None)]),
            digest(&[(reference, Some(Vec::new()))])
        );
    }

    #[test]
    fn the_hash_goes_on_the_pod_template_and_nothing_means_no_annotation() {
        let mut deployment = Deployment {
            spec: Some(Default::default()),
            ..Default::default()
        };
        annotate(&mut deployment, None);
        assert!(deployment.spec.as_ref().unwrap().template.metadata.is_none());
        annotate(&mut deployment, Some("abc".into()));
        let annotations = deployment.spec.unwrap().template.metadata.unwrap().annotations.unwrap();
        assert_eq!(annotations.get(ANNOTATION).map(String::as_str), Some("abc"));
    }
}
