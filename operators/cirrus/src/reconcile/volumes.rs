//! @file
//! The application's own volumes: a PersistentVolumeClaim for each, on
//! the StorageClass for its storage type, and where the pods mount it.
//!
//! Community Cloud's storage is local to a node (TopoLVM), so each
//! claim is one volume on one node, shared by every copy of the
//! application. The copies all run on that node, and a rollout stops
//! the old ones before starting the new (see workload.rs), since a
//! rolling update could leave the new copy waiting for a node it can't
//! have.
//!
//! The claims aren't owned by the application. Deleting it leaves them
//! and what's on them, as for its database and bucket, and making it
//! again with the same name and volumes picks them up. The
//! StorageClasses' "Retain" keeps the data even when a claim is deleted
//! by hand.
//!
//! A volume can grow but not shrink, and its type can't change, since a
//! claim's StorageClass is fixed. Either asked for is reported rather
//! than tried, so the application keeps running on the volume it has.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::{
    PersistentVolumeClaim, PersistentVolumeClaimSpec, PersistentVolumeClaimVolumeSource, Volume, VolumeMount,
    VolumeResourceRequirements,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::Api;

use super::{Context, Outcome, Provided};
use crate::crd::{VolumeSpec, WebApplication, labels};
use crate::error::{Error, Result};
use crate::resources;

// Which volume of which application a claim is, for finding them again
const VOLUME_LABEL: &str = "cirrus.community-cloud.technology/volume";

/// The claim a volume is: <application>-<volume>.
pub fn claim_name(app_name: &str, volume: &VolumeSpec) -> String {
    format!("{app_name}-{}", volume.name)
}

/// A Kubernetes quantity in bytes, or nothing when it isn't one.
pub fn bytes(quantity: &str) -> Option<f64> {
    let quantity = quantity.trim();
    let split = quantity
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(quantity.len());
    let (number, suffix) = quantity.split_at(split);
    let number: f64 = number.parse().ok()?;
    let multiplier = match suffix {
        "" => 1.0,
        "k" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "P" => 1e15,
        "Ki" => 1024.0,
        "Mi" => 1024f64.powi(2),
        "Gi" => 1024f64.powi(3),
        "Ti" => 1024f64.powi(4),
        "Pi" => 1024f64.powi(5),
        _ => return None,
    };
    Some(number * multiplier)
}

/// Whether a volume's name is a DNS label short enough to make a claim
/// name with the application's.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

/// What's wrong with the volumes as asked for, as sentences: nothing
/// is made while any of these stand.
pub fn problems(app: &WebApplication) -> Vec<String> {
    let mut problems = Vec::new();
    let mut names = Vec::new();
    let mut paths: Vec<&str> = Vec::new();
    for volume in &app.spec.volumes {
        if !valid_name(&volume.name) {
            problems.push(format!(
                "the volume name {:?} should be lower-case letters, digits and hyphens",
                volume.name
            ));
        } else if names.contains(&volume.name) {
            problems.push(format!("there are two volumes called {}", volume.name));
        }
        names.push(volume.name.clone());

        let path = volume.mount_path.trim_end_matches('/');
        if !volume.mount_path.starts_with('/') || path.is_empty() {
            problems.push(format!(
                "the volume {} should be mounted at an absolute path other than /, such as /data",
                volume.name
            ));
        } else if let Some(other) = paths.iter().find(|other| {
            **other == path || path.starts_with(&format!("{other}/")) || other.starts_with(&format!("{path}/"))
        }) {
            problems.push(format!(
                "the volume {} is mounted at {}, which overlaps {other}",
                volume.name, volume.mount_path
            ));
        } else {
            paths.push(path);
        }

        if bytes(&volume.size).is_none_or(|size| size <= 0.0) {
            problems.push(format!(
                "the volume {} should have a size such as 10Gi, not {:?}",
                volume.name, volume.size
            ));
        }
    }
    problems
}

