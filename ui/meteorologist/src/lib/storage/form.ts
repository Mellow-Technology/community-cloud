/**
 * @file
 * A Bucket as the form edits it, and back.
 *
 * The form is flat strings and switches; the resource is SeaweedFS's
 * spec. Turning a form back into a spec starts from the resource as it
 * is, so fields the form doesn't show are kept.
 *
 * Some things can only be chosen when a bucket is made: its name in
 * SeaweedFS, object lock, and taking over a bucket that's already
 * there. And versioning, once on, can only be suspended, never turned
 * off again, which is S3's rule rather than SeaweedFS's.
 */
import { parseQuantity } from "../quantity";
import {
  BUCKET_ACTIONS,
  BUCKET_GROUP,
  BUCKET_VERSION,
  SEAWEED_REF,
  type Bucket,
  type BucketAction,
  type ReclaimPolicy,
  type Versioning,
} from "./types";

export interface BucketAccessForm {
  user: string;
  actions: BucketAction[];
}

export interface BucketForm {
  namespace: string;
  name: string;
  // Its name in SeaweedFS; blank is namespace-name
  bucketName: string;
  quota: string;
  enforceQuota: boolean;
  versioning: Versioning;
  objectLock: boolean;
  anonymousRead: boolean;
  reclaimPolicy: ReclaimPolicy;
  access: BucketAccessForm[];
  replication: string;
  ttl: string;
  diskType: string;
  adoptExisting: boolean;
}

export type BucketFormErrors = Partial<Record<keyof BucketForm | `access.${number}`, string>>;

/**
 * A new bucket's form.
 *
 * @param namespace
 * @returns
 */
export function emptyBucketForm(namespace = ""): BucketForm {
  return {
    namespace,
    name: "",
    bucketName: "",
    quota: "",
    enforceQuota: true,
    versioning: "Off",
    objectLock: false,
    anonymousRead: false,
    reclaimPolicy: "Retain",
    access: [],
    replication: "",
    ttl: "",
    diskType: "",
    adoptExisting: false,
  };
}

/**
 * The name a bucket gets in SeaweedFS when none is typed: the
 * namespace's name before its own, as Cirrus names the buckets it
 * makes, since every namespace's buckets share one list.
 *
 * @param namespace
 * @param name
 * @returns
 */
export function defaultBucketName(namespace: string, name: string): string {
  return `${namespace}-${name}`.slice(0, 63).replace(/-+$/, "");
}

/**
 * A Bucket as the form shows it.
 *
 * @param bucket
 * @returns
 */
export function toBucketForm(bucket: Bucket): BucketForm {
  const { spec } = bucket;
  return {
    namespace: bucket.metadata.namespace ?? "",
    name: bucket.metadata.name,
    bucketName: bucket.status?.bucketName ?? spec.name ?? bucket.metadata.name,
    quota: spec.quota?.size === undefined ? "" : String(spec.quota.size),
    enforceQuota: spec.quota?.enforce ?? true,
    versioning: spec.versioning ?? "Off",
    objectLock: spec.objectLock ?? false,
    anonymousRead: spec.anonymousRead ?? false,
    reclaimPolicy: spec.reclaimPolicy ?? "Retain",
    access: (spec.access ?? []).map((each) => ({ user: each.user, actions: [...each.actions] })),
    replication: spec.placement?.replication ?? "",
    ttl: spec.placement?.ttl ?? "",
    diskType: spec.placement?.diskType ?? "",
    adoptExisting: spec.adoptExisting ?? false,
  };
}

/**
 * A text field, trimmed, or nothing when it's blank.
 *
 * @param value
 * @returns
 */
function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The Bucket the form describes. Given the one it edits, starts from
 * that, keeping what the form doesn't show and what can't change.
 *
 * @param form already checked with validateBucketForm
 * @param existing
 * @returns
 */
