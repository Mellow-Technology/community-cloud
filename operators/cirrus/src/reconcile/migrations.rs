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
//!
//! So a finished Job is kept until the next image's migrations start,
//! rather than cleared on a timer: a failed one cleared while its image
//! is still the one asked for would be started again, the migration
//! rerun with nobody asking. Keeping it also keeps its pod's logs.
//!
//! One migration at a time. A new image arriving while another's
//! migration runs waits for it to finish, since two migrations against
//! one database at once can leave the schema in neither's shape. A
//! running migration isn't stopped either: cut off partway, it can
//! leave things worse than letting it end.
//!
//! The Job's pods aren't labelled as the application's own. The
//! Service selects on those, and a migration pod with no readiness
//! check would be sent the application's traffic while it ran.

use std::collections::BTreeMap;

use k8s_openapi::api::batch::v1::{Job, JobSpec};
use k8s_openapi::api::core::v1::{EnvVar, PodSpec, PodTemplateSpec};
use kube::api::{DeleteParams, ListParams, ObjectMeta, PostParams};
use kube::{Api, ResourceExt};

use super::{Context, owner_reference, workload};
use crate::crd::WebApplication;
use crate::error::Result;
use crate::naming::short_hash;
use crate::resources::is_not_found;

// Long enough for a migration over a large table, short enough that a
// hung one is noticed the same day
const DEFAULT_TIMEOUT_SECONDS: i64 = 30 * 60;

// One retry, for a database that was briefly unreachable. More than
// that and a broken migration is just run over and over.
const BACKOFF_LIMIT: i32 = 1;

const PART_OF: &str = "app.kubernetes.io/part-of";
const COMPONENT: &str = "app.kubernetes.io/component";
const MANAGED_BY: &str = "app.kubernetes.io/managed-by";
const COMPONENT_NAME: &str = "migrations";

#[derive(Debug, PartialEq)]
pub enum JobState {
    Running,
    Succeeded,
    Failed(String),
    /// Another image's migration, named here, is still running.
    Waiting(String),
}

/// What a migration Job and its pods are labelled: the application's,
/// but not as its pods are.
pub fn job_labels(app_name: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        (PART_OF.to_string(), app_name.to_string()),
        (COMPONENT.to_string(), COMPONENT_NAME.to_string()),
        (MANAGED_BY.to_string(), "cirrus".to_string()),
    ])
}

fn job_selector(app_name: &str) -> String {
    format!("{PART_OF}={app_name},{COMPONENT}={COMPONENT_NAME},{MANAGED_BY}=cirrus")
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
            labels: Some(job_labels(&name)),
            owner_references: Some(vec![owner_reference(app)]),
            ..Default::default()
        },
        spec: Some(JobSpec {
            backoff_limit: Some(BACKOFF_LIMIT),
            active_deadline_seconds: Some(migrations.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS)),
            template: PodTemplateSpec {
                metadata: Some(ObjectMeta {
                    labels: Some(job_labels(&name)),
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

/// What to do about the migrations for one image, given the
/// application's migration Jobs.
#[derive(Debug, PartialEq)]
pub struct Plan {
    /// The image's own Job, if it's been started.
    pub current: Option<JobState>,
    /// Another image's Job that's still running, which the image's
    /// waits for.
    pub running: Option<String>,
    /// Other images' Jobs that have finished, to be cleared.
    pub finished: Vec<String>,
}

pub fn plan(job_name: &str, jobs: &[Job]) -> Plan {
    let mut plan = Plan {
        current: None,
        running: None,
        finished: Vec::new(),
    };
    for job in jobs {
        let name = job.name_any();
        let job_state = state(job);
        if name == job_name {
            plan.current = Some(job_state);
        } else if job_state == JobState::Running {
            plan.running.get_or_insert(name);
        } else {
            plan.finished.push(name);
        }
    }
    plan
}

/// Start the migrations for `image` if they haven't been and nothing
/// else is migrating, and say how they're going.
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
    let existing = jobs.list(&ListParams::default().labels(&job_selector(&name))).await?;
    let plan = plan(&job_name, &existing.items);

    // Earlier images' Jobs, finished, have nothing more to say
    for finished in &plan.finished {
        // In the background, so the Job's pod goes with it
        match jobs.delete(finished, &DeleteParams::background()).await {
            Ok(_) => {}
            Err(error) if is_not_found(&error) => {}
            Err(error) => return Err(error.into()),
        }
    }

    if let Some(job_state) = plan.current {
        return Ok((job_name, job_state));
    }
    if let Some(running) = plan.running {
        return Ok((running.clone(), JobState::Waiting(running)));
    }
    let job = jobs
        .create(&PostParams::default(), &build(app, image, env_from, env))
        .await?;
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

    #[test]
    fn kept_until_the_next_image() {
        // A failed Job cleared on a timer would be started again
        let job = build(&app(), "r@sha256:1", &[], &[]);
        assert_eq!(job.spec.unwrap().ttl_seconds_after_finished, None);
    }

    #[test]
    fn its_pods_are_not_the_applications() {
        // The Service selects the application's pods by name
        let job = build(&app(), "r@sha256:1", &[], &[]);
        let pod_labels = job.spec.unwrap().template.metadata.unwrap().labels.unwrap();
        let service_selector = crate::crd::selector("shop");
        assert!(
            service_selector
                .iter()
                .any(|(key, value)| pod_labels.get(key) != Some(value))
        );
        assert_eq!(pod_labels.get(PART_OF).map(String::as_str), Some("shop"));
    }

    fn job(name: &str, condition: Option<&str>) -> Job {
        let mut job = Job::default();
        job.metadata.name = Some(name.to_string());
        if let Some(type_) = condition {
            job.status = Some(k8s_openapi::api::batch::v1::JobStatus {
                conditions: Some(vec![k8s_openapi::api::batch::v1::JobCondition {
                    type_: type_.to_string(),
                    status: "True".to_string(),
                    ..Default::default()
                }]),
                ..Default::default()
            });
        }
        job
    }

    #[test]
    fn starts_when_nothing_else_is_migrating() {
        let plan = plan("shop-migrate-b", &[job("shop-migrate-a", Some("Complete"))]);
        assert_eq!(plan.current, None);
        assert_eq!(plan.running, None);
        assert_eq!(plan.finished, vec!["shop-migrate-a".to_string()]);
    }

    #[test]
    fn waits_for_another_images_migration() {
        let plan = plan("shop-migrate-b", &[job("shop-migrate-a", None)]);
        assert_eq!(plan.current, None);
        assert_eq!(plan.running.as_deref(), Some("shop-migrate-a"));
        assert!(plan.finished.is_empty());
    }

    #[test]
    fn a_failed_migration_is_reported_not_rerun() {
        let plan = plan("shop-migrate-a", &[job("shop-migrate-a", Some("Failed"))]);
        assert!(matches!(plan.current, Some(JobState::Failed(_))));
    }

    #[test]
    fn its_own_job_is_never_cleared() {
        let plan = plan(
            "shop-migrate-b",
            &[
                job("shop-migrate-a", Some("Failed")),
                job("shop-migrate-b", Some("Complete")),
            ],
        );
        assert_eq!(plan.current, Some(JobState::Succeeded));
        assert_eq!(plan.finished, vec!["shop-migrate-a".to_string()]);
    }
}
