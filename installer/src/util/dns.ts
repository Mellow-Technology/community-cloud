/**
 * @file
 * Who may put which names in DNS.
 *
 * ExternalDNS watches the routes in a cluster and keeps a DNS
 * provider's records in step with the hostnames on them, so an
 * application is reachable by name the moment it's routed — and the
 * Let's Encrypt challenge that follows finds the name already there.
 *
 * The part that needs thought is that a Community Cloud cluster isn't
 * one organisation's. The office applications in cc-office answer on
 * one domain; a client or a team given a namespace of their own
 * answers on theirs, often at a different provider with a different
 * account. A route in one namespace must not be able to put a record
 * in another's domain, which a single ExternalDNS with every
 * credential and every domain would let it do.
 *
 * So there's one ExternalDNS per provider account and namespace. Each
 * is told the one namespace whose routes it reads and the domains it
 * may write, and holds only that account's credentials. A route in a
 * client's namespace naming the office's domain is simply ignored:
 * nothing watching that namespace may write there. The instances run
 * in a namespace of their own, so the people with access to a
 * namespace have no way to read the credentials writing its records.
 *
 * Each instance marks the records it makes as its own, with an owner
 * ID in a TXT record beside them, and only ever changes or removes
 * records carrying its own mark — so instances sharing a zone, or a
 * zone with records made by hand, leave each other alone.
 *
 * Cirrus runs instances of the same shape for DnsProvider resources
 * (operators/cirrus/src/dns), for domains that come and go with the
 * people a namespace is given to rather than with the cluster. Theirs
 * are named "cirrus-dns-…" and own records as "cirrus-…", so they and
 * these never take each other's instances or records. Neither checks
 * the other's domains for overlaps, though, so a domain belongs in one
 * place or the other.
 */
import { createHash } from "node:crypto";

import { stringify } from "yaml";

import { GatewayMode } from "./types.ts";

// Where the instances run. Nobody's application namespace, so the
// credentials in it aren't readable by anyone with access to one.
export const DNS_NAMESPACE = "external-dns";

// The chart, and the release of it. Pinned: 1.23 is ExternalDNS 0.23,
// which follows routes through a ListenerSet to their Gateway — the
// way every application here is attached — and the chart that can
// switch that on.
export const EXTERNAL_DNS_CHART = {
  repo: "https://kubernetes-sigs.github.io/external-dns/",
  name: "external-dns",
};
export const EXTERNAL_DNS_CHART_VERSION = "1.23.0";

// What ExternalDNS reads hostnames from. Routes are how everything
// here is reached; nothing is exposed through a Service or an Ingress.
const SOURCES = ["gateway-httproute"];

// The longest a Helm release name may be
const MAX_RELEASE_NAME = 53;

// What a name in here has to look like, since it becomes part of
// Kubernetes names
const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * One provider account, the domains it holds, and who may use them.
 *
 * - name: names the instances and their credentials
 * - provider: an ExternalDNS provider — cloudflare, aws, google,
 *   digitalocean, rfc2136 and so on
 * - domains: the domains its instances may write. A record outside
 *   them is never touched.
 * - excludeDomains: parts of those domains that belong to someone
 *   else, typically a subdomain given to another namespace
 * - namespaces: whose routes it reads. One instance runs for each.
 * - credentials: environment variables the provider reads its
 *   credentials from, as the provider's own documentation names them —
 *   CF_API_TOKEN for Cloudflare, AWS_ACCESS_KEY_ID and
 *   AWS_SECRET_ACCESS_KEY for Route 53. Kept in a Secret beside the
 *   instances.
 * - args: further ExternalDNS flags, for provider settings like
 *   "--cloudflare-proxied"
 * - target: what the records point at, in place of "dns.target"
 * - policy: "sync", the default, removes a record when its route
 *   goes; "upsert-only" never removes anything
 */
export interface DnsProvider {
  name: string;
  provider: string;
  domains: string[];
  excludeDomains?: string[];
  namespaces: string[];
  credentials?: Record<string, string>;
  args?: string[];
  target?: string;
  policy?: string;
}

