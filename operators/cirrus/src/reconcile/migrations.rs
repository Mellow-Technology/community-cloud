//! @file
//! Migrations, run to completion with the new image before the
//! Deployment is given it.
//!
//! The order matters: the new code expects the new schema, and the
//! old code is what keeps serving while the migration runs. So a
//! migration that fails leaves the old version running and says so,
//! rather than rolling out something that can't start.
//!
//! The Job is named for the image, so each image's migrations run
//! once — re-reconciling finds the same Job instead of starting
//! another. To run them again for the same image, delete the Job.
//! Finished Jobs are cleared after a day, by which time the image is
//! recorded as deployed and nothing asks for the Job again.

use k8s_openapi::api::batch::v1::{Job, JobSpec};
use k8s_openapi::api::core::v1::{EnvVar, PodSpec, PodTemplateSpec};
use kube::Api;
use kube::api::{ObjectMeta, PostParams};

use super::{Context, owner_reference, workload};
use crate::crd::{WebApplication, labels};
use crate::error::Result;
use crate::naming::short_hash;

// Long enough for a migration over a large table, short enough that a
// hung one is noticed the same day
const DEFAULT_TIMEOUT_SECONDS: i64 = 30 * 60;

// One retry, for a database that was briefly unreachable. More than
// that and a broken migration is just run over and over.
const BACKOFF_LIMIT: i32 = 1;

const TTL_SECONDS: i32 = 24 * 60 * 60;

#[derive(Debug, PartialEq)]
pub enum JobState {
    Running,
    Succeeded,
    Failed(String),
}

pub fn job_name(app_name: &str, image: &str) -> String {
    // A Job's name becomes a label on its pods, so it has to fit in 63
    let prefix: String = app_name.chars().take(40).collect();
    format!("{prefix}-migrate-{}", short_hash(image, 10))
}

pub fn build(app: &WebApplication, image: &str, env_from: &[String], env: &[EnvVar]) -> Job {
    let (namespace, name) = super::identity(app);
    let migrations = app.spec.migrations.clone().unwrap_or_default();
    let mut container = workload::container(app, image, env_from, env);
    container.name = "migrate".to_string();
    container.command = Some(migrations.command.clone());
    container.args = (!migrations.args.is_empty()).then(|| migrations.args.clone());
    Job {
        metadata: ObjectMeta {
            name: Some(job_name(&name, image)),
            namespace: Some(namespace),
            labels: Some(labels(&name)),
            owner_references: Some(vec![owner_reference(app)]),
            ..Default::default()
        },
        spec: Some(JobSpec {
            backoff_limit: Some(BACKOFF_LIMIT),
            active_deadline_seconds: Some(migrations.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS)),
            ttl_seconds_after_finished: Some(TTL_SECONDS),
            template: PodTemplateSpec {
                metadata: Some(ObjectMeta {
                    labels: Some(labels(&name)),
                    ..Default::default()
                }),
                spec: Some(PodSpec {
                    containers: vec![container],
                    restart_policy: Some("Never".to_string()),
                    image_pull_secrets: workload::pull_secrets(app),
                    ..Default::default()
                }),
            },
            ..Default::default()
        }),
        ..Default::default()
    }
}

pub fn state(job: &Job) -> JobState {
    let conditions = job
        .status
        .as_ref()
        .and_then(|s| s.conditions.clone())
        .unwrap_or_default();
    for condition in conditions {
        if condition.status != "True" {
            continue;
        }
        match condition.type_.as_str() {
            "Complete" => return JobState::Succeeded,
            "Failed" => {
                return JobState::Failed(
                    condition
                        .message
                        .unwrap_or_else(|| "the migration Job failed".to_string()),
                );
            }
            _ => {}
        }
    }
    JobState::Running
}

/// Start the migrations for `image` if they haven't been, and say how
/// they're going.
pub async fn ensure(
    ctx: &Context,
    app: &WebApplication,
    image: &str,
    env_from: &[String],
    env: &[EnvVar],
) -> Result<(String, JobState)> {
    let (namespace, name) = super::identity(app);
    let jobs = Api::<Job>::namespaced(ctx.client.clone(), &namespace);
    let job_name = job_name(&name, image);
    let job = match jobs.get_opt(&job_name).await? {
        Some(job) => job,
        None => {
            jobs.create(&PostParams::default(), &build(app, image, env_from, env))
                .await?
        }
    };
    Ok((job_name, state(&job)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::MigrationsSpec;
    use crate::reconcile::tests::app;

    #[test]
    fn named_for_the_image() {
        let a = job_name("shop", "r@sha256:1");
        assert!(a.starts_with("shop-migrate-"));
        assert_ne!(a, job_name("shop", "r@sha256:2"));
        assert!(job_name(&"x".repeat(80), "i").len() <= 63);
    }

    #[test]
    fn runs_the_command_once_with_the_new_image() {
        let mut app = app();
        app.spec.migrations = Some(MigrationsSpec {
            command: vec!["bin/migrate".into()],
            ..Default::default()
        });
        let job = build(&app, "r@sha256:1", &[], &[]);
        let spec = job.spec.unwrap();
        assert_eq!(spec.backoff_limit, Some(1));
        let pod = spec.template.spec.unwrap();
        assert_eq!(pod.restart_policy.as_deref(), Some("Never"));
        assert_eq!(pod.containers[0].command.as_ref().unwrap()[0], "bin/migrate");
        assert_eq!(pod.containers[0].image.as_deref(), Some("r@sha256:1"));
    }
}
