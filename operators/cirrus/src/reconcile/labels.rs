//! @file
//! What an image says it needs, through its Dockerfile's LABELs, filled
//! in where the WebApplication says nothing (CC-56).
//!
//! ```dockerfile
//! LABEL technology.community-cloud.postgres="true" \
//!       technology.community-cloud.migrate="[\"bin/rails\",\"db:migrate\"]" \
//!       technology.community-cloud.health="/up"
//! ```
//!
//! - postgres, rabbitmq, bucket: "true" is the same as the field being
//!   in the spec with its defaults. Anything else asks for nothing.
//! - migrate: migrations.command, as a JSON array (exec form), or a
//!   string run with /bin/sh -c.
//! - health: healthCheck.path.
//!
//! They're the same labels Meteorologist's MCP tools hand an agent to
//! write into a Dockerfile (ui/meteorologist/src/lib/webapp/labels.ts),
//! and the two change together.
//!
//! The rules:
//!
//! - The spec wins. A field it sets is used as it is, and a label for
//!   it is ignored. `spec.detect: false` ignores every label.
//! - Labels are read from the image being rolled out, before anything
//!   is provisioned for it, so a new image's database is there before
//!   its migrations run. They're read once per image, as the port is,
//!   since an image's config never changes under its digest.
//! - A service an image asked for stays asked for when a later image
//!   doesn't ask: taking a database away is a person's decision, made
//!   in the spec, never a side effect of a Dockerfile edit. The command
//!   and the path follow the image.
//! - What was filled in is in status.detected, with "image label" as
//!   its evidence, and the LabelsRead condition says what was used, or
//!   which labels it doesn't know.

use std::collections::BTreeMap;

use super::Context;
use crate::crd::{
    BucketSpec, DetectedStatus, Detection, HealthCheckSpec, MigrationsSpec, PostgresSpec, RabbitMqSpec, WebApplication,
};
use crate::error::{Error, Result};
use crate::registry::{ImageReference, Registry};

pub const PREFIX: &str = "technology.community-cloud.";
pub const EVIDENCE: &str = "image label";

const SERVICES: [&str; 3] = ["postgres", "rabbitmq", "bucket"];
const KNOWN: [&str; 5] = ["postgres", "rabbitmq", "bucket", "migrate", "health"];

/// What an image's labels ask for.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Asked {
    pub services: Vec<String>,
    pub migrate: Option<Vec<String>>,
    pub health: Option<String>,
    /// Labels under the prefix that aren't one of these
    pub unknown: Vec<String>,
    /// Labels it knows with a value it can't use, and why
    pub invalid: Vec<String>,
}