/**
 * The dns section of a configuration.
 *
 * - target: what records point at, when the Gateway's own address
 *   isn't what the world reaches it by. Behind a router forwarding
 *   ports, the Gateway's address is one on the LAN, and a record
 *   pointing at that works for nobody outside it. An address, or a
 *   hostname for a CNAME.
 * - providers: see DnsProvider
 */
export interface DnsConfig {
  target?: string;
  providers?: DnsProvider[];
}

/**
 * One ExternalDNS: a provider account, watching one namespace.
 */
export interface DnsInstance {
  release: string;
  provider: DnsProvider;
  namespace: string;
  ownerId: string;
  target?: string;
}

/**
 * Read the dns section, if there is one.
 *
 * @param raw the whole configuration
 * @returns
 */
export function getDnsConfig(raw: Record<string, any>): DnsConfig | undefined {
  const { dns } = raw;
  return dns !== undefined && dns !== null && typeof dns === "object" ? dns : undefined;
}

/**
 * The Secret holding a provider account's credentials, which each of
 * its instances reads.
 *
 * @param provider
 * @returns
 */
export function getCredentialsSecretName(provider: DnsProvider): string {
  return `external-dns-${provider.name}`;
}

/**
 * Every ExternalDNS the configuration asks for.
 *
 * The owner ID is what an instance marks its records with, so it has
 * to be unique among everything that might write to the same zone —
 * including another cluster. The cluster's main domain is folded into
 * it for that reason, hashed so it stays short and says nothing.
 *
 * @param raw the whole configuration
 * @returns
 */
export function getDnsInstances(raw: Record<string, any>): DnsInstance[] {
  const dns = getDnsConfig(raw);
  const mainDomain = raw["values"]?.domain?.main ?? raw["domain"]?.main ?? "";
  const cluster = createHash("sha256").update(String(mainDomain)).digest("hex").slice(0, 6);

  return (dns?.providers ?? []).flatMap((provider) =>
    (provider.namespaces ?? []).map((namespace) => ({
      release: `external-dns-${provider.name}-${namespace}`,
      provider,
      namespace,
      ownerId: `cc-${cluster}-${provider.name}-${namespace}`,
      target: provider.target ?? dns?.target,
    })),
  );
}

/**
 * The chart's values for one instance.
 *
 * @param instance
 * @returns
 */
export function buildExternalDnsValues(instance: DnsInstance): string {
  const { provider } = instance;
  const credentials = Object.keys(provider.credentials ?? {});
  const managed = { "app.kubernetes.io/managed-by": "community-cloud" };

  return stringify({
    fullnameOverride: instance.release,
    provider: { name: provider.provider },
    sources: SOURCES,

    // Every application is attached to the Gateway through a
    // ListenerSet, and ExternalDNS only follows them when told to
    enableGatewayListenerSets: true,

    // Cluster-wide read access, scoped by "--namespace" below rather
    // than by RBAC. The chart's namespaced mode can't express what
    // following a ListenerSet needs — ExternalDNS lists ListenerSets
    // across the cluster to find a route's Gateway — and an instance
    // reading everything while acting on one namespace's routes is
    // still one that can only write what its domain filter allows.
    namespaced: false,

    policy: provider.policy ?? "sync",
    registry: "txt",
    txtOwnerId: instance.ownerId,
    domainFilters: provider.domains,
    excludeDomains: provider.excludeDomains ?? [],

    // Act when a route changes, rather than at the next interval
    triggerLoopOnEvent: true,

    extraArgs: [
      `--namespace=${instance.namespace}`,

      // What the records point at, whatever the Gateway says its own
      // address is. "--force-default-targets" is what makes the
      // default apply when the source has addresses of its own, which
      // a Gateway always does. ExternalDNS marks it deprecated, as a
      // way back to older behaviour; it is still the only way to set
      // a target for one instance rather than on the shared Gateway.
      ...(instance.target !== undefined
        ? [`--default-targets=${instance.target}`, "--force-default-targets"]
        : []),

      ...(provider.args ?? []),
    ],

    env: credentials.map((key) => ({
      name: key,
      valueFrom: { secretKeyRef: { name: getCredentialsSecretName(provider), key } },
    })),

    commonLabels: managed,
    nodeSelector: { "node-role.kubernetes.io/worker": "worker" },
  });
}

