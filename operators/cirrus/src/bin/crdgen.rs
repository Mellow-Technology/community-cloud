//! @file
//! Prints the WebApplication CRD, as k8s/operators/cirrus/
//! Cirrus.crd.yaml carries it.
//!
//! The CRD is generated from the Rust types rather than written by
//! hand, so the schema the API server enforces can't drift from what
//! the operator deserializes. tests/crd.rs fails if the checked-in
//! copy differs.

fn main() {
    print!("{}", cirrus::crd::crd_yaml());
}
