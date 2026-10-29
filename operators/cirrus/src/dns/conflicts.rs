//! @file
//! Whether two DnsProviders could write each other's names.
//!
//! The instances are kept apart by domain: each may only write the
//! domains its provider holds. So a domain held by two providers that
//! watch different namespaces is a domain either set of namespaces can
//! write records in, which is exactly what running one ExternalDNS per
//! namespace is meant to prevent. The same goes for a domain inside
//! another, unless the broader one gives it away with excludeDomains.
//!
//! This is the check checkDnsConfig makes over the installer's dns
//! section (installer/src/util/dns.ts), made over DnsProviders instead.
//! A provider in conflict runs nothing until it's resolved, since
//! running it is how the wrong namespace would get the name.

use kube::ResourceExt;

use super::DnsProvider;

/// Whether one domain is the other or inside it.
fn is_within(domain: &str, within: &str) -> bool {
    domain == within || domain.ends_with(&format!(".{within}"))
}

fn namespace_set(provider: &DnsProvider) -> Vec<&str> {
    let mut namespaces: Vec<&str> = provider.spec.namespaces.iter().map(String::as_str).collect();
    namespaces.sort_unstable();
    namespaces.dedup();
    namespaces
}

/// How `broad` and `narrow` overlap, if they do in a way that matters:
/// a domain of `narrow` that's one of `broad`'s, or inside one without
/// being excluded. A domain both hold is the same overlap whichever way
/// round they're asked about, so it's only said when `same` is set.
fn overlaps(broad: &DnsProvider, narrow: &DnsProvider, same: bool) -> Vec<String> {
    let mut found = Vec::new();
    for inner in &narrow.spec.domains {
        for outer in &broad.spec.domains {
            if !is_within(inner, outer) {
                continue;
            }
            if inner == outer {
                if !same {
                    continue;
                }
                found.push(format!(
                    "\"{inner}\" is given to both {} and {}, which publish different namespaces, so either could write records in it",
                    broad.name_any(),
                    narrow.name_any()
                ));
                continue;
            }
            let excluded = broad
                .spec
                .exclude_domains
                .iter()
                .any(|excluded| is_within(inner, excluded));
            if !excluded {
                found.push(format!(
                    "\"{inner}\", given to {}, is inside \"{outer}\", given to {}, so the namespaces {} publishes could write records in it too; add \"{inner}\" to {}'s excludeDomains",
                    narrow.name_any(),
                    broad.name_any(),
                    broad.name_any(),
                    broad.name_any()
                ));
            }
        }
    }
    found
}

/// Every way `provider` and the others in `all` could write each
/// other's names. `all` may include `provider` itself.
pub fn conflicts(provider: &DnsProvider, all: &[DnsProvider]) -> Vec<String> {
    let name = provider.name_any();
    let mine = namespace_set(provider);
    let mut problems = Vec::new();
    for other in all.iter().filter(|other| other.name_any() != name) {
        // Providers publishing the same namespaces can share domains:
        // whichever writes a name, it's one of those namespaces' names
        if namespace_set(other) == mine {
            continue;
        }
        for problem in overlaps(provider, other, true)
            .into_iter()
            .chain(overlaps(other, provider, false))
        {
            if !problems.contains(&problem) {
                problems.push(problem);
            }
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dns::DnsProviderSpec;

    fn provider(name: &str, domains: &[&str], exclude: &[&str], namespaces: &[&str]) -> DnsProvider {
        DnsProvider::new(
            name,
            DnsProviderSpec {
                provider: "cloudflare".into(),
                domains: domains.iter().map(|d| d.to_string()).collect(),
                exclude_domains: exclude.iter().map(|d| d.to_string()).collect(),
                namespaces: namespaces.iter().map(|n| n.to_string()).collect(),
                ..Default::default()
            },
        )
    }

    #[test]
    fn the_same_domain_for_different_namespaces_conflicts() {
        let office = provider("office", &["example.org"], &[], &["cc-office"]);
        let team = provider("team", &["example.org"], &[], &["team"]);
        let all = [office.clone(), team.clone()];
        assert_eq!(conflicts(&office, &all).len(), 1);
        assert_eq!(conflicts(&team, &all).len(), 1);
        assert!(conflicts(&team, &all)[0].contains("given to both"));
    }

    #[test]
    fn a_subdomain_needs_excluding_from_the_broader_one() {
        let office = provider("office", &["example.org"], &[], &["cc-office"]);
        let team = provider("team", &["team.example.org"], &[], &["team"]);
        let problems = conflicts(&team, &[office.clone(), team.clone()]);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("office's excludeDomains"), "{problems:?}");

        let office = provider("office", &["example.org"], &["team.example.org"], &["cc-office"]);
        assert!(conflicts(&team, &[office.clone(), team.clone()]).is_empty());
        assert!(conflicts(&office, &[office.clone(), team]).is_empty());
    }

    #[test]
    fn unrelated_domains_and_shared_namespaces_are_fine() {
        let office = provider("office", &["example.org"], &[], &["cc-office"]);
        let other = provider("acme", &["acme.test"], &[], &["acme"]);
        let mirror = provider("mirror", &["example.org"], &[], &["cc-office"]);
        let all = [office.clone(), other, mirror];
        assert!(conflicts(&office, &all).is_empty());
        // A domain that merely ends the same way isn't inside another
        assert!(!is_within("notexample.org", "example.org"));
    }
}
