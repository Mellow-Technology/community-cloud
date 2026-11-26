//! @file
//! An application's secrets and the namespace's shared values, as
//! environment variables.
//!
//! - `spec.secrets` names the application's own secrets. Their values
//!   are in the Secret `<app>-secrets`, under the same names, which
//!   Meteorologist writes and the WebApplication owns. Each is set as a
//!   variable of its name.
//! - `spec.shared` names values the namespace keeps once for all its
//!   applications: plain ones in the ConfigMap `community-cloud-env`,
//!   secret ones in the Secret of the same name. Which it is is the
//!   namespace's to say, so it's looked up here, and each is set as a
//!   variable of its name or the one given in `as`.
//!
//! Every variable refers to its value (configMapKeyRef, secretKeyRef)
//! rather than copying it, so nothing secret goes into the Deployment,
//! and config_hash.rs restarts the application when one changes.
//!
//! A value that isn't there stops the rollout, as a missing database
//! does, and Provisioned says which and where to set it: the pods
//! wouldn't start without it. That's also how an application can ask
//! for a secret nobody has given it yet, such as one an agent found it
//! needs, and wait for a person to fill it in. Which values are there,
//! never what they are, is kept in status.environment, for those who
//! may read the application and not its Secrets.

use std::collections::BTreeSet;

use k8s_openapi::api::core::v1::{ConfigMap, ConfigMapKeySelector, EnvVar, EnvVarSource, Secret, SecretKeySelector};
use kube::Api;

use super::{Context, Outcome, Provided};
use crate::crd::{EnvironmentStatus, ValueStatus, WebApplication};
use crate::error::{Error, Result};

/// Where the namespace's shared values are: a ConfigMap and a Secret
/// of this name.
pub const SHARED: &str = "community-cloud-env";

/// The Secret an application's own secrets are kept in.
pub fn secret_name(app: &str) -> String {
    format!("{app}-secrets")
}

/// What there is to read the values from: the keys of the
/// application's Secret, and of the namespace's shared ConfigMap and
/// Secret. A Secret or ConfigMap that isn't there has none.
#[derive(Clone, Debug, Default)]
pub struct Available {
    pub own: BTreeSet<String>,
    pub shared_plain: BTreeSet<String>,
    pub shared_secret: BTreeSet<String>,
}

/// What the application's secrets and shared values come to.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Resolved {
    pub env: Vec<EnvVar>,
    pub status: EnvironmentStatus,
    /// Each one without a value, as a person would fix it
    pub missing: Vec<String>,
    /// Names that can't be variables
    pub invalid: Vec<String>,
}

// What Kubernetes takes as a variable's name
fn valid_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || matches!(first, '_' | '-' | '.'))
        && characters.all(|each| each.is_ascii_alphanumeric() || matches!(each, '_' | '-' | '.'))
}

