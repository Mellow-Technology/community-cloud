//! @file
//! Names for what Cirrus makes in the shared services.
//!
//! An application's own resources sit in its own namespace and can
//! take its name. What it gets in cc-postgres, RabbitMQ and SeaweedFS
//! can't: there's one of each for the whole cluster, so two
//! applications called "shop" in different namespaces would otherwise
//! be handed the same database. Those names carry the namespace too.
//!
//! Kubernetes names are at most 63 characters, and so are Postgres
//! identifiers. A name that would be longer is cut and given a hash
//! of the whole, so two long names sharing a prefix still differ.

use sha2::{Digest, Sha256};

// Both Kubernetes object names and Postgres identifiers stop at 63
const MAX_NAME: usize = 63;

// Enough of a hash that two cut names won't collide in practice
const HASH_LENGTH: usize = 8;

/// Hex of a SHA-256, cut to `length`.
pub fn short_hash(input: &str, length: usize) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    hex[..length].to_string()
}

fn fit(name: String, separator: char) -> String {
    if name.len() <= MAX_NAME {
        return name;
    }
    let hash = short_hash(&name, HASH_LENGTH);
    let keep = MAX_NAME - HASH_LENGTH - 1;
    let prefix = name[..keep].trim_end_matches(separator);
    format!("{prefix}{separator}{hash}")
}

/// A name for a Kubernetes object in a shared service's namespace,
/// and for the vhost, bucket and S3 user that go with it.
pub fn shared_name(namespace: &str, name: &str) -> String {
    fit(format!("{namespace}-{name}"), '-')
}

/// The Postgres role and database name. Hyphens would have to be
/// quoted everywhere they're used, so they become underscores.
pub fn postgres_identifier(namespace: &str, name: &str) -> String {
    fit(format!("{namespace}_{name}").replace('-', "_"), '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_names_pass_through() {
        assert_eq!(shared_name("shop", "web"), "shop-web");
        assert_eq!(postgres_identifier("my-team", "web-app"), "my_team_web_app");
    }

    #[test]
    fn long_names_fit_and_stay_distinct() {
        let a = shared_name(&"a".repeat(40), &format!("{}1", "b".repeat(30)));
        let b = shared_name(&"a".repeat(40), &format!("{}2", "b".repeat(30)));
        assert!(a.len() <= MAX_NAME);
        assert_ne!(a, b);
        assert!(postgres_identifier(&"n".repeat(50), &"x".repeat(50)).len() <= MAX_NAME);
    }
}
