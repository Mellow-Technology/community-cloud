/**
 * @file
 * DNS for a namespace: which DnsProviders publish it, the form for
 * giving it one, and the checks that keep namespaces out of each
 * other's domains.
 *
 * The check that matters is the one Cirrus also makes, and the
 * installer makes for its own instances (installer/src/util/dns.ts):
 * two providers that watch different namespaces must not share a
 * domain, or a route in either namespace could write records in the
 * other's. Cirrus refuses such a provider; the form says so before it's
 * saved, which is kinder than a condition found later.
 *
 * Credentials are environment variables, named as ExternalDNS's
 * provider documentation names them. The common providers are filled
 * in here so nobody has to look them up; anything else can still be
 * typed.
 */
import type { Condition } from "../kube/types";
import { DNS_API_VERSION, DNS_KIND, defaultCredentialsSecret, type DnsPolicy, type DnsProvider } from "./types";

/**
 * A provider ExternalDNS knows, and the variables its credentials go in.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  credentials: string[];
  // Where the token is made, for the form's hint
  hint: string;
}

// The providers people here are likely to have. ExternalDNS supports
// many more; "other" takes any of them, with the variables typed in.
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "cloudflare",
    label: "Cloudflare",
    credentials: ["CF_API_TOKEN"],
    hint: "An API token with Zone: Read and DNS: Edit, for the zones below.",
  },
  {
    id: "digitalocean",
    label: "DigitalOcean",
    credentials: ["DO_TOKEN"],
    hint: "A personal access token with read and write access to Domains.",
  },
  {
    id: "aws",
    label: "Route 53",
    credentials: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    hint: "An IAM user's keys, allowed route53:ChangeResourceRecordSets on the zones and route53:List* on all.",
  },
  {
    id: "linode",
    label: "Linode",
    credentials: ["LINODE_TOKEN"],
    hint: "A personal access token with Domains: Read/Write.",
  },
  {
    id: "ovh",
    label: "OVH",
    credentials: ["OVH_APPLICATION_KEY", "OVH_APPLICATION_SECRET", "OVH_CONSUMER_KEY"],
    hint: "An application's keys and a consumer key allowed to manage the zones.",
  },
];

export const OTHER_PROVIDER = "other";

/**
 * A provider's preset, if it has one.
 *
 * @param id
 * @returns
 */
