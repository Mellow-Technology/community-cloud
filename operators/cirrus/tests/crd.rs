//! The CRD the installer applies has to be the one these types
//! generate. Regenerate it with:
//!
//!     cargo run --bin crdgen > ../../k8s/operators/cirrus/Cirrus.crd.yaml

#[test]
fn checked_in_crd_is_current() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../k8s/operators/cirrus/Cirrus.crd.yaml"
    );
    let checked_in = std::fs::read_to_string(path).expect("k8s/operators/cirrus/Cirrus.crd.yaml exists");
    assert!(
        checked_in == cirrus::crd::crd_yaml(),
        "Cirrus.crd.yaml is out of date; run `cargo run --bin crdgen > ../../k8s/operators/cirrus/Cirrus.crd.yaml`"
    );
}
