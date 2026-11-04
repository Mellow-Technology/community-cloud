//! @file
//! One ExternalDNS: a DnsProvider's account, watching one namespace.
//!
//! Built to match what the installer's Helm release of the ExternalDNS
//! chart makes (installer/src/util/dns.ts, buildExternalDnsValues), so
//! an instance Cirrus runs behaves like one the installer runs: the
//! same image, flags, probes and security settings. The differences are
//! the names, which start "cirrus-dns-" so neither can claim the
//! other's objects, and the ClusterRole: the chart makes one per
//! release, while every instance here shares cirrus-external-dns from
//! Cirrus.rbac.yaml, so Cirrus only ever binds it and never writes
//! RBAC rules of its own.

use std::collections::BTreeMap;

use k8s_openapi::api::apps::v1::{Deployment, DeploymentSpec, DeploymentStrategy};
use k8s_openapi::api::core::v1::{
    Capabilities, Container, ContainerPort, EnvFromSource, HTTPGetAction, PodSecurityContext, PodSpec, PodTemplateSpec,
    Probe, SeccompProfile, SecretEnvSource, SecurityContext, ServiceAccount,
};
use k8s_openapi::api::rbac::v1::{ClusterRoleBinding, RoleRef, Subject};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::ObjectMeta;
use kube::{Resource, ResourceExt};

use super::DnsProvider;
use crate::naming::{dns_instance_name, short_hash};
use crate::settings::Settings;

// The ExternalDNS the installer's pinned chart (1.23.0) runs: 0.23,
// the first to follow routes through a ListenerSet to their Gateway
pub const IMAGE: &str = "registry.k8s.io/external-dns/external-dns:v0.23.0";

// The ClusterRole every instance is bound to, in Cirrus.rbac.yaml
pub const CLUSTER_ROLE: &str = "cirrus-external-dns";

pub const PROVIDER_LABEL: &str = "cirrus.community-cloud.technology/dns-provider";
pub const NAMESPACE_LABEL: &str = "cirrus.community-cloud.technology/namespace";

// Routes are how everything here is reached; nothing is exposed
// through a Service or an Ingress
const SOURCE: &str = "gateway-httproute";

// The chart's port for ExternalDNS's health and metrics
const PORT: i32 = 7979;

// The chart's user: ExternalDNS's own image runs as it
const USER: i64 = 65532;

/// The TXT owner ID an instance marks its records with. Unique among
/// everything that might write the same zone, other clusters included,
/// so the cluster's main domain is folded in, hashed so it stays short
/// and says nothing — as the installer does, with "cirrus-" in place of
/// its "cc-" so the two never take each other's records for their own.
pub fn owner_id(settings: &Settings, provider: &str, namespace: &str) -> String {
    let cluster = short_hash(&settings.cluster_domain, 6);
    format!("cirrus-{cluster}-{provider}-{namespace}")
}

pub fn labels(provider: &str, namespace: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("app.kubernetes.io/name".to_string(), "external-dns".to_string()),
        (
            "app.kubernetes.io/instance".to_string(),
            dns_instance_name(provider, namespace),
        ),
        ("app.kubernetes.io/managed-by".to_string(), "cirrus".to_string()),
        (PROVIDER_LABEL.to_string(), provider.to_string()),
        (NAMESPACE_LABEL.to_string(), namespace.to_string()),
    ])
}

fn selector(provider: &str, namespace: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("app.kubernetes.io/name".to_string(), "external-dns".to_string()),
        (
            "app.kubernetes.io/instance".to_string(),
            dns_instance_name(provider, namespace),
        ),
    ])
}

fn metadata(dns: &DnsProvider, settings: &Settings, namespace: &str, namespaced: bool) -> ObjectMeta {
    let provider = dns.name_any();
    ObjectMeta {
        name: Some(dns_instance_name(&provider, namespace)),
        namespace: namespaced.then(|| settings.dns_namespace.clone()),
        labels: Some(labels(&provider, namespace)),
        owner_references: Some(vec![
            dns.controller_owner_ref(&())
                .expect("a DnsProvider from the API has a name and uid"),
        ]),
        ..Default::default()
    }
}

