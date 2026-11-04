/**
 * @file
 * The DnsProvider resource, as TypeScript.
 *
 * Cirrus defines it in Rust, beside WebApplication, and that is the
 * authority: these types follow it field for field. A DnsProvider is
 * one DNS account — a provider, the domains it holds, and the
 * credentials for it — and the namespaces whose routes it publishes.
 * Cirrus runs one ExternalDNS for each of those namespaces, in a
 * namespace of its own, so the people with access to a namespace never
 * see the credentials that write its records.
 *
 * It's cluster-scoped, so only cluster admins make or change one.
 */
import type { Condition, ObjectMeta } from "../kube/types";
import { GROUP, VERSION } from "../webapp/types";

export const DNS_KIND = "DnsProvider";
export const DNS_PLURAL = "dnsproviders";
export const DNS_API_VERSION = `${GROUP}/${VERSION}`;

// Where Cirrus runs the ExternalDNS instances, and so where their
// credentials have to be. CIRRUS_DNS_NAMESPACE's default.
export const DNS_NAMESPACE = "external-dns";

// The policies ExternalDNS has. Cirrus's default is sync.
export const DNS_POLICIES = ["sync", "upsert-only"] as const;
export type DnsPolicy = (typeof DNS_POLICIES)[number];

export interface DnsProviderSpec {
  provider: string;
  domains: string[];
  excludeDomains?: string[];
  namespaces?: string[];
  credentialsSecret?: string;
  target?: string;
  policy?: DnsPolicy;
  args?: string[];
}

export interface DnsInstanceStatus {
  namespace: string;
  deployment: string;
  ready: boolean;
}

export interface DnsProviderStatus {
  observedGeneration?: number;
  conditions?: Condition[];
  instances?: DnsInstanceStatus[];
}

export interface DnsProvider {
  apiVersion: typeof DNS_API_VERSION;
  kind: typeof DNS_KIND;
  metadata: ObjectMeta;
  spec: DnsProviderSpec;
  status?: DnsProviderStatus;
}

/**
 * The Secret a provider's credentials are in, when it doesn't name one.
 *
 * @param provider the DnsProvider's name
 * @returns
 */
export function defaultCredentialsSecret(provider: string): string {
  return `cirrus-dns-${provider}`;
}
