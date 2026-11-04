//! @file
//! Status conditions, kept the way Kubernetes expects them.
//!
//! A condition's lastTransitionTime is when its status last changed,
//! not when it was last written, so setting one has to look at what
//! was there before. Without that, every reconcile would make the
//! condition look brand new and `kubectl wait` would be no help.

use k8s_openapi::apimachinery::pkg::apis::meta::v1::{Condition, Time};
use k8s_openapi::jiff::Timestamp;

pub const READY: &str = "Ready";
pub const PROVISIONED: &str = "Provisioned";
pub const ROLLED_OUT: &str = "RolledOut";
pub const WEBHOOK: &str = "WebhookRegistered";
pub const RELEASE_CHECKED: &str = "ReleaseChecked";

/// Set a condition in `conditions`, keeping its transition time when
/// its status hasn't changed.
pub fn set(
    conditions: &mut Vec<Condition>,
    kind: &str,
    ok: bool,
    reason: &str,
    message: impl Into<String>,
    generation: Option<i64>,
) {
    let status = if ok { "True" } else { "False" }.to_string();
    let previous = conditions.iter().position(|c| c.type_ == kind);
    let transition = match previous {
        Some(index) if conditions[index].status == status => conditions[index].last_transition_time.clone(),
        _ => Time(Timestamp::now()),
    };
    let condition = Condition {
        type_: kind.to_string(),
        status,
        reason: reason.to_string(),
        message: message.into(),
        observed_generation: generation,
        last_transition_time: transition,
    };
    match previous {
        Some(index) => conditions[index] = condition,
        None => conditions.push(condition),
    }
}

pub fn is_true(conditions: &[Condition], kind: &str) -> bool {
    conditions.iter().any(|c| c.type_ == kind && c.status == "True")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_transition_time_while_unchanged() {
        let mut conditions = Vec::new();
        set(&mut conditions, READY, false, "Waiting", "first", Some(1));
        let first = conditions[0].last_transition_time.clone();
        set(&mut conditions, READY, false, "Waiting", "second", Some(2));
        assert_eq!(conditions.len(), 1);
        assert_eq!(conditions[0].last_transition_time, first);
        assert_eq!(conditions[0].message, "second");
        set(&mut conditions, READY, true, "Done", "", Some(2));
        assert!(is_true(&conditions, READY));
    }
}
