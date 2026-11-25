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
import type { ServiceOffering } from "../offerings/types";
import type { Bucket, NewS3Credentials, S3CredentialsSummary, S3Identity } from "../storage/types";
import type { WebApplication } from "../webapp/types";

/**
 * The calls this app makes.
 */
export interface KubeClient {
  /**
   * Who the API server takes the person to be. Anyone it accepts may
   * ask, whatever RBAC grants them, so a 401 here means the API server
   * doesn't accept them at all.
   *
   * @returns
   */
  whoAmI(): Promise<{ username: string; groups: string[] }>;

  /**
   * Whether RBAC lets the person do something. Anyone the API server
   * accepts may ask, about themselves.
   *
   * @param permission
   * @returns
   */
  canI(permission: Permission): Promise<boolean>;

  /**
   * Every namespace the person may list.
   *
   * @returns
   */
  listNamespaces(): Promise<Namespace[]>;

  /**
   * The name of every namespace in the cluster, whoever is asking.
   *
   * This is the one read not made as the person, because Kubernetes
   * can't say which namespaces someone has access to, only whether
   * they have access to one it's asked about. Nothing here is to be
   * shown to anyone: it's what reachableNamespaces checks them against.
   *
   * @returns
   */
  listNamespaceNames(): Promise<string[]>;

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
   * One ConfigMap, or nothing when it isn't there.
   *
   * @param namespace
   * @param name
   * @returns
   */
  getConfigMap(namespace: string, name: string): Promise<ConfigMap | undefined>;

  /**
   * Makes a ConfigMap, or replaces one when it carries the
   * resourceVersion it was read at; a 409 when it changed since.
   *
   * @param configMap
   */
  saveConfigMap(configMap: ConfigMap): Promise<void>;

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
   * Cirrus's ServiceOfferings, in one namespace or in all of them.
   * Empty when Cirrus's CRD for them isn't installed.
   *
   * @param namespace
   * @returns
   */
  listServiceOfferings(namespace?: string): Promise<ServiceOffering[]>;

  /**
   * SeaweedFS's Buckets, in one namespace or in all of them. Empty when
   * SeaweedFS's operator isn't installed.
   *
   * @param namespace
   * @returns
   */
  listBuckets(namespace?: string): Promise<Bucket[]>;

  /**
   * One Bucket.
   *
   * @param namespace
   * @param name
   * @returns
   */
  getBucket(namespace: string, name: string): Promise<Bucket>;

  /**
   * Makes a Bucket.
   *
   * @param bucket
   * @returns
   */
  createBucket(bucket: Bucket): Promise<Bucket>;

  /**
   * Replaces a Bucket's spec, at the resourceVersion it carries; a 409
   * when it changed since.
   *
   * @param bucket
   * @returns
   */
  replaceBucket(bucket: Bucket): Promise<Bucket>;

  /**
   * Deletes a Bucket, if it's there. What happens to its contents is
   * its reclaim policy's to say.
   *
   * @param namespace
   * @param name
   */
  deleteBucket(namespace: string, name: string): Promise<void>;

  /**
   * SeaweedFS's S3Identities, its S3 users, in one namespace or in all
   * of them. Empty when SeaweedFS's operator isn't installed.
   *
   * @param namespace
   * @returns
   */
  listS3Identities(namespace?: string): Promise<S3Identity[]>;

  /**
   * One S3Identity.
   *
   * @param namespace
   * @param name
   * @returns
   */
  getS3Identity(namespace: string, name: string): Promise<S3Identity>;

  /**
   * Makes an S3Identity: asks SeaweedFS's operator for a user.
   *
   * @param identity
   * @returns
   */
  createS3Identity(identity: S3Identity): Promise<S3Identity>;

  /**
   * Replaces an S3Identity's spec, at the resourceVersion it carries; a
   * 409 when it changed since.
   *
   * @param identity
   * @returns
   */
  replaceS3Identity(identity: S3Identity): Promise<S3Identity>;

  /**
   * SeaweedFS's S3Credentials, the key pairs it writes into Secrets for
   * its users, in one namespace or in all of them: where the keys are
   * and the access key's ID, never the secret key. Empty when
   * SeaweedFS's operator isn't installed.
   *
   * @param namespace
   * @returns
   */
  listS3Credentials(namespace?: string): Promise<S3CredentialsSummary[]>;

  /**
   * Asks SeaweedFS's operator for a new key pair for a user, written
   * into a Secret by the name given.
   *
   * @param credentials
   * @returns
   */
  createS3Credentials(credentials: NewS3Credentials): Promise<S3CredentialsSummary>;

  /**
   * Deletes an S3Credentials, if it's there. Whether the key stops
   * working is its reclaim policy's to say.
   *
   * @param namespace
   * @param name
   */
  deleteS3Credentials(namespace: string, name: string): Promise<void>;

  /**
   * WebApplications, in one namespace or in all of them.
   *
   * @param namespace
   * @returns
   */
  listWebApplications(namespace?: string): Promise<WebApplication[]>;

  /**
   * Watches WebApplications until stop is called or the API server
   * ends it. Everything already there comes first, as if just changed,
   * so nothing is missed between a page being drawn and this starting.
   *
   * @param scope a namespace, or one application in it; nothing for
   *   every namespace
   * @param onChange called for each change
   * @param onEnd called once when it stops, with why if it wasn't
   *   asked to: a KubeError, or nothing when it simply ran its course
   * @returns how to stop it
   */
  watchWebApplications(
    scope: WatchScope,
    onChange: () => void,
    onEnd: (error?: KubeError) => void,
  ): Promise<() => void>;

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
   * Asks for a WebApplication to be deleted. Cirrus's finalizer holds
   * it until it has cleaned up what lives outside the namespace, and
   * Kubernetes removes everything it owns after. One already gone
   * counts as deleted.
   *
   * @param namespace
   * @param name
   * @returns
   */
  deleteWebApplication(namespace: string, name: string): Promise<void>;

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
 * Something someone might do, as RBAC sees it.
 *
 * - group: the resource's API group; the core group unless said
 * - namespace: where; nothing means in every namespace
 * - name: one object, for rules that name theirs
 */
export interface Permission {
  verb: string;
  resource: string;
  group?: string;
  namespace?: string;
  name?: string;
}

/**
 * Which WebApplications a watch covers.
 */
export interface WatchScope {
  namespace?: string;
  name?: string;
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