/**
 * Whether one domain is the other or inside it.
 *
 * @param domain
 * @param within
 * @returns
 */
function isWithin(domain: string, within: string): boolean {
  return domain === within || domain.endsWith(`.${within}`);
}

/**
 * What's wrong with the dns section, as sentences.
 *
 * Most of this is about the one mistake that matters: two namespaces
 * able to write the same name. The instances keep apart by domain, so
 * a domain given to two providers that watch different namespaces is
 * a domain either namespace can write records in.
 *
 * @param raw the whole configuration
 * @param gatewayMode how the cluster is reached
 * @returns
 */
export function checkDnsConfig(raw: Record<string, any>, gatewayMode: GatewayMode): string[] {
  const dns = getDnsConfig(raw);
  const problems: string[] = [];

  if (dns === undefined) {
    return problems;
  }

  const providers = dns.providers ?? [];
  const names = new Set<string>();

  for (const provider of providers) {
    const label = `The DNS provider "${provider.name ?? "?"}"`;

    if (provider.name === undefined || !NAME.test(provider.name)) {
      problems.push(`${label} needs a "name" of lower case letters, digits and hyphens, since it names Kubernetes resources.`);
    } else if (names.has(provider.name)) {
      problems.push(`Two DNS providers are called "${provider.name}".`);
    }
    names.add(provider.name);

    if (provider.provider === undefined || provider.provider === "") {
      problems.push(`${label} doesn't say which provider it is — "cloudflare", "aws", "google" and so on.`);
    }

    if (!Array.isArray(provider.domains) || provider.domains.length === 0) {
      problems.push(`${label} has no "domains". Without them it could write records in any zone its credentials reach.`);
    }

    if (!Array.isArray(provider.namespaces) || provider.namespaces.length === 0) {
      problems.push(`${label} has no "namespaces", so nothing would ever be published through it.`);
    }

    for (const key of Object.keys(provider.credentials ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        problems.push(`${label} has a credential called "${key}", which can't be an environment variable.`);
      }
    }

    for (const namespace of provider.namespaces ?? []) {
      const release = `external-dns-${provider.name}-${namespace}`;
      if (release.length > MAX_RELEASE_NAME) {
        problems.push(`${label} watching "${namespace}" would be the release "${release}", which is longer than Helm allows (${MAX_RELEASE_NAME}). Shorten the provider's name.`);
      }
    }

    // Behind a router, the Gateway's address is one on the LAN
    if (gatewayMode === GatewayMode.PortForward && provider.target === undefined && dns.target === undefined) {
      problems.push(`The cluster is reached through a router forwarding ports, so the Gateway's own address is a private one, and the DNS provider "${provider.name}" would publish it. Set "dns.target" to the router's public address.`);
    }
  }

  // Two providers, two sets of namespaces, overlapping domains: either
  // set of namespaces can write the overlap, unless the broader one
  // gives it away with "excludeDomains"
  for (const a of providers) {
    for (const b of providers) {
      if (a === b) {
        continue;
      }

      const sameNamespaces =
        JSON.stringify([...(a.namespaces ?? [])].sort()) === JSON.stringify([...(b.namespaces ?? [])].sort());
      if (sameNamespaces) {
        continue;
      }

      for (const narrow of b.domains ?? []) {
        for (const broad of a.domains ?? []) {
          if (!isWithin(narrow, broad)) {
            continue;
          }

          if (narrow === broad) {
            // Reported once, from the first of the pair
            if (providers.indexOf(a) < providers.indexOf(b)) {
              problems.push(`"${narrow}" is given to both "${a.name}" and "${b.name}", which watch different namespaces, so either could write records in it. Give it to one.`);
            }
            continue;
          }

          const excluded = (a.excludeDomains ?? []).some((excludedDomain) => isWithin(narrow, excludedDomain));
          if (!excluded) {
            problems.push(`"${narrow}", given to "${b.name}", is inside "${broad}", given to "${a.name}" — so namespaces using "${a.name}" could write records in it too. Add "${narrow}" to "${a.name}"'s "excludeDomains".`);
          }
        }
      }
    }
  }

  return problems;
}
