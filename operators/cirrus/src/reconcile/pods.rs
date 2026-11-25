//! @file
//! How the application's pods are doing, as the `Healthy` condition.
//!
//! `Ready` says Cirrus finished its part: everything was provisioned
//! and the newest image rolled out. It says nothing about what happens
//! after that. A container that starts crash looping an hour later, a
//! node that can't pull the image after a reschedule, a pod that stops
//! passing its readiness check: none of those undo a rollout, so
//! they're read from the pods themselves.
//!
//! - Failing: no pod is serving, and at least one is stuck in a way
//!   waiting won't fix
//! - Degraded: something is serving, but a pod is stuck like that, or
//!   a container has restarted recently
//! - Starting: fewer pods ready than asked for, with nothing wrong yet
//!
//! Only the Deployment's pods count. The migration Job's are labelled
//! apart from them, and a failed migration is `RolledOut`'s to report.
//!
//! Built as a plain function of the pods and the time, so it can be
//! tested without a cluster.

use k8s_openapi::api::core::v1::{ContainerStatus, Pod};
use k8s_openapi::jiff::{SignedDuration, Timestamp};
use kube::api::{Api, ListParams};

use super::Context;
use crate::crd::{WebApplication, labels};
use crate::error::Result;

// Container waiting reasons that waiting longer won't fix. The
// kubelet's own names, as `kubectl get pods` shows them.
const STUCK_REASONS: [&str; 7] = [
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "InvalidImageName",
    "CreateContainerConfigError",
    "CreateContainerError",
    "RunContainerError",
];

// How long a running pod can fail its readiness check before that
// counts as a problem rather than a slow start
const NOT_READY_GRACE_MINUTES: i64 = 5;

// How long a restart counts against an application. Long enough to
// notice one that crashed and came back while nobody was looking;
// short enough that it clears by itself once it's stable again.
const RECENT_RESTART_MINUTES: i64 = 15;

// How many pods' problems a message names, before "and N more"
const PROBLEMS_NAMED: usize = 2;

#[derive(Debug, PartialEq)]
pub enum State {
    Healthy,
    Starting,
    Degraded,
    Failing,
}

#[derive(Debug, PartialEq)]
pub struct PodHealth {
    pub state: State,
    pub message: String,
}

impl PodHealth {
    pub fn reason(&self) -> &'static str {
        match self.state {
            State::Healthy => "PodsReady",
            State::Starting => "PodsStarting",
            State::Degraded => "PodsDegraded",
            State::Failing => "PodsFailing",
        }
    }
}

/// The application's own pods, from its Deployment.
pub async fn list(ctx: &Context, app: &WebApplication) -> Result<Vec<Pod>> {
    let (namespace, name) = super::identity(app);
    let selector = labels(&name)
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(",");
    let pods = Api::<Pod>::namespaced(ctx.client.clone(), &namespace)
        .list(&ListParams::default().labels(&selector))
        .await?;
    Ok(pods
        .items
        .into_iter()
        .filter(|pod| {
            pod.metadata
                .owner_references
                .iter()
                .flatten()
                .any(|owner| owner.kind == "ReplicaSet")
        })
        .collect())
}

/// How `pods` are doing, for an application asking for `replicas`.
pub fn assess(pods: &[Pod], replicas: i32, now: Timestamp) -> PodHealth {
    // A pod on its way out is the rollout's business
    let pods: Vec<&Pod> = pods
        .iter()
        .filter(|pod| pod.metadata.deletion_timestamp.is_none())
        .collect();
    let ready = pods.iter().filter(|pod| is_ready(pod)).count();
    let wanted = usize::try_from(replicas).unwrap_or_default();
    let counted = format!("{ready} of {wanted} pods ready");

    let stuck: Vec<String> = pods.iter().filter_map(|pod| stuck(pod, now)).collect();
    if !stuck.is_empty() {
        let state = if ready == 0 && wanted > 0 {
            State::Failing
        } else {
            State::Degraded
        };
        return PodHealth {
            state,
            message: format!("{counted}. {}", name_some(&stuck)),
        };
    }

    let restarted: Vec<String> = pods.iter().filter_map(|pod| restarted(pod, now)).collect();
    if !restarted.is_empty() {
        return PodHealth {
            state: State::Degraded,
            message: format!("{counted}. {}", name_some(&restarted)),
        };
    }

    if ready < wanted {
        return PodHealth {
            state: State::Starting,
            message: counted,
        };
    }
    PodHealth {
        state: State::Healthy,
        message: String::new(),
    }
}

fn is_ready(pod: &Pod) -> bool {
    condition(pod, "Ready").is_some_and(|ready| ready.status == "True")
}

fn condition<'a>(pod: &'a Pod, kind: &str) -> Option<&'a k8s_openapi::api::core::v1::PodCondition> {
    pod.status
        .as_ref()?
        .conditions
        .as_ref()?
        .iter()
        .find(|c| c.type_ == kind)
}

