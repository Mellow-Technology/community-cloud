/**
 * @file
 * The WebApplication resource, as TypeScript.
 *
 * Cirrus defines the resource in Rust, in operators/cirrus/src/crd.rs,
 * and that file is the authority: these types follow it field for
 * field, with the same camelCase names serde gives them on the wire.
 * Where the Rust has a default, the field is optional here, since a
 * resource written by hand may leave it out and the API server stores
 * what it was given.
 *
 * The Kubernetes types it borrows are in ../kube/types.ts.
 */
import type { Condition, EnvVar, ObjectMeta, ResourceRequirements } from "../kube/types";

// The API group and version Cirrus serves
export const GROUP = "community-cloud.technology";
export const VERSION = "v1alpha1";
export const API_VERSION = `${GROUP}/${VERSION}`;
export const KIND = "WebApplication";
export const PLURAL = "webapplications";

// The defaults serde fills in, in crd.rs. Repeated here so the form
// can show what leaving a field empty will mean.
// The port has no default: left out, Cirrus reads it from the image.
export const DEFAULT_REPLICAS = 1;
export const DEFAULT_TAG = "latest";
export const DEFAULT_GITLAB_URL = "https://gitlab.com";
export const DEFAULT_GITLAB_REF = "main";
export const DEFAULT_TOKEN_KEY = "token";

// The condition types Cirrus sets, from conditions.rs
export const CONDITION_READY = "Ready";
export const CONDITION_PROVISIONED = "Provisioned";
export const CONDITION_ROLLED_OUT = "RolledOut";
export const CONDITION_HEALTHY = "Healthy";
export const CONDITION_WEBHOOK = "WebhookRegistered";
export const CONDITION_RELEASE_CHECKED = "ReleaseChecked";

export interface ImageSpec {
  repository: string;
  tag?: string;
}

export interface HealthCheckSpec {
  path: string;
}

// Present means "give me one". Empty today, and kept open so a field
// Cirrus adds later survives an edit made here.
export type PostgresSpec = Record<string, unknown>;
export type RabbitMqSpec = Record<string, unknown>;

/**
 * A connection to a ServiceOffering: its variables start with the
 * name, or the offering's.
 */
export interface ConnectionSpec {
  offering: string;
  namespace?: string;
  name?: string;
}

/**
 * How an application offers itself: the ServiceOffering Cirrus makes
 * for its Service.
 */
export interface OfferSpec {
  title?: string;
  description?: string;
  protocol?: string;
  path?: string;
  shareWith?: string[];
}

/**
 * Community Cloud's storage types, each a StorageClass on one kind of
 * disk (k8s/storage/StorageClass), and a RAM disk, which is memory
 * emptied whenever the pod restarts.
 */
export type StorageType = "fast" | "sata" | "hdd" | "ram";

// A RAM disk has no StorageClass: it's memory, not a claim
export const STORAGE_TYPES: Array<{ value: StorageType; label: string; storageClass?: string }> = [
  { value: "fast", label: "Fast (NVMe)", storageClass: "cc-local-ssd-fast" },
  { value: "sata", label: "SATA SSD", storageClass: "cc-local-ssd-sata" },
  { value: "hdd", label: "Hard disk", storageClass: "cc-local-hdd" },
  { value: "ram", label: "RAM disk" },
];

/**
 * A volume of the application's own, mounted into every copy.
 */
export interface VolumeSpec {
  name: string;
  mountPath: string;
  size: string;
  // Fast when left out
  type?: StorageType;
}

export interface BucketSpec {
  quota?: string;
  [other: string]: unknown;
}

export interface MigrationsSpec {
  command: string[];
  args?: string[];
  timeoutSeconds?: number;
}

export interface SecretKeyRef {
  name: string;
  key?: string;
}

export interface GitLabSource {
  url?: string;
  project: string;
  ref?: string;
  tokenSecret: SecretKeyRef;
  // Left out, Cirrus finds the tag from the commit
  imageTag?: string;
  findImageByPushTime?: boolean;
}

export interface SourceSpec {
  gitlab?: GitLabSource;
}

/**
 * One of the application's own secrets: its value is in the Secret
 * <app>-secrets, under its name, never in the spec.
 */
export interface SecretValueSpec {
  name: string;
  // What it is and where to get it, for whoever sets it
  description?: string;
}

/**
 * One of the namespace's shared values, set as a variable of its name
 * or the one in as.
 */
export interface SharedValueSpec {
  name: string;
  as?: string;
}

export interface WebApplicationSpec {
  image: ImageSpec;
  replicas?: number;
  port?: number;
  env?: EnvVar[];
  secrets?: SecretValueSpec[];
  shared?: SharedValueSpec[];
  resources?: ResourceRequirements;
  imagePullSecrets?: string[];
  healthCheck?: HealthCheckSpec;
  hostnames?: string[];
  postgres?: PostgresSpec;
  bucket?: BucketSpec;
  volumes?: VolumeSpec[];
  connections?: ConnectionSpec[];
  offers?: OfferSpec;
  rabbitmq?: RabbitMqSpec;
  migrations?: MigrationsSpec;
  source?: SourceSpec;
  // Whether the image's labels may fill in what the spec leaves out;
  // on unless false
  detect?: boolean;
}

export interface Release {
  commit: string;
  tag: string;
  digest?: string;
  repository: string;
}

export interface WebhookStatus {
  hookId: number;
  url: string;
}

export interface WebApplicationStatus {
  observedGeneration?: number;
  conditions?: Condition[];
  release?: Release;
  deployedImage?: string;
  migrationJob?: string;
  url?: string;
  webhook?: WebhookStatus;
  lastChecked?: string;
  // The port the Service is on: the spec's, or the one read from the
  // image
  port?: number;
  imagePorts?: ImagePort[];
  // Which of its secrets and shared values have a value, never what
  environment?: { secrets?: ValueStatus[]; shared?: ValueStatus[] };
  // What the image's labels filled in
  detected?: DetectedStatus;
}

export interface DetectedStatus {
  image: string;
  labels?: Record<string, string>;
  applied?: Array<{ field: string; value?: string; evidence: string; image: string }>;
}

export interface ValueStatus {
  name: string;
  set: boolean;
  // For a shared value, once it's there
  kind?: "plain" | "secret";
}

export interface ImagePort {
  image: string;
  port: number;
}

export interface WebApplication {
  apiVersion: typeof API_VERSION;
  kind: typeof KIND;
  metadata: ObjectMeta;
  spec: WebApplicationSpec;
  status?: WebApplicationStatus;
}
