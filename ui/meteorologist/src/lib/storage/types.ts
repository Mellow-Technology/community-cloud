/**
 * @file
 * SeaweedFS's Bucket resource (seaweed.seaweedfs.com/v1), as far as
 * Meteorologist reads and writes it. SeaweedFS's operator makes the
 * bucket it describes in the cluster's SeaweedFS, which it names in
 * clusterRef, and reports back in its status.
 *
 * A Bucket may be in any namespace SeaweedFS's ResourceReferenceGrant
 * lets in: those labelled storage.community-cloud.technology/buckets.
 * Bucket names are one list for the whole of SeaweedFS, which is why
 * spec.name, the bucket's own name, isn't simply the resource's.
 */
import type { Condition, ObjectMeta } from "../kube/types";

export type { Condition };

export const BUCKET_GROUP = "seaweed.seaweedfs.com";
export const BUCKET_VERSION = "v1";
export const BUCKET_PLURAL = "buckets";

// The cluster's SeaweedFS, as the installer makes it
// (k8s/storage/SeaweedFS/SeaweedFS.yaml)
export const SEAWEED_REF = { name: "seaweed", namespace: "seaweedfs" };

// What a user may be allowed to do with a bucket
export const BUCKET_ACTIONS = ["Read", "Write", "List", "Tagging", "Admin"] as const;
export type BucketAction = (typeof BUCKET_ACTIONS)[number];

export type Versioning = "Off" | "Enabled" | "Suspended";
export type ReclaimPolicy = "Retain" | "Delete";
export type BucketPhase = "Pending" | "Ready" | "Failed" | "Terminating";

export interface BucketAccess {
  user: string;
  actions: BucketAction[];
}

export interface BucketPlacement {
  replication?: string;
  ttl?: string;
  diskType?: string;
  dataCenter?: string;
  rack?: string;
  dataNode?: string;
  fsync?: boolean;
  readOnly?: boolean;
  volumeGrowthCount?: number;
  worm?: boolean;
}

export interface BucketSpec {
  clusterRef: { name: string; namespace?: string };
  // The bucket's own name in SeaweedFS; the resource's name when left out
  name?: string;
  access?: BucketAccess[];
  adoptExisting?: boolean;
  anonymousRead?: boolean;
  objectLock?: boolean;
  owner?: string;
  placement?: BucketPlacement;
  quota?: { size?: string | number; enforce?: boolean };
  reclaimPolicy?: ReclaimPolicy;
  versioning?: Versioning;
}

export interface BucketStatus {
  bucketName?: string;
  phase?: BucketPhase;
  conditions?: Condition[];
  observedGeneration?: number;
  objectLockEnabled?: boolean;
  ownerIdentity?: string;
  versioning?: Versioning;
  quota?: { enforced?: boolean; sizeBytes?: number };
  usage?: { lastUpdated?: string; objectCount?: number; sizeBytes?: number };
}

export interface Bucket {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta & { ownerReferences?: Array<{ kind: string; name: string; apiVersion?: string }> };
  spec: BucketSpec;
  status?: BucketStatus;
}

/**
 * An S3 user, as SeaweedFS's operator makes one from an S3Identity.
 * Its name in SeaweedFS (status.identityName) is what a Bucket's access
 * names, and is one list for the whole of SeaweedFS.
 */
export interface S3Identity {
  apiVersion?: string;
  kind?: string;
  metadata: Bucket["metadata"];
  spec: {
    seaweedRef: { name: string; namespace?: string };
    // Its name in SeaweedFS; the resource's when left out
    name?: string;
    account?: { displayName?: string; email?: string };
    disabled?: boolean;
    reclaimPolicy?: ReclaimPolicy;
  };
  status?: {
    identityName?: string;
    phase?: BucketPhase;
    conditions?: Condition[];
    observedGeneration?: number;
  };
}

/**
 * A key pair for an S3 user, which SeaweedFS's operator makes and
 * writes into a Secret. Where the keys are, and the access key's ID,
 * which isn't secret; never the secret key itself.
 */
export interface S3CredentialsSummary {
  namespace: string;
  name: string;
  // The S3Identity it's for, by resource name, in the same namespace
  identity: string;
  // The Secret the keys are in, and where, when it's said
  secretName?: string;
  secretNamespace?: string;
  // The fields of the Secret each key is under
  accessKeyField?: string;
  secretKeyField?: string;
  // The access key's ID, once SeaweedFS's operator has made it
  accessKey?: string;
  phase?: BucketPhase;
  message?: string;
  reclaimPolicy?: ReclaimPolicy;
  createdAt?: string;
}

/**
 * The Secret a key pair is in, as it's shown: namespace/name when it's
 * in another namespace.
 *
 * @param credentials
 * @returns
 */
export function secretLabel(credentials: S3CredentialsSummary): string {
  const name = credentials.secretName ?? credentials.name;
  return credentials.secretNamespace && credentials.secretNamespace !== credentials.namespace
    ? `${credentials.secretNamespace}/${name}`
    : name;
}

/**
 * What a new key pair is asked for with.
 */
export interface NewS3Credentials {
  namespace: string;
  name: string;
  // The S3Identity it's for
  identity: string;
  secretName: string;
  reclaimPolicy: ReclaimPolicy;
  seaweedRef: { name: string; namespace?: string };
  labels?: Record<string, string>;
}
