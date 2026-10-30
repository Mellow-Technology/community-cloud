/**
 * @file
 * Everything Meteorologist asks of the Kubernetes API, as one
 * interface.
 *
 * The pages and actions only ever see this. Behind it is either the
 * real API server, reached as whoever is signed in, or an in-memory
 * cluster for development; and if the way the API is reached changes —
 * a different client library, a service account with impersonation in
 * place of forwarded tokens — it changes behind here and nowhere else.
 *
 * Errors come out as KubeError whichever is behind it, carrying the
 * HTTP status the API server gave, so a page can tell "you may not"
 * from "there's no such thing" without knowing about either client.
 */
import type {
  Certificate,
  ConfigMap,
  LimitRange,
  Namespace,
  PostgresCluster,
  ResourceQuota,
  SecretSummary,
  ServiceAccount,
  Workload,
} from "./types";
import type { ClusterUsage } from "../cluster";
import type { DnsProvider } from "../dns/types";
import type { WebApplication } from "../webapp/types";

/**
 * The calls this app makes.
 */
export interface KubeClient {
  /**
   * Every namespace the person may list.
   *
   * @returns
   */
  listNamespaces(): Promise<Namespace[]>;

  /**
   * One namespace.
   *
   * @param name
   * @returns
   */
  getNamespace(name: string): Promise<Namespace>;

  /**
   * Sets or removes labels on a namespace, with a JSON merge patch. A
   * null removes the label.
   *
   * @param name
   * @param labels
   * @returns the namespace as it is afterwards
   */
  patchNamespaceLabels(name: string, labels: Record<string, string | null>): Promise<Namespace>;

  /**
   * Sets or removes annotations on a namespace, as for labels.
   *
   * @param name
   * @param annotations
   * @returns the namespace as it is afterwards
   */
  patchNamespaceAnnotations(name: string, annotations: Record<string, string | null>): Promise<Namespace>;

  /**
   * Makes a namespace.
   *
   * @param name
   * @param labels
   * @param annotations
   * @returns
   */
  createNamespace(
    name: string,
    labels: Record<string, string>,
    annotations: Record<string, string>,
  ): Promise<Namespace>;

  /**
   * The regions the cluster's nodes are in, from their
   * topology.kubernetes.io/region labels.
   *
   * @returns
   */
  listRegions(): Promise<string[]>;

  /**
   * Each node's capacity and what its kubelet says it's using, and the
   * phase of every pod. Needs cluster-wide reads, including nodes/proxy,
   * so for most people it's a 403.
   *
   * @returns
   */
  getClusterUsage(): Promise<ClusterUsage>;

  /**
   * ResourceQuotas, in one namespace or in all of them.
   *
   * @param namespace
   * @returns
   */
  listResourceQuotas(namespace?: string): Promise<ResourceQuota[]>;

  /**
   * Makes or replaces a ResourceQuota, as Meteorologist's own.
   *
   * @param quota
   */
  applyResourceQuota(quota: ResourceQuota): Promise<void>;

  /**
   * Removes a ResourceQuota, if it's there.
   *
   * @param namespace
   * @param name
   */
  deleteResourceQuota(namespace: string, name: string): Promise<void>;

  /**
   * One LimitRange, or undefined when there's no such thing.
   *
   * @param namespace
   * @param name
   * @returns
   */
  getLimitRange(namespace: string, name: string): Promise<LimitRange | undefined>;

  /**
   * Makes or replaces a LimitRange, as Meteorologist's own.
   *
   * @param limitRange
   */
  applyLimitRange(limitRange: LimitRange): Promise<void>;

  /**
   * Removes a LimitRange, if it's there.
   *
   * @param namespace
   * @param name
   */
  deleteLimitRange(namespace: string, name: string): Promise<void>;

  /**
   * One ServiceAccount, or undefined when it isn't there (yet).
   *
   * @param namespace
   * @param name
   * @returns
   */
  getServiceAccount(namespace: string, name: string): Promise<ServiceAccount | undefined>;

  /**
   * Sets which pull Secrets a ServiceAccount names, making it if
   * Kubernetes hasn't yet. A namespace's default one is made moments
   * after the namespace, so straight after creating one it may not
   * be there.
   *
   * @param namespace
   * @param name
   * @param secrets
   */
  setImagePullSecrets(namespace: string, name: string, secrets: string[]): Promise<void>;

  /**
   * The Secrets in a namespace, by name, type and metadata only.
   *
   * @param namespace
   * @returns
   */
  listSecrets(namespace: string): Promise<SecretSummary[]>;

  /**
   * One key of a Secret, decoded, or undefined when the Secret or the
   * key isn't there. Only ever called on the server, for a value it
   * uses there and then, such as a GitLab token.
   *
   * @param namespace
   * @param name
   * @param key
   * @returns
   */
  readSecretValue(namespace: string, name: string, key: string): Promise<string | undefined>;