fn pod_name(pod: &Pod) -> &str {
    pod.metadata.name.as_deref().unwrap_or("a pod")
}

fn containers(pod: &Pod) -> impl Iterator<Item = &ContainerStatus> {
    let status = pod.status.as_ref();
    status
        .and_then(|s| s.init_container_statuses.as_ref())
        .into_iter()
        .flatten()
        .chain(status.and_then(|s| s.container_statuses.as_ref()).into_iter().flatten())
}

/// What's wrong with a pod that waiting won't fix, if anything.
fn stuck(pod: &Pod, now: Timestamp) -> Option<String> {
    let name = pod_name(pod);
    let status = pod.status.as_ref()?;

    if status.phase.as_deref() == Some("Failed") {
        let why = status
            .message
            .as_deref()
            .or(status.reason.as_deref())
            .unwrap_or("it stopped");
        return Some(format!("{name} failed: {why}"));
    }

    if let Some(scheduled) = condition(pod, "PodScheduled")
        && scheduled.status == "False"
        && scheduled.reason.as_deref() == Some("Unschedulable")
    {
        let why = scheduled.message.as_deref().unwrap_or("no node fits it");
        return Some(format!("{name} can't be scheduled: {why}"));
    }

    for container in containers(pod) {
        let Some(waiting) = container.state.as_ref().and_then(|state| state.waiting.as_ref()) else {
            continue;
        };
        let Some(reason) = waiting
            .reason
            .as_deref()
            .filter(|reason| STUCK_REASONS.contains(reason))
        else {
            continue;
        };
        let mut problem = format!("{name}: {reason}");
        // For a crash loop, why it last stopped says more than the
        // back-off message
        if let Some(last) = container
            .last_state
            .as_ref()
            .and_then(|state| state.terminated.as_ref())
        {
            let why = last.reason.as_deref().unwrap_or("exited");
            problem.push_str(&format!(" (last {why}, exit code {})", last.exit_code));
        } else if let Some(message) = waiting.message.as_deref() {
            problem.push_str(&format!(" ({message})"));
        }
        return Some(problem);
    }

    // Running, but not passing its readiness check, for long enough
    // that it isn't still starting
    if status.phase.as_deref() == Some("Running")
        && let Some(ready) = condition(pod, "Ready")
        && ready.status == "False"
        && ready
            .last_transition_time
            .as_ref()
            .is_some_and(|since| now.duration_since(since.0) >= SignedDuration::from_mins(NOT_READY_GRACE_MINUTES))
    {
        return Some(format!(
            "{name} has been running for over {NOT_READY_GRACE_MINUTES} minutes without passing its readiness check"
        ));
    }
    None
}

/// A container in the pod that restarted recently, if one did.
fn restarted(pod: &Pod, now: Timestamp) -> Option<String> {
    let name = pod_name(pod);
    containers(pod).find_map(|container| {
        let last = container.last_state.as_ref()?.terminated.as_ref()?;
        let finished = last.finished_at.as_ref()?.0;
        let ago = now.duration_since(finished);
        if ago > SignedDuration::from_mins(RECENT_RESTART_MINUTES) {
            return None;
        }
        let why = last.reason.as_deref().unwrap_or("exited");
        Some(format!(
            "{name} restarted {} minutes ago ({why}, exit code {}), {} restarts in all",
            ago.as_mins(),
            last.exit_code,
            container.restart_count
        ))
    })
}

