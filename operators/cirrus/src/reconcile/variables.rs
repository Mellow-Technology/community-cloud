//! @file
//! Which environment variables an application is given, and where each
//! comes from, kept in status.variables.
//!
//! The README and Meteorologist's agent instructions say what each
//! service sets in general. This is what this application is actually
//! given: S3_PUBLIC_ENDPOINT only where the cluster serves S3 outside, a
//! connection's variables under the name it was given, the secrets and
//! shared values it reads. So whoever configures it, a person or an
//! agent, can map its settings onto real names without guessing.
//!
//! A plain value is shown, as it's in the Deployment for anyone who can
//! read that. Anything from a Secret is named, never read: a Secret
//! loaded whole (Postgres's, RabbitMQ's) is listed by its keys.
//!
//! The order is the container's, and so is the precedence: Secrets
//! loaded whole first, then single variables in the order Cirrus adds
//! them, then spec.env, a later one with the same name replacing an
//! earlier one, as it does in the pod.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::EnvVar;

use super::environment::SHARED;
use crate::crd::VariableStatus;

/// What one dependency gave the application.
#[derive(Clone, Debug, Default)]
pub struct Origin {
    /// What gave it: postgres, bucket, rabbitmq, connections, environment
    pub source: String,
    pub env: Vec<EnvVar>,
    /// Secrets loaded whole, by name
    pub env_from: Vec<String>,
}

/// Where a variable comes from, as shown: the dependency, or for the
/// application's own environment, which kind.
fn from(source: &str, variable: &EnvVar) -> String {
    if source != "environment" {
        return source.to_string();
    }
    let reads = variable.value_from.as_ref();
    let shared = reads.and_then(|from| from.config_map_key_ref.as_ref()).is_some()
        || reads
            .and_then(|from| from.secret_key_ref.as_ref())
            .is_some_and(|secret| secret.name == SHARED);
    if shared { "shared" } else { "secrets" }.to_string()
}

/// A variable as listed: its value only when it's a plain one.
fn status(name: &str, from: String, variable: Option<&EnvVar>) -> VariableStatus {
    let reads = variable.and_then(|each| each.value_from.as_ref());
    VariableStatus {
        name: name.to_string(),
        from,
        value: variable.filter(|_| reads.is_none()).and_then(|each| each.value.clone()),
        secret: variable.is_none() || reads.and_then(|each| each.secret_key_ref.as_ref()).is_some(),
    }
}

/// Every variable the application is given, each once, in the
/// container's order.
///
/// `secret_keys` are the keys of the Secrets loaded whole, by Secret;
/// one not read yet contributes nothing.
pub fn list(
    origins: &[Origin],
    spec_env: &[EnvVar],
    secret_keys: &BTreeMap<String, Vec<String>>,
) -> Vec<VariableStatus> {
    let mut variables: Vec<VariableStatus> = Vec::new();
    let mut put = |each: VariableStatus| {
        variables.retain(|other| other.name != each.name);
        variables.push(each);
    };
    for origin in origins {
        for secret in &origin.env_from {
            for key in secret_keys.get(secret).into_iter().flatten() {
                put(status(key, origin.source.clone(), None));
            }
        }
    }
    for origin in origins {
        for variable in &origin.env {
            put(status(&variable.name, from(&origin.source, variable), Some(variable)));
        }
    }
    for variable in spec_env {
        put(status(&variable.name, "env".to_string(), Some(variable)));
    }
    variables
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{EnvVarSource, SecretKeySelector};

    fn plain(name: &str, value: &str) -> EnvVar {
        EnvVar {
            name: name.into(),
            value: Some(value.into()),
            ..Default::default()
        }
    }

    fn from_secret(name: &str, secret: &str) -> EnvVar {
        EnvVar {
            name: name.into(),
            value_from: Some(EnvVarSource {
                secret_key_ref: Some(SecretKeySelector {
                    name: secret.into(),
                    key: name.into(),
                    optional: None,
                }),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn lists_each_with_where_it_comes_from_and_only_plain_values() {
        let origins = vec![
            Origin {
                source: "postgres".into(),
                env: vec![],
                env_from: vec!["shop-postgres".into()],
            },
            Origin {
                source: "bucket".into(),
                env: vec![
                    plain("S3_BUCKET", "team-shop"),
                    from_secret("S3_SECRET_ACCESS_KEY", "shop-bucket"),
                ],
                env_from: vec![],
            },
            Origin {
                source: "environment".into(),
                env: vec![
                    from_secret("STRIPE_KEY", "shop-secrets"),
                    from_secret("MAIL_KEY", SHARED),
                ],
                env_from: vec![],
            },
        ];
        let keys = BTreeMap::from([("shop-postgres".to_string(), vec!["DATABASE_URL".to_string()])]);
        let listed = list(&origins, &[plain("LOG_LEVEL", "info")], &keys);
        let shown: Vec<(&str, &str, Option<&str>, bool)> = listed
            .iter()
            .map(|each| {
                (
                    each.name.as_str(),
                    each.from.as_str(),
                    each.value.as_deref(),
                    each.secret,
                )
            })
            .collect();
        assert_eq!(
            shown,
            vec![
                ("DATABASE_URL", "postgres", None, true),
                ("S3_BUCKET", "bucket", Some("team-shop"), false),
                ("S3_SECRET_ACCESS_KEY", "bucket", None, true),
                ("STRIPE_KEY", "secrets", None, true),
                ("MAIL_KEY", "shared", None, true),
                ("LOG_LEVEL", "env", Some("info"), false),
            ]
        );
    }

    #[test]
    fn a_later_one_replaces_an_earlier_one_of_the_same_name() {
        let origins = vec![Origin {
            source: "bucket".into(),
            env: vec![plain("S3_REGION", "us-east-1")],
            env_from: vec![],
        }];
        let listed = list(&origins, &[plain("S3_REGION", "eu-west-1")], &BTreeMap::new());
        assert_eq!(listed.len(), 1);
        assert_eq!(
            (listed[0].from.as_str(), listed[0].value.as_deref()),
            ("env", Some("eu-west-1"))
        );
    }
}