fn from_secret(variable: &str, secret: &str, key: &str) -> EnvVar {
    EnvVar {
        name: variable.to_string(),
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

fn from_config_map(variable: &str, config_map: &str, key: &str) -> EnvVar {
    EnvVar {
        name: variable.to_string(),
        value_from: Some(EnvVarSource {
            config_map_key_ref: Some(ConfigMapKeySelector {
                name: config_map.to_string(),
                key: key.to_string(),
                optional: None,
            }),
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// The variables, and what's missing, from what there is.
pub fn resolve(app: &WebApplication, available: &Available) -> Resolved {
    let name = app.metadata.name.clone().unwrap_or_default();
    let own = secret_name(&name);
    let mut resolved = Resolved::default();

    for secret in &app.spec.secrets {
        if !valid_name(&secret.name) {
            resolved.invalid.push(secret.name.clone());
            continue;
        }
        let set = available.own.contains(&secret.name);
        resolved.status.secrets.push(ValueStatus {
            name: secret.name.clone(),
            set,
            kind: None,
        });
        if set {
            resolved.env.push(from_secret(&secret.name, &own, &secret.name));
        } else {
            resolved.missing.push(format!(
                "the secret {} has no value yet: set it on the application's page in Meteorologist",
                secret.name
            ));
        }
    }

    for shared in &app.spec.shared {
        let variable = shared.variable();
        if !valid_name(variable) {
            resolved.invalid.push(variable.to_string());
            continue;
        }
        // Plain first: Meteorologist keeps a name to one or the other
        let kind = if available.shared_plain.contains(&shared.name) {
            resolved.env.push(from_config_map(variable, SHARED, &shared.name));
            Some("plain")
        } else if available.shared_secret.contains(&shared.name) {
            resolved.env.push(from_secret(variable, SHARED, &shared.name));
            Some("secret")
        } else {
            resolved.missing.push(format!(
                "the namespace shares no value called {}: add it on the namespace's Environment tab in Meteorologist",
                shared.name
            ));
            None
        };
        resolved.status.shared.push(ValueStatus {
            name: shared.name.clone(),
            set: kind.is_some(),
            kind: kind.map(str::to_string),
        });
    }
    resolved
}

/// The keys of a Secret, or none when it isn't there.
async fn secret_keys(api: &Api<Secret>, name: &str) -> Result<BTreeSet<String>> {
    Ok(api
        .get_opt(name)
        .await?
        .and_then(|secret| secret.data)
        .map(|data| data.into_keys().collect())
        .unwrap_or_default())
}

/// Reads what there is, and gives the variables, or why it can't yet.
/// The status is given either way.
pub async fn ensure(ctx: &Context, app: &WebApplication) -> (Result<Outcome>, EnvironmentStatus) {
    let (namespace, name) = super::identity(app);
    let secrets = Api::<Secret>::namespaced(ctx.client.clone(), &namespace);
    let read = async {
        let own = if app.spec.secrets.is_empty() {
            BTreeSet::new()
        } else {
            secret_keys(&secrets, &secret_name(&name)).await?
        };
        let (shared_plain, shared_secret) = if app.spec.shared.is_empty() {
            (BTreeSet::new(), BTreeSet::new())
        } else {
            let config = Api::<ConfigMap>::namespaced(ctx.client.clone(), &namespace)
                .get_opt(SHARED)
                .await?;
            let plain = config
                .map(|config| {
                    config
                        .data
                        .unwrap_or_default()
                        .into_keys()
                        .chain(config.binary_data.unwrap_or_default().into_keys())
                        .collect()
                })
                .unwrap_or_default();
            (plain, secret_keys(&secrets, SHARED).await?)
        };
        Ok::<_, Error>(Available {
            own,
            shared_plain,
            shared_secret,
        })
    };
    let available = match read.await {
        Ok(available) => available,
        Err(error) => return (Err(error), EnvironmentStatus::default()),
    };
    let resolved = resolve(app, &available);
    let outcome = if !resolved.invalid.is_empty() {
        Err(Error::NotPermitted(format!(
            "{} can't be an environment variable's name",
            resolved.invalid.join(", ")
        )))
    } else if !resolved.missing.is_empty() {
        Err(Error::NotPermitted(resolved.missing.join("; ")))
    } else {
        Ok(Outcome::Ready(Provided {
            env_from: Vec::new(),
            env: resolved.env,
        }))
    };
    (outcome, resolved.status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{SecretValueSpec, SharedValueSpec, WebApplicationSpec};

    fn app(secrets: &[&str], shared: &[(&str, Option<&str>)]) -> WebApplication {
        let mut app = WebApplication::new(
            "shop",
            serde_json::from_value::<WebApplicationSpec>(serde_json::json!({"image": {"repository": "shop"}})).unwrap(),
        );
        app.spec.secrets = secrets
            .iter()
            .map(|name| SecretValueSpec {
                name: name.to_string(),
                description: String::new(),
            })
            .collect();
        app.spec.shared = shared
            .iter()
            .map(|(name, variable)| SharedValueSpec {
                name: name.to_string(),
                variable: variable.map(str::to_string),
            })
            .collect();
        app
    }

    fn keys(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn its_secrets_are_read_from_its_own_secret() {
        let resolved = resolve(
            &app(&["STRIPE_KEY"], &[]),
            &Available {
                own: keys(&["STRIPE_KEY"]),
                ..Available::default()
            },
        );
        assert!(resolved.missing.is_empty());
        let reference = resolved.env[0]
            .value_from
            .as_ref()
            .unwrap()
            .secret_key_ref
            .as_ref()
            .unwrap();
        assert_eq!(
            (reference.name.as_str(), reference.key.as_str()),
            ("shop-secrets", "STRIPE_KEY")
        );
        assert!(resolved.status.secrets[0].set);
    }

    #[test]
    fn a_secret_without_a_value_is_missing_and_says_where_to_set_it() {
        let resolved = resolve(&app(&["STRIPE_KEY"], &[]), &Available::default());
        assert!(resolved.env.is_empty());
        assert!(resolved.missing[0].contains("STRIPE_KEY"));
        assert!(resolved.missing[0].contains("application's page"));
        assert!(!resolved.status.secrets[0].set);
    }

    #[test]
    fn a_shared_value_is_found_as_plain_or_secret_and_can_be_renamed() {
        let resolved = resolve(
            &app(&[], &[("SMTP_HOST", None), ("SENDGRID", Some("MAIL_KEY"))]),
            &Available {
                shared_plain: keys(&["SMTP_HOST"]),
                shared_secret: keys(&["SENDGRID"]),
                ..Available::default()
            },
        );
        assert!(resolved.missing.is_empty());
        let plain = &resolved.env[0];
        assert_eq!(plain.name, "SMTP_HOST");
        assert!(plain.value_from.as_ref().unwrap().config_map_key_ref.is_some());
        let secret = &resolved.env[1];
        assert_eq!(secret.name, "MAIL_KEY");
        assert_eq!(
            secret.value_from.as_ref().unwrap().secret_key_ref.as_ref().unwrap().key,
            "SENDGRID"
        );
        assert_eq!(resolved.status.shared[1].kind.as_deref(), Some("secret"));
    }

    #[test]
    fn a_shared_value_the_namespace_lacks_is_missing() {
        let resolved = resolve(&app(&[], &[("SMTP_HOST", None)]), &Available::default());
        assert!(resolved.missing[0].contains("Environment tab"));
        assert_eq!(
            resolved.status.shared[0],
            ValueStatus {
                name: "SMTP_HOST".into(),
                set: false,
                kind: None
            }
        );
    }

    #[test]
    fn a_name_that_cant_be_a_variable_is_refused() {
        let resolved = resolve(&app(&["1BAD"], &[("ok", Some("has space"))]), &Available::default());
        assert_eq!(resolved.invalid, vec!["1BAD".to_string(), "has space".to_string()]);
    }
}
