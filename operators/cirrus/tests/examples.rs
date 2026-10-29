//! Every WebApplication and DnsProvider in examples/ has to be one the
//! operator can read, so the examples can't drift from the CRDs the way
//! hand-written documentation does.

use cirrus::crd::WebApplication;
use cirrus::dns::DnsProvider;
use serde::Deserialize;

#[test]
fn examples_deserialize() {
    let directory = concat!(env!("CARGO_MANIFEST_DIR"), "/examples");
    let mut found = 0;
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let text = std::fs::read_to_string(&path).unwrap();
        for document in serde_yaml::Deserializer::from_str(&text) {
            let value = serde_yaml::Value::deserialize(document).unwrap();
            if value["kind"].as_str() == Some("DnsProvider") {
                let dns: DnsProvider =
                    serde_yaml::from_value(value).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
                assert!(dns.problems().is_empty(), "{}", path.display());
                continue;
            }
            if value["kind"].as_str() != Some("WebApplication") {
                continue;
            }
            let app: WebApplication =
                serde_yaml::from_value(value).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            assert!(!app.spec.image.repository.is_empty(), "{}", path.display());
            found += 1;
        }
    }
    assert!(found >= 3, "expected the three examples, found {found}");
}
