/**
 * @file
 * The few core Kubernetes types this app reads, written out by hand.
 *
 * Only as far as the pages and the pure logic need them, rather than
 * taken from the Kubernetes client. That keeps everything but the one
 * server module that talks to the API free of the client, so the way
 * the API is reached can change without touching the rest.
 */

/**
 * The parts of an object's metadata this app reads or writes.
 */
export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface SecretKeySelector {
  name: string;
  key: string;
  optional?: boolean;
}

/**
 * An environment variable. Either a value, or a reference to where
 * the value lives; this app only edits the first kind and carries the
 * second through untouched.
 */
export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: SecretKeySelector;
    configMapKeyRef?: SecretKeySelector;
    fieldRef?: { fieldPath: string; apiVersion?: string };
    resourceFieldRef?: { resource: string; containerName?: string; divisor?: string };
  };
}

export interface ResourceRequirements {
  limits?: Record<string, string>;
  requests?: Record<string, string>;
  // Anything else the API allows, such as claims, is kept as it was
  [other: string]: unknown;
}

export interface Condition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
  observedGeneration?: number;
  lastTransitionTime?: string;
}

/**
 * A namespace, as far as this app reads one.
 */
export interface Namespace {
  metadata: ObjectMeta;
  status?: { phase?: string };
}

/**
 * A ResourceQuota: the most a namespace may use in total.
 */
export interface ResourceQuota {
  metadata: ObjectMeta;
  spec?: { hard?: Record<string, string> };
  status?: { hard?: Record<string, string>; used?: Record<string, string> };
}

/**
 * One rule in a LimitRange. Only the Container kind is written here.
 */
export interface LimitRangeItem {
  type: string;
  default?: Record<string, string>;
  defaultRequest?: Record<string, string>;
  max?: Record<string, string>;
  min?: Record<string, string>;
}

/**
 * A LimitRange: what each container gets when it doesn't say.
 */
export interface LimitRange {
  metadata: ObjectMeta;
  spec: { limits: LimitRangeItem[] };
}

/**
 * A ServiceAccount, as far as its pull secrets.
 */
export interface ServiceAccount {
  metadata: ObjectMeta;
  imagePullSecrets?: Array<{ name: string }>;
}

/**
 * A Secret's name and type, and never its contents: nothing here needs
 * to read one.
 */
export interface SecretSummary {
  name: string;
  type: string;
}

/**
 * A CloudNativePG Cluster, as far as the pages describe one.
 */
export interface PostgresCluster {
  metadata: ObjectMeta;
  spec?: { instances?: number; storage?: { size?: string; storageClass?: string }; imageName?: string };
  status?: { phase?: string; readyInstances?: number; instances?: number };
}