/// ExternalDNS's flags, in the order the chart gives them.
pub fn args(dns: &DnsProvider, settings: &Settings, namespace: &str) -> Vec<String> {
    let provider = dns.name_any();
    let mut args = vec![
        "--log-level=info".to_string(),
        "--log-format=text".to_string(),
        "--interval=1m".to_string(),
        // Act when a route changes, rather than at the next interval
        "--events".to_string(),
        format!("--source={SOURCE}"),
        format!("--policy={}", dns.policy()),
        "--registry=txt".to_string(),
        format!("--txt-owner-id={}", owner_id(settings, &provider, namespace)),
        // Every application is attached to the Gateway through a
        // ListenerSet, and ExternalDNS only follows them when told to
        "--gateway-listener-sets".to_string(),
    ];
    args.extend(
        dns.spec
            .domains
            .iter()
            .map(|domain| format!("--domain-filter={domain}")),
    );
    args.extend(
        dns.spec
            .exclude_domains
            .iter()
            .map(|domain| format!("--exclude-domains={domain}")),
    );
    args.push(format!("--provider={}", dns.spec.provider));
    args.push(format!("--namespace={namespace}"));
    // "--force-default-targets" is what makes the target apply when the
    // source has addresses of its own, which a Gateway always does
    if let Some(target) = dns.spec.target.as_ref().filter(|target| !target.is_empty()) {
        args.push(format!("--default-targets={target}"));
        args.push("--force-default-targets".to_string());
    }
    args.extend(dns.spec.args.iter().cloned());
    args
}

pub fn service_account(dns: &DnsProvider, settings: &Settings, namespace: &str) -> ServiceAccount {
    ServiceAccount {
        metadata: metadata(dns, settings, namespace, true),
        ..Default::default()
    }
}

pub fn cluster_role_binding(dns: &DnsProvider, settings: &Settings, namespace: &str) -> ClusterRoleBinding {
    let name = dns_instance_name(&dns.name_any(), namespace);
    ClusterRoleBinding {
        metadata: metadata(dns, settings, namespace, false),
        role_ref: RoleRef {
            api_group: "rbac.authorization.k8s.io".to_string(),
            kind: "ClusterRole".to_string(),
            name: CLUSTER_ROLE.to_string(),
        },
        subjects: Some(vec![Subject {
            kind: "ServiceAccount".to_string(),
            name,
            namespace: Some(settings.dns_namespace.clone()),
            ..Default::default()
        }]),
    }
}

fn health_probe(initial_delay: i32, failure_threshold: i32) -> Probe {
    Probe {
        http_get: Some(HTTPGetAction {
            path: Some("/healthz".to_string()),
            port: IntOrString::String("http".to_string()),
            ..Default::default()
        }),
        initial_delay_seconds: Some(initial_delay),
        period_seconds: Some(10),
        timeout_seconds: Some(5),
        success_threshold: Some(1),
        failure_threshold: Some(failure_threshold),
        ..Default::default()
    }
}