export function presetFor(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/**
 * Whether a hostname is a domain or inside it.
 *
 * @param hostname
 * @param domain
 * @returns
 */
export function isWithin(hostname: string, domain: string): boolean {
  const name = hostname.toLowerCase().replace(/^\*\./, "");
  const zone = domain.toLowerCase();
  return name === zone || name.endsWith(`.${zone}`);
}

/**
 * The providers publishing a namespace's routes.
 *
 * @param providers
 * @param namespace
 * @returns
 */
export function providersFor(providers: DnsProvider[], namespace: string): DnsProvider[] {
  return providers.filter((provider) => (provider.spec.namespaces ?? []).includes(namespace));
}

/**
 * The provider that would publish a hostname from a namespace, if any.
 *
 * @param providers those publishing the namespace
 * @param hostname
 * @returns
 */
export function publisherOf(providers: DnsProvider[], hostname: string): DnsProvider | undefined {
  return providers.find(
    (provider) =>
      provider.spec.domains.some((domain) => isWithin(hostname, domain)) &&
      !(provider.spec.excludeDomains ?? []).some((domain) => isWithin(hostname, domain)),
  );
}

/**
 * Where two providers would let different namespaces write the same
 * names, as sentences. The same rules as the installer's and Cirrus's:
 * providers watching the same namespaces may share; otherwise a domain
 * inside another's has to be excluded from the broader one.
 *
 * @param providers every provider, as it would be
 * @param only report only problems involving this one
 * @returns
 */
export function domainConflicts(providers: DnsProvider[], only?: string): string[] {
  const problems: string[] = [];
  const sorted = (list: string[] | undefined) => JSON.stringify([...(list ?? [])].toSorted());

  for (const a of providers) {
    for (const b of providers) {
      if (a === b || sorted(a.spec.namespaces) === sorted(b.spec.namespaces)) {
        continue;
      }
      if (only !== undefined && a.metadata.name !== only && b.metadata.name !== only) {
        continue;
      }
      for (const narrow of b.spec.domains) {
        for (const broad of a.spec.domains) {
          if (!isWithin(narrow, broad)) {
            continue;
          }
          if (narrow === broad) {
            if (providers.indexOf(a) < providers.indexOf(b)) {
              problems.push(
                `${narrow} is given to both ${a.metadata.name} and ${b.metadata.name}, which publish different namespaces.`,
              );
            }
            continue;
          }
          if (!(a.spec.excludeDomains ?? []).some((excluded) => isWithin(narrow, excluded))) {
            problems.push(
              `${narrow}, given to ${b.metadata.name}, is inside ${broad}, given to ${a.metadata.name}, which publishes other namespaces. Exclude ${narrow} from ${a.metadata.name} first.`,
            );
          }
        }
      }
    }
  }
  return problems;
}

/**
 * How a provider is doing, from Cirrus's Ready condition.
 */
export interface DnsState {
  tone: "success" | "warning" | "danger" | "neutral";
  label: string;
  message?: string;
}

/**
 * @param provider
 * @param namespace when given, how that namespace's instance is doing
 * @returns
 */
export function dnsState(provider: DnsProvider, namespace?: string): DnsState {
  const ready: Condition | undefined = provider.status?.conditions?.find((condition) => condition.type === "Ready");
  if (ready === undefined) {
    return { tone: "neutral", label: "Not looked at yet", message: "Cirrus hasn't reported on this provider." };
  }
  if (ready.status !== "True") {
    const blocked = ["DomainConflict", "MissingCredentials", "Invalid"].includes(ready.reason ?? "");
    return {
      tone: blocked ? "danger" : "warning",
      label: blocked ? "Not publishing" : "Starting",
      message: ready.message || ready.reason,
    };
  }
  const instance = provider.status?.instances?.find((each) => each.namespace === namespace);
  if (namespace !== undefined && instance !== undefined && !instance.ready) {
    return { tone: "warning", label: "Starting", message: `${instance.deployment} isn't ready yet.` };
  }
  return { tone: "success", label: "Publishing" };
}

/**
 * The form for giving a namespace a new provider.
 */
export interface DnsProviderForm {
  name: string;
  provider: string;
  // When the provider is "other"
  customProvider: string;
  domains: string;
  excludeDomains: string;
  target: string;
  policy: DnsPolicy;
  credentials: Array<{ name: string; value: string }>;
}

/**
 * A new provider's form, for a namespace.
 *
 * @param namespace
 * @returns
 */
export function emptyDnsForm(namespace: string): DnsProviderForm {
  const preset = PROVIDER_PRESETS[0]!;
  return {
    name: namespace,
    provider: preset.id,
    customProvider: "",
    domains: "",
    excludeDomains: "",
    target: "",
    policy: "sync",
    credentials: preset.credentials.map((name) => ({ name, value: "" })),
  };
}

/**
 * The credentials rows for a provider, keeping any value already typed.
 *
 * @param form
 * @param provider
 * @returns
 */
export function credentialsFor(form: DnsProviderForm, provider: string): DnsProviderForm["credentials"] {
  const names = presetFor(provider)?.credentials ?? [""];
  return names.map((name) => ({ name, value: form.credentials.find((row) => row.name === name)?.value ?? "" }));
}

/**
 * Items of a list typed one to a line or comma separated, lower-cased.
 *
 * @param text
 * @returns
 */
function domainList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((item) => item.trim().toLowerCase().replace(/\.$/, ""))
        .filter((item) => item !== ""),
    ),
  ];
}