/// The claim for one volume.
pub fn claim(app: &WebApplication, volume: &VolumeSpec) -> PersistentVolumeClaim {
    let (namespace, name) = super::identity(app);
    let mut claim_labels = labels(&name);
    claim_labels.insert(VOLUME_LABEL.to_string(), volume.name.clone());
    PersistentVolumeClaim {
        metadata: ObjectMeta {
            name: Some(claim_name(&name, volume)),
            namespace: Some(namespace),
            labels: Some(claim_labels),
            // Not owned: deleting the application keeps the data
            ..Default::default()
        },
        spec: Some(PersistentVolumeClaimSpec {
            access_modes: Some(vec!["ReadWriteOnce".to_string()]),
            storage_class_name: Some(volume.storage_type.storage_class().to_string()),
            resources: Some(VolumeResourceRequirements {
                requests: Some(BTreeMap::from([(
                    "storage".to_string(),
                    Quantity(volume.size.trim().to_string()),
                )])),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// Why a volume as asked for can't be made from the claim that's
/// there, if it can't: a different storage type, or smaller.
pub fn conflict(volume: &VolumeSpec, existing: &PersistentVolumeClaim) -> Option<String> {
    let spec = existing.spec.as_ref()?;
    let class = spec.storage_class_name.as_deref().unwrap_or_default();
    if class != volume.storage_type.storage_class() {
        return Some(format!(
            "the volume {} is already on {class}, and a volume's type can't change; \
             set its type back, or give the volume a new name for a new one",
            volume.name
        ));
    }
    let have = spec
        .resources
        .as_ref()
        .and_then(|resources| resources.requests.as_ref())
        .and_then(|requests| requests.get("storage"))
        .map(|quantity| quantity.0.clone());
    if let (Some(have), Some(want_bytes)) = (have, bytes(&volume.size))
        && bytes(&have).is_some_and(|have_bytes| want_bytes < have_bytes)
    {
        return Some(format!(
            "the volume {} is {have}, and a volume can grow but not shrink",
            volume.name
        ));
    }
    None
}

/// Makes or grows each volume's claim. A claim stays Pending until a
/// pod using it is scheduled, since the volume is made on that pod's
/// node, so this doesn't wait for them to be bound.
pub async fn ensure(ctx: &Context, app: &WebApplication) -> Result<Outcome> {
    let mut problems = problems(app);
    if !problems.is_empty() {
        return Err(Error::NotPermitted(problems.join("; ")));
    }
    let (namespace, name) = super::identity(app);
    let claims = Api::<PersistentVolumeClaim>::namespaced(ctx.client.clone(), &namespace);
    for volume in &app.spec.volumes {
        let claim_name = claim_name(&name, volume);
        if let Some(existing) = claims.get_opt(&claim_name).await?
            && let Some(problem) = conflict(volume, &existing)
        {
            problems.push(problem);
            continue;
        }
        resources::apply(&claims, &claim_name, &claim(app, volume)).await?;
    }
    if !problems.is_empty() {
        return Err(Error::NotPermitted(problems.join("; ")));
    }
    Ok(Outcome::Ready(Provided::default()))
}

/// The pod's volumes, one per claim.
pub fn pod_volumes(app: &WebApplication) -> Option<Vec<Volume>> {
    let (_, name) = super::identity(app);
    (!app.spec.volumes.is_empty()).then(|| {
        app.spec
            .volumes
            .iter()
            .map(|volume| Volume {
                name: format!("volume-{}", volume.name),
                persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                    claim_name: claim_name(&name, volume),
                    read_only: None,
                }),
                ..Default::default()
            })
            .collect()
    })
}

/// Where the container mounts them.
pub fn mounts(app: &WebApplication) -> Option<Vec<VolumeMount>> {
    (!app.spec.volumes.is_empty()).then(|| {
        app.spec
            .volumes
            .iter()
            .map(|volume| VolumeMount {
                name: format!("volume-{}", volume.name),
                mount_path: volume.mount_path.clone(),
                ..Default::default()
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::StorageType;

    fn app_with(volumes: Vec<VolumeSpec>) -> WebApplication {
        let mut app = crate::reconcile::tests::app();
        app.spec.volumes = volumes;
        app
    }

    fn volume(name: &str, path: &str, size: &str, storage_type: StorageType) -> VolumeSpec {
        VolumeSpec {
            name: name.to_string(),
            mount_path: path.to_string(),
            size: size.to_string(),
            storage_type,
        }
    }

    #[test]
    fn a_claim_is_named_for_the_application_on_its_type_and_not_owned() {
        let app = app_with(vec![volume("uploads", "/data/uploads", "10Gi", StorageType::Hdd)]);
        let claim = claim(&app, &app.spec.volumes[0]);
        assert_eq!(claim.metadata.name.as_deref(), Some("shop-uploads"));
        assert!(claim.metadata.owner_references.is_none());
        assert_eq!(
            claim
                .metadata
                .labels
                .as_ref()
                .unwrap()
                .get(VOLUME_LABEL)
                .map(String::as_str),
            Some("uploads")
        );
        let spec = claim.spec.unwrap();
        assert_eq!(spec.storage_class_name.as_deref(), Some("cc-local-hdd"));
        assert_eq!(spec.access_modes, Some(vec!["ReadWriteOnce".to_string()]));
        assert_eq!(spec.resources.unwrap().requests.unwrap()["storage"].0, "10Gi");
    }

    #[test]
    fn the_type_is_fast_unless_said() {
        let parsed: VolumeSpec =
            serde_json::from_value(serde_json::json!({"name": "a", "mountPath": "/a", "size": "1Gi"})).unwrap();
        assert_eq!(parsed.storage_type, StorageType::Fast);
        assert_eq!(parsed.storage_type.storage_class(), "cc-local-ssd-fast");
        let sata: VolumeSpec =
            serde_json::from_value(serde_json::json!({"name": "a", "mountPath": "/a", "size": "1Gi", "type": "sata"}))
                .unwrap();
        assert_eq!(sata.storage_type.storage_class(), "cc-local-ssd-sata");
    }

    #[test]
    fn volumes_are_checked_before_anything_is_made() {
        assert!(problems(&app_with(vec![volume("data", "/data", "5Gi", StorageType::Fast)])).is_empty());
        let found = problems(&app_with(vec![
            volume("Data", "/data", "5Gi", StorageType::Fast),
            volume("cache", "relative", "lots", StorageType::Fast),
            volume("more", "/data/more", "1Gi", StorageType::Fast),
            volume("more", "/other", "1Gi", StorageType::Fast),
            volume("root", "/", "1Gi", StorageType::Fast),
        ]));
        let joined = found.join(" | ");
        assert!(joined.contains("\"Data\" should be lower-case"), "{joined}");
        assert!(
            joined.contains("cache should be mounted at an absolute path"),
            "{joined}"
        );
        assert!(joined.contains("cache should have a size"), "{joined}");
        assert!(joined.contains("overlaps /data"), "{joined}");
        assert!(joined.contains("two volumes called more"), "{joined}");
        assert!(joined.contains("root should be mounted"), "{joined}");
    }

    #[test]
    fn a_volume_can_grow_but_not_shrink_or_change_type() {
        let app = app_with(vec![volume("data", "/data", "10Gi", StorageType::Fast)]);
        let existing = claim(&app, &app.spec.volumes[0]);
        assert_eq!(
            conflict(&volume("data", "/data", "20Gi", StorageType::Fast), &existing),
            None
        );
        assert!(
            conflict(&volume("data", "/data", "5Gi", StorageType::Fast), &existing)
                .unwrap()
                .contains("can grow but not shrink")
        );
        assert!(
            conflict(&volume("data", "/data", "10Gi", StorageType::Hdd), &existing)
                .unwrap()
                .contains("type can't change")
        );
    }

    #[test]
    fn quantities_read_as_bytes() {
        assert_eq!(bytes("1Gi"), Some(1024f64.powi(3)));
        assert_eq!(bytes("500M"), Some(5e8));
        assert_eq!(bytes("1.5Ti"), Some(1.5 * 1024f64.powi(4)));
        assert_eq!(bytes("lots"), None);
        assert_eq!(bytes("10GB"), None);
    }

    #[test]
    fn pods_mount_each_claim() {
        let app = app_with(vec![volume("data", "/data", "1Gi", StorageType::Fast)]);
        let volumes = pod_volumes(&app).unwrap();
        assert_eq!(
            volumes[0].persistent_volume_claim.as_ref().unwrap().claim_name,
            "shop-data"
        );
        let mounts = mounts(&app).unwrap();
        assert_eq!(
            (mounts[0].name.as_str(), mounts[0].mount_path.as_str()),
            ("volume-data", "/data")
        );
        assert!(pod_volumes(&app_with(vec![])).is_none());
    }
}