/// The labels under the prefix, from all an image's labels.
pub fn ours(labels: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    labels
        .iter()
        .filter(|(key, _)| key.starts_with(PREFIX))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// What labels ask for.
pub fn parse(labels: &BTreeMap<String, String>) -> Asked {
    let mut asked = Asked::default();
    for (key, value) in labels {
        let Some(name) = key.strip_prefix(PREFIX) else { continue };
        let value = value.trim();
        match name {
            service if SERVICES.contains(&service) => {
                if value.eq_ignore_ascii_case("true") {
                    asked.services.push(service.to_string());
                } else if !value.eq_ignore_ascii_case("false") {
                    asked
                        .invalid
                        .push(format!("{key} is \"{value}\", not \"true\" or \"false\""));
                }
            }
            "migrate" if value.starts_with('[') => match serde_json::from_str::<Vec<String>>(value) {
                Ok(command) if !command.is_empty() => asked.migrate = Some(command),
                _ => asked.invalid.push(format!("{key} isn't a JSON array of strings")),
            },
            "migrate" if !value.is_empty() => {
                asked.migrate = Some(vec!["/bin/sh".to_string(), "-c".to_string(), value.to_string()]);
            }
            "health" if value.starts_with('/') => asked.health = Some(value.to_string()),
            "migrate" | "health" => asked.invalid.push(format!(
                "{key} {}",
                if name == "health" {
                    "isn't a path starting with /"
                } else {
                    "is empty"
                }
            )),
            _ => asked.unknown.push(key.clone()),
        }
    }
    asked
}

/// Whether labels may fill anything in for this application.
pub fn enabled(app: &WebApplication) -> bool {
    app.spec.detect != Some(false)
}

/// The application as Cirrus runs it: its spec, with what the labels
/// ask for filled in where the spec says nothing, and what was filled
/// in.
///
/// `earlier` is what was filled in before, from other images: the
/// services it carries stay.
pub fn fill(
    app: &WebApplication,
    image: &str,
    asked: &Asked,
    earlier: &[Detection],
) -> (WebApplication, Vec<Detection>) {
    let mut effective = app.clone();
    let mut applied = Vec::new();
    if !enabled(app) {
        return (effective, applied);
    }
    let spec = &mut effective.spec;

    for service in SERVICES {
        let before = earlier.iter().find(|each| each.field == service);
        let now = asked.services.iter().any(|each| each == service);
        let unset = match service {
            "postgres" => spec.postgres.is_none(),
            "rabbitmq" => spec.rabbitmq.is_none(),
            _ => spec.bucket.is_none(),
        };
        if !unset || (before.is_none() && !now) {
            continue;
        }
        match service {
            "postgres" => spec.postgres = Some(PostgresSpec::default()),
            "rabbitmq" => spec.rabbitmq = Some(RabbitMqSpec::default()),
            _ => spec.bucket = Some(BucketSpec::default()),
        }
        applied.push(Detection {
            field: service.to_string(),
            value: None,
            evidence: EVIDENCE.to_string(),
            // Where it was first asked for
            image: before.map_or_else(|| image.to_string(), |each| each.image.clone()),
        });
    }

    if let (None, Some(command)) = (&spec.migrations, &asked.migrate) {
        spec.migrations = Some(MigrationsSpec {
            command: command.clone(),
            ..MigrationsSpec::default()
        });
        applied.push(Detection {
            field: "migrations.command".to_string(),
            value: Some(serde_json::to_string(command).unwrap_or_default()),
            evidence: EVIDENCE.to_string(),
            image: image.to_string(),
        });
    }
    if let (None, Some(path)) = (&spec.health_check, &asked.health) {
        spec.health_check = Some(HealthCheckSpec { path: path.clone() });
        applied.push(Detection {
            field: "healthCheck.path".to_string(),
            value: Some(path.clone()),
            evidence: EVIDENCE.to_string(),
            image: image.to_string(),
        });
    }
    (effective, applied)
}

/// A sentence for the LabelsRead condition: what was used, or what's
/// wrong with the labels. The second is whether they're all good.
pub fn summary(asked: &Asked, applied: &[Detection]) -> (bool, String) {
    let mut problems = Vec::new();
    if !asked.unknown.is_empty() {
        problems.push(format!(
            "{} {} a label Cirrus doesn't know (it knows {})",
            asked.unknown.join(", "),
            if asked.unknown.len() == 1 { "isn't" } else { "aren't" },
            KNOWN.map(|name| format!("{PREFIX}{name}")).join(", ")
        ));
    }
    problems.extend(asked.invalid.iter().cloned());
    if !problems.is_empty() {
        return (false, problems.join("; "));
    }
    if applied.is_empty() {
        return (
            true,
            "the image's labels fill in nothing the spec doesn't already say".to_string(),
        );
    }
    let fields: Vec<&str> = applied.iter().map(|each| each.field.as_str()).collect();
    (true, format!("from the image's labels: {}", fields.join(", ")))
}

/// The image's labels under the prefix, from an earlier pass when it
/// was the same image, or else from its registry.
pub async fn read(
    ctx: &Context,
    app: &WebApplication,
    image: &str,
    earlier: Option<&DetectedStatus>,
) -> Result<std::result::Result<BTreeMap<String, String>, String>> {
    if let Some(earlier) = earlier.filter(|earlier| earlier.image == image) {
        return Ok(Ok(earlier.labels.clone()));
    }
    let reference = match ImageReference::parse(image) {
        Ok(reference) => reference,
        Err(error) => return Ok(Err(error.to_string())),
    };
    let credentials = super::port::credentials(ctx, app, &reference.registry).await?;
    match Registry::new(reference, credentials).labels().await {
        Ok(labels) => Ok(Ok(ours(&labels))),
        Err(Error::Registry(problem)) => Ok(Err(format!(
            "couldn't read the labels of {image}, so what they filled in before stands until it can: {problem}"
        ))),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::WebApplicationSpec;

    fn labels(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (format!("{PREFIX}{key}"), value.to_string()))
            .collect()
    }

    fn app(spec: serde_json::Value) -> WebApplication {
        let mut spec = spec;
        spec["image"] = serde_json::json!({"repository": "shop"});
        WebApplication::new("shop", serde_json::from_value::<WebApplicationSpec>(spec).unwrap())
    }

    #[test]
    fn reads_what_the_labels_ask_for() {
        let asked = parse(&labels(&[
            ("postgres", "true"),
            ("rabbitmq", "false"),
            ("migrate", r#"["bin/rails", "db:migrate"]"#),
            ("health", "/up"),
        ]));
        assert_eq!(asked.services, vec!["postgres".to_string()]);
        assert_eq!(asked.migrate, Some(vec!["bin/rails".into(), "db:migrate".into()]));
        assert_eq!(asked.health.as_deref(), Some("/up"));
        assert!(asked.unknown.is_empty() && asked.invalid.is_empty());
    }

    #[test]
    fn a_migrate_string_runs_in_a_shell() {
        let asked = parse(&labels(&[("migrate", "npm run migrate && echo done")]));
        assert_eq!(
            asked.migrate,
            Some(vec![
                "/bin/sh".into(),
                "-c".into(),
                "npm run migrate && echo done".into()
            ])
        );
    }

    #[test]
    fn says_what_it_doesnt_know_or_cant_use() {
        let asked = parse(&labels(&[("redis", "true"), ("postgres", "yes"), ("health", "up")]));
        assert_eq!(asked.unknown, vec![format!("{PREFIX}redis")]);
        assert_eq!(asked.invalid.len(), 2);
        let (ok, message) = summary(&asked, &[]);
        assert!(!ok);
        assert!(message.contains("redis"));
    }

    #[test]
    fn other_labels_are_left_alone() {
        let all = BTreeMap::from([
            ("org.opencontainers.image.source".to_string(), "x".to_string()),
            (format!("{PREFIX}postgres"), "true".to_string()),
        ]);
        assert_eq!(ours(&all).len(), 1);
    }

    #[test]
    fn labels_fill_in_what_the_spec_leaves_out() {
        let asked = parse(&labels(&[
            ("postgres", "true"),
            ("migrate", r#"["migrate"]"#),
            ("health", "/up"),
        ]));
        let (effective, applied) = fill(&app(serde_json::json!({})), "shop:1", &asked, &[]);
        assert!(effective.spec.postgres.is_some());
        assert_eq!(effective.spec.migrations.unwrap().command, vec!["migrate".to_string()]);
        assert_eq!(effective.spec.health_check.unwrap().path, "/up");
        assert_eq!(
            applied.iter().map(|each| each.field.as_str()).collect::<Vec<_>>(),
            vec!["postgres", "migrations.command", "healthCheck.path"]
        );
        assert!(
            applied
                .iter()
                .all(|each| each.evidence == "image label" && each.image == "shop:1")
        );
    }

    #[test]
    fn the_spec_wins() {
        let asked = parse(&labels(&[("migrate", r#"["from-label"]"#), ("health", "/label")]));
        let spec = app(serde_json::json!({
            "migrations": {"command": ["from-spec"]},
            "healthCheck": {"path": "/spec"},
        }));
        let (effective, applied) = fill(&spec, "shop:1", &asked, &[]);
        assert_eq!(
            effective.spec.migrations.unwrap().command,
            vec!["from-spec".to_string()]
        );
        assert_eq!(effective.spec.health_check.unwrap().path, "/spec");
        assert!(applied.is_empty());
    }

    #[test]
    fn detect_false_ignores_every_label() {
        let asked = parse(&labels(&[("postgres", "true")]));
        let (effective, applied) = fill(&app(serde_json::json!({"detect": false})), "shop:1", &asked, &[]);
        assert!(effective.spec.postgres.is_none());
        assert!(applied.is_empty());
    }

    #[test]
    fn a_service_stays_when_a_later_image_stops_asking() {
        let first = parse(&labels(&[("postgres", "true"), ("health", "/up")]));
        let (_, earlier) = fill(&app(serde_json::json!({})), "shop:1", &first, &[]);
        let (effective, applied) = fill(&app(serde_json::json!({})), "shop:2", &Asked::default(), &earlier);
        assert!(effective.spec.postgres.is_some());
        // The path follows the image
        assert!(effective.spec.health_check.is_none());
        assert_eq!(applied[0].image, "shop:1");
    }
}