/**
 * The provider the form describes, publishing one namespace.
 *
 * @param form
 * @param namespace
 * @returns
 */
export function fromDnsForm(form: DnsProviderForm, namespace: string): DnsProvider {
  const name = form.name.trim();
  const excludeDomains = domainList(form.excludeDomains);
  const target = form.target.trim();
  return {
    apiVersion: DNS_API_VERSION,
    kind: DNS_KIND,
    metadata: { name },
    spec: {
      provider: form.provider === OTHER_PROVIDER ? form.customProvider.trim() : form.provider,
      domains: domainList(form.domains),
      ...(excludeDomains.length > 0 ? { excludeDomains } : {}),
      namespaces: [namespace],
      credentialsSecret: defaultCredentialsSecret(name),
      ...(target !== "" ? { target } : {}),
      policy: form.policy,
    },
  };
}

/**
 * The credentials the form gives, as a Secret's data.
 *
 * @param form
 * @returns
 */
export function credentialsData(form: DnsProviderForm): Record<string, string> {
  return Object.fromEntries(
    form.credentials.filter((row) => row.name.trim() !== "").map((row) => [row.name.trim(), row.value.trim()]),
  );
}

// Kubernetes names: a DnsProvider's becomes part of each instance's
// and of its credentials Secret's, so it's kept short
const NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What's wrong with the form, by field.
 *
 * @param form
 * @param existing every provider already in the cluster
 * @param namespace the namespace it's for
 * @returns
 */
export function validateDnsForm(
  form: DnsProviderForm,
  existing: DnsProvider[],
  namespace: string,
): Partial<Record<keyof DnsProviderForm, string>> {
  const errors: Partial<Record<keyof DnsProviderForm, string>> = {};
  const name = form.name.trim();

  if (name === "" || name.length > 30 || !NAME.test(name)) {
    errors.name = "Lower-case letters, digits and hyphens, no longer than 30 characters.";
  } else if (existing.some((provider) => provider.metadata.name === name)) {
    errors.name = `There's already a provider called ${name}. Add this namespace to it instead, or pick another name.`;
  }

  if (form.provider === OTHER_PROVIDER && !NAME.test(form.customProvider.trim())) {
    errors.customProvider = "ExternalDNS's name for it, such as gandi or pdns.";
  }

  const domains = domainList(form.domains);
  const badDomain = [...domains, ...domainList(form.excludeDomains)].find((domain) => !DOMAIN.test(domain));
  if (domains.length === 0) {
    errors.domains = "At least one domain. Records are only ever written inside these.";
  } else if (badDomain !== undefined) {
    errors.domains = `${badDomain} isn't a domain.`;
  }

  const rows = form.credentials.filter((row) => row.name.trim() !== "" || row.value.trim() !== "");
  if (rows.length === 0) {
    errors.credentials = "The provider's credentials, so ExternalDNS can write records.";
  } else if (rows.some((row) => !ENV_NAME.test(row.name.trim()))) {
    errors.credentials = "Each credential needs a name that can be an environment variable.";
  } else if (rows.some((row) => row.value.trim() === "")) {
    errors.credentials = "Every credential needs a value.";
  }

  if (Object.keys(errors).length === 0) {
    const proposed = fromDnsForm(form, namespace);
    const conflict = domainConflicts([...existing, proposed], name)[0];
    if (conflict !== undefined) {
      errors.domains = conflict;
    }
  }
  return errors;
}

/**
 * A provider with a namespace added to or taken from what it publishes.
 *
 * @param provider
 * @param namespace
 * @param publish
 * @returns
 */
export function withNamespace(provider: DnsProvider, namespace: string, publish: boolean): DnsProvider {
  const current = provider.spec.namespaces ?? [];
  const namespaces = publish
    ? [...new Set([...current, namespace])].toSorted()
    : current.filter((each) => each !== namespace);
  return { ...provider, spec: { ...provider.spec, namespaces } };
}