export function fromBucketForm(form: BucketForm, existing?: Bucket): Bucket {
  const namespace = form.namespace.trim();
  const name = form.name.trim();
  const spec = structuredClone(existing?.spec ?? { clusterRef: SEAWEED_REF });

  if (existing === undefined) {
    spec.name = nonEmpty(form.bucketName) ?? defaultBucketName(namespace, name);
    spec.objectLock = form.objectLock;
    spec.adoptExisting = form.adoptExisting;
  }

  const quota = nonEmpty(form.quota);
  if (quota === undefined) {
    delete spec.quota;
  } else {
    spec.quota = { ...spec.quota, size: quota, enforce: form.enforceQuota };
  }
  spec.versioning = form.versioning;
  spec.anonymousRead = form.anonymousRead;
  spec.reclaimPolicy = form.reclaimPolicy;

  const access = form.access
    .map((each) => ({
      user: each.user.trim(),
      actions: BUCKET_ACTIONS.filter((action) => each.actions.includes(action)),
    }))
    .filter((each) => each.user !== "");
  if (access.length === 0) {
    delete spec.access;
  } else {
    spec.access = access;
  }

  const placement = { ...spec.placement };
  for (const [key, value] of [
    ["replication", form.replication],
    ["ttl", form.ttl],
    ["diskType", form.diskType],
  ] as const) {
    const set = nonEmpty(value);
    if (set === undefined) {
      delete placement[key];
    } else {
      placement[key] = set;
    }
  }
  if (Object.keys(placement).length === 0) {
    delete spec.placement;
  } else {
    spec.placement = placement;
  }

  return {
    apiVersion: `${BUCKET_GROUP}/${BUCKET_VERSION}`,
    kind: "Bucket",
    metadata: existing ? { ...existing.metadata } : { name, namespace },
    spec,
  };
}

// Kubernetes names: a DNS label
const RESOURCE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

// S3's rules for a bucket's name, less the dots SeaweedFS's filer
// treats as part of a path
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

// SeaweedFS's replication: copies in other data centers, other racks,
// and other servers in the same rack, one digit each
const REPLICATION = /^[0-9]{3}$/;

// SeaweedFS's TTLs: a number and a unit
const TTL = /^[1-9][0-9]*[mhdwMy]$/;

/**
 * What's wrong with the form, by field. Empty when nothing is.
 *
 * @param form
 * @param existing the bucket being edited, for what can't change
 * @returns
 */
export function validateBucketForm(form: BucketForm, existing?: Bucket): BucketFormErrors {
  const errors: BucketFormErrors = {};
  if (existing === undefined) {
    if (form.namespace.trim() === "") {
      errors.namespace = "Choose the namespace it's in.";
    }
    const name = form.name.trim();
    if (name === "" || name.length > 63 || !RESOURCE_NAME.test(name)) {
      errors.name = "Name it with lower-case letters, digits and hyphens, starting and ending with a letter or digit.";
    }
    const bucketName = nonEmpty(form.bucketName) ?? defaultBucketName(form.namespace.trim(), name);
    // Made from the namespace and name, it's only wrong when they are
    if (
      !BUCKET_NAME.test(bucketName) &&
      !(nonEmpty(form.bucketName) === undefined && (errors.name || errors.namespace))
    ) {
      errors.bucketName = "3 to 63 lower-case letters, digits and hyphens, starting and ending with a letter or digit.";
    }
    if (form.objectLock && form.versioning !== "Enabled") {
      errors.objectLock = "Object lock needs versioning on.";
    }
  }
  if (nonEmpty(form.quota) !== undefined && !(parseQuantity(form.quota.trim()) ?? 0)) {
    errors.quota = "A size, such as 20Gi or 500Mi.";
  }
  const versioned = existing?.status?.versioning ?? existing?.spec.versioning ?? "Off";
  if (form.versioning === "Off" && versioned !== "Off") {
    errors.versioning = "Once versioning has been on it can only be suspended, not turned off.";
  }
  if ((existing?.spec.objectLock ?? form.objectLock) && form.versioning !== "Enabled") {
    errors.versioning = "A bucket with object lock has to keep versioning on.";
  }
  form.access.forEach((each, index) => {
    if (each.user.trim() !== "" && each.actions.length === 0) {
      errors[`access.${index}`] = "Choose at least one thing it may do.";
    }
  });
  if (nonEmpty(form.replication) !== undefined && !REPLICATION.test(form.replication.trim())) {
    errors.replication = "Three digits, such as 001: copies in other data centers, other racks, and the same rack.";
  }
  if (nonEmpty(form.ttl) !== undefined && !TTL.test(form.ttl.trim())) {
    errors.ttl = "A number and a unit, such as 30d: m, h, d, w, M or y.";
  }
  return errors;
}