pub fn deployment(dns: &DnsProvider, settings: &Settings, namespace: &str) -> Deployment {
    let provider = dns.name_any();
    let name = dns_instance_name(&provider, namespace);
    let container = Container {
        name: "external-dns".to_string(),
        image: Some(IMAGE.to_string()),
        args: Some(args(dns, settings, namespace)),
        env_from: Some(vec![EnvFromSource {
            secret_ref: Some(SecretEnvSource {
                name: dns.credentials_secret(),
                optional: None,
            }),
            ..Default::default()
        }]),
        ports: Some(vec![ContainerPort {
            name: Some("http".to_string()),
            container_port: PORT,
            protocol: Some("TCP".to_string()),
            ..Default::default()
        }]),
        liveness_probe: Some(health_probe(10, 2)),
        readiness_probe: Some(health_probe(5, 6)),
        security_context: Some(SecurityContext {
            allow_privilege_escalation: Some(false),
            capabilities: Some(Capabilities {
                drop: Some(vec!["ALL".to_string()]),
                ..Default::default()
            }),
            privileged: Some(false),
            read_only_root_filesystem: Some(true),
            run_as_group: Some(USER),
            run_as_non_root: Some(true),
            run_as_user: Some(USER),
            ..Default::default()
        }),
        ..Default::default()
    };
    Deployment {
        metadata: metadata(dns, settings, namespace, true),
        spec: Some(DeploymentSpec {
            replicas: Some(1),
            selector: LabelSelector {
                match_labels: Some(selector(&provider, namespace)),
                ..Default::default()
            },
            // Two instances at once would both write the same records
            strategy: Some(DeploymentStrategy {
                type_: Some("Recreate".to_string()),
                ..Default::default()
            }),
            template: PodTemplateSpec {
                metadata: Some(ObjectMeta {
                    labels: Some(labels(&provider, namespace)),
                    ..Default::default()
                }),
                spec: Some(PodSpec {
                    service_account_name: Some(name),
                    containers: vec![container],
                    security_context: Some(PodSecurityContext {
                        fs_group: Some(65534),
                        run_as_non_root: Some(true),
                        seccomp_profile: Some(SeccompProfile {
                            type_: "RuntimeDefault".to_string(),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    // Where the installer's instances run too
                    node_selector: Some(BTreeMap::from([(
                        "node-role.kubernetes.io/worker".to_string(),
                        "worker".to_string(),
                    )])),
                    ..Default::default()
                }),
            },
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::dns::DnsProviderSpec;

    pub fn provider() -> DnsProvider {
        let mut dns = DnsProvider::new(
            "acme",
            DnsProviderSpec {
                provider: "cloudflare".into(),
                domains: vec!["acme.test".into(), "acme.example".into()],
                exclude_domains: vec!["internal.acme.test".into()],
                namespaces: vec!["acme".into()],
                target: Some("203.0.113.7".into()),
                args: vec!["--cloudflare-proxied".into()],
                ..Default::default()
            },
        );
        dns.metadata.uid = Some("2222-3333".into());
        dns
    }

    fn settings() -> Settings {
        Settings {
            cluster_domain: "example.org".into(),
            ..Default::default()
        }
    }

    #[test]
    fn flags_match_the_charts() {
        let args = args(&provider(), &settings(), "acme");
        let owner = owner_id(&settings(), "acme", "acme");
        assert_eq!(
            args,
            [
                "--log-level=info",
                "--log-format=text",
                "--interval=1m",
                "--events",
                "--source=gateway-httproute",
                "--policy=sync",
                "--registry=txt",
                &format!("--txt-owner-id={owner}"),
                "--gateway-listener-sets",
                "--domain-filter=acme.test",
                "--domain-filter=acme.example",
                "--exclude-domains=internal.acme.test",
                "--provider=cloudflare",
                "--namespace=acme",
                "--default-targets=203.0.113.7",
                "--force-default-targets",
                "--cloudflare-proxied",
            ]
        );
        assert!(owner.starts_with("cirrus-") && owner.ends_with("-acme-acme"));
        assert_ne!(owner, owner_id(&Settings::default(), "acme", "acme"));
    }

    #[test]
    fn runs_in_the_dns_namespace_with_the_accounts_credentials() {
        let made = deployment(&provider(), &settings(), "acme");
        assert_eq!(made.metadata.namespace.as_deref(), Some("external-dns"));
        assert_eq!(made.metadata.name.as_deref(), Some("cirrus-dns-acme-acme"));
        assert_eq!(made.metadata.owner_references.as_ref().unwrap()[0].kind, "DnsProvider");
        let pod = made.spec.unwrap().template.spec.unwrap();
        assert_eq!(pod.service_account_name.as_deref(), Some("cirrus-dns-acme-acme"));
        let container = &pod.containers[0];
        assert_eq!(container.image.as_deref(), Some(IMAGE));
        let secret = container.env_from.as_ref().unwrap()[0].secret_ref.as_ref().unwrap();
        assert_eq!(secret.name, "cirrus-dns-acme");

        let binding = cluster_role_binding(&provider(), &settings(), "acme");
        assert_eq!(binding.metadata.namespace, None);
        assert_eq!(binding.role_ref.name, CLUSTER_ROLE);
        let subject = &binding.subjects.unwrap()[0];
        assert_eq!(
            (subject.name.as_str(), subject.namespace.as_deref()),
            ("cirrus-dns-acme-acme", Some("external-dns"))
        );
    }

    #[test]
    fn leaves_the_target_off_when_there_is_none() {
        let mut dns = provider();
        dns.spec.target = None;
        dns.spec.policy = Some("upsert-only".into());
        let args = args(&dns, &settings(), "acme");
        assert!(args.contains(&"--policy=upsert-only".to_string()));
        assert!(
            !args
                .iter()
                .any(|arg| arg.starts_with("--default-targets") || arg == "--force-default-targets")
        );
    }
}
