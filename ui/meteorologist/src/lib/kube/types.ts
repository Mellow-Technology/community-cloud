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
