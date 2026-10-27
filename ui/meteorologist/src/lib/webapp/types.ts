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
export const DEFAULT_REPLICAS = 1;
export const DEFAULT_PORT = 8080;
export const DEFAULT_TAG = "latest";
export const DEFAULT_GITLAB_URL = "https://gitlab.com";
export const DEFAULT_GITLAB_REF = "main";
export const DEFAULT_TOKEN_KEY = "token";
export const DEFAULT_IMAGE_TAG = "{commit_sha}";

// The condition types Cirrus sets, from conditions.rs
export const CONDITION_READY = "Ready";
export const CONDITION_PROVISIONED = "Provisioned";
export const CONDITION_ROLLED_OUT = "RolledOut";
export const CONDITION_WEBHOOK = "WebhookRegistered";

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
  imageTag?: string;
}

export interface SourceSpec {
  gitlab?: GitLabSource;
}

export interface WebApplicationSpec {
  image: ImageSpec;
  replicas?: number;
  port?: number;
  env?: EnvVar[];
  resources?: ResourceRequirements;
  imagePullSecrets?: string[];
  healthCheck?: HealthCheckSpec;
  hostnames?: string[];
  postgres?: PostgresSpec;
  bucket?: BucketSpec;
  rabbitmq?: RabbitMqSpec;
  migrations?: MigrationsSpec;
  source?: SourceSpec;
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
}

export interface WebApplication {
  apiVersion: typeof API_VERSION;
  kind: typeof KIND;
  metadata: ObjectMeta;
  spec: WebApplicationSpec;
  status?: WebApplicationStatus;
}