  /**
   * Makes or replaces a Secret from plain strings, as Meteorologist's
   * own. Keys it doesn't name are left as they were.
   *
   * @param namespace
   * @param name
   * @param data
   * @param labels
   * @param annotations
   */
  applySecret(
    namespace: string,
    name: string,
    data: Record<string, string>,
    labels?: Record<string, string>,
    annotations?: Record<string, string>,
  ): Promise<void>;

  /**
   * Removes a Secret, if it's there.
   *
   * @param namespace
   * @param name
   */
  deleteSecret(namespace: string, name: string): Promise<void>;

  /**
   * Every DnsProvider. Empty when Cirrus's CRD for them isn't there.
   *
   * @returns
   */
  listDnsProviders(): Promise<DnsProvider[]>;

  /**
   * Makes a DnsProvider, or sets the spec fields Meteorologist owns on
   * an existing one, with server-side apply.
   *
   * @param provider
   */
  applyDnsProvider(provider: DnsProvider): Promise<void>;

  /**
   * Removes a DnsProvider, if it's there. Cirrus's instances for it go
   * with it.
   *
   * @param name
   */
  deleteDnsProvider(name: string): Promise<void>;

  /**
   * The ConfigMaps in a namespace with a label, such as the records
   * the installer leaves of each package it installs.
   *
   * @param namespace
   * @param labelSelector
   * @returns
   */
  listConfigMaps(namespace: string, labelSelector: string): Promise<ConfigMap[]>;

  /**
   * The Deployments and StatefulSets in a namespace, as far as how
   * many of each are ready.
   *
   * @param namespace
   * @returns
   */
  listWorkloads(namespace: string): Promise<Workload[]>;

  /**
   * CloudNativePG Clusters, in one namespace or in all of them. Empty
   * when CloudNativePG isn't installed.
   *
   * @param namespace
   * @returns
   */
  listPostgresClusters(namespace?: string): Promise<PostgresCluster[]>;

  /**
   * cert-manager Certificates, in one namespace or in all of them.
   * Empty when cert-manager isn't installed.
   *
   * @param namespace
   * @returns
   */
  listCertificates(namespace?: string): Promise<Certificate[]>;

  /**
   * WebApplications, in one namespace or in all of them.
   *
   * @param namespace
   * @returns
   */
  listWebApplications(namespace?: string): Promise<WebApplication[]>;

  /**
   * One WebApplication.
   *
   * @param namespace
   * @param name
   * @returns
   */
  getWebApplication(namespace: string, name: string): Promise<WebApplication>;

  /**
   * Makes a new WebApplication.
   *
   * @param app
   * @returns
   */
  createWebApplication(app: WebApplication): Promise<WebApplication>;

  /**
   * Replaces a WebApplication's spec. The resourceVersion it carries
   * makes this fail with a conflict if it changed in the meantime.
   *
   * @param app
   * @returns
   */
  replaceWebApplication(app: WebApplication): Promise<WebApplication>;

  /**
   * Makes a Secret from plain strings.
   *
   * @param namespace
   * @param name
   * @param data
   * @param labels
   * @param type Opaque unless said
   * @param annotations
   */
  createSecret(
    namespace: string,
    name: string,
    data: Record<string, string>,
    labels?: Record<string, string>,
    type?: string,
    annotations?: Record<string, string>,
  ): Promise<void>;
}

/**
 * Something the API server refused, or couldn't be asked.
 *
 * - status: the HTTP status, or 0 when the API server couldn't be
 *   reached at all
 * - reason: the API server's reason, such as "Forbidden" or "Conflict"
 */
export class KubeError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.name = "KubeError";
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Whether an error is the API server saying there's no such thing.
 *
 * @param error
 * @returns
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof KubeError && error.status === 404;
}

/**
 * Whether an error is RBAC refusing the person.
 *
 * @param error
 * @returns
 */
export function isForbidden(error: unknown): boolean {
  return error instanceof KubeError && error.status === 403;
}

/**
 * A sentence a person can read, from any error the client threw.
 *
 * @param error
 * @returns
 */
export function describeError(error: unknown): string {
  if (error instanceof KubeError) {
    switch (error.status) {
      case 0:
        return `The Kubernetes API couldn't be reached: ${error.message}`;
      case 401:
        return "The Kubernetes API didn't accept your sign-in. Signing out and in again usually fixes it.";
      case 403:
        return `You don't have permission for that. ${error.message}`;
      case 409:
        return error.reason === "AlreadyExists"
          ? `That already exists. ${error.message}`
          : "Someone else changed this while you were editing it. Reload to see their change, then try again.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * A read that either worked or didn't, so a page can draw what it got
 * and say what it didn't, rather than failing whole.
 */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Runs a read, catching its failure.
 *
 * @param read
 * @returns
 */
export async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error };
  }
}