fn name_some(problems: &[String]) -> String {
    let mut message = problems
        .iter()
        .take(PROBLEMS_NAMED)
        .cloned()
        .collect::<Vec<_>>()
        .join("; ");
    let more = problems.len().saturating_sub(PROBLEMS_NAMED);
    if more > 0 {
        message.push_str(&format!("; and {more} more"));
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> Timestamp {
        "2026-11-23T12:00:00Z".parse().unwrap()
    }

    // A pod from its status, as the API would hand it over
    fn pod(name: &str, status: serde_json::Value) -> Pod {
        serde_json::from_value(json!({
            "metadata": { "name": name },
            "status": status,
        }))
        .unwrap()
    }

    fn ready(name: &str) -> Pod {
        pod(
            name,
            json!({
                "phase": "Running",
                "conditions": [{ "type": "Ready", "status": "True" }],
                "containerStatuses": [{
                    "name": "app", "image": "i", "imageID": "", "ready": true, "restartCount": 0,
                    "state": { "running": {} }
                }]
            }),
        )
    }

    fn crash_looping(name: &str) -> Pod {
        pod(
            name,
            json!({
                "phase": "Running",
                "conditions": [{ "type": "Ready", "status": "False" }],
                "containerStatuses": [{
                    "name": "app", "image": "i", "imageID": "", "ready": false, "restartCount": 7,
                    "state": { "waiting": { "reason": "CrashLoopBackOff", "message": "back-off 5m0s" } },
                    "lastState": { "terminated": { "exitCode": 137, "reason": "OOMKilled" } }
                }]
            }),
        )
    }

    #[test]
    fn healthy_when_every_pod_is_ready() {
        let health = assess(&[ready("a"), ready("b")], 2, now());
        assert_eq!(health.state, State::Healthy);
        assert_eq!(health.reason(), "PodsReady");
    }

    #[test]
    fn starting_while_short_of_pods_with_nothing_wrong() {
        let health = assess(&[ready("a")], 2, now());
        assert_eq!(health.state, State::Starting);
        assert_eq!(health.message, "1 of 2 pods ready");
    }

    #[test]
    fn failing_when_nothing_serves_and_a_pod_is_stuck() {
        let health = assess(&[crash_looping("a")], 1, now());
        assert_eq!(health.state, State::Failing);
        assert_eq!(
            health.message,
            "0 of 1 pods ready. a: CrashLoopBackOff (last OOMKilled, exit code 137)"
        );
    }

    #[test]
    fn degraded_when_something_still_serves() {
        let health = assess(&[ready("a"), crash_looping("b")], 2, now());
        assert_eq!(health.state, State::Degraded);
        assert!(
            health.message.starts_with("1 of 2 pods ready. b: CrashLoopBackOff"),
            "{}",
            health.message
        );
    }

    #[test]
    fn image_pulls_and_scheduling_are_stuck_too() {
        let pulling = pod(
            "a",
            json!({
                "phase": "Pending",
                "containerStatuses": [{
                    "name": "app", "image": "i", "imageID": "", "ready": false, "restartCount": 0,
                    "state": { "waiting": { "reason": "ImagePullBackOff", "message": "pull access denied" } }
                }]
            }),
        );
        let health = assess(&[pulling], 1, now());
        assert_eq!(health.state, State::Failing);
        assert!(
            health.message.contains("a: ImagePullBackOff (pull access denied)"),
            "{}",
            health.message
        );

        let unschedulable = pod(
            "b",
            json!({
                "phase": "Pending",
                "conditions": [{
                    "type": "PodScheduled", "status": "False", "reason": "Unschedulable",
                    "message": "0/3 nodes are available: 3 Insufficient memory."
                }]
            }),
        );
        let health = assess(&[unschedulable], 1, now());
        assert_eq!(health.state, State::Failing);
        assert!(
            health.message.contains("b can't be scheduled: 0/3 nodes"),
            "{}",
            health.message
        );
    }

    #[test]
    fn a_recent_restart_is_degraded_and_an_old_one_isnt() {
        let restarted_at = |at: &str| {
            pod(
                "a",
                json!({
                    "phase": "Running",
                    "conditions": [{ "type": "Ready", "status": "True" }],
                    "containerStatuses": [{
                        "name": "app", "image": "i", "imageID": "", "ready": true, "restartCount": 1,
                        "state": { "running": {} },
                        "lastState": { "terminated": { "exitCode": 1, "reason": "Error", "finishedAt": at } }
                    }]
                }),
            )
        };
        let health = assess(&[restarted_at("2026-11-23T11:55:00Z")], 1, now());
        assert_eq!(health.state, State::Degraded);
        assert!(
            health
                .message
                .contains("a restarted 5 minutes ago (Error, exit code 1), 1 restarts in all")
        );

        assert_eq!(
            assess(&[restarted_at("2026-11-23T10:00:00Z")], 1, now()).state,
            State::Healthy
        );
    }

    #[test]
    fn not_ready_for_long_is_stuck_but_a_fresh_start_isnt() {
        let not_ready_since = |at: &str| {
            pod(
                "a",
                json!({
                    "phase": "Running",
                    "conditions": [{ "type": "Ready", "status": "False", "lastTransitionTime": at }]
                }),
            )
        };
        assert_eq!(
            assess(&[not_ready_since("2026-11-23T11:50:00Z")], 1, now()).state,
            State::Failing
        );
        assert_eq!(
            assess(&[not_ready_since("2026-11-23T11:58:00Z")], 1, now()).state,
            State::Starting
        );
    }

    #[test]
    fn pods_on_their_way_out_dont_count() {
        let mut leaving = crash_looping("old");
        leaving.metadata.deletion_timestamp = Some(k8s_openapi::apimachinery::pkg::apis::meta::v1::Time(now()));
        assert_eq!(assess(&[ready("a"), leaving], 1, now()).state, State::Healthy);
    }

    #[test]
    fn names_a_couple_and_counts_the_rest() {
        let pods = [crash_looping("a"), crash_looping("b"), crash_looping("c")];
        let health = assess(&pods, 3, now());
        assert!(health.message.ends_with("; and 1 more"), "{}", health.message);
    }
}
