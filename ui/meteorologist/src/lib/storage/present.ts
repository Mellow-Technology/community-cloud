/**
 * @file
 * A Bucket, as the pages show it: how it's doing, how full it is, and
 * what looks after it.
 */
import { formatBytes, parseQuantity } from "../quantity";
import type { Bucket, BucketPhase, Condition } from "./types";

export interface BucketHealth {
  state: BucketPhase | "Unknown";
  tone: "success" | "warning" | "danger" | "neutral";
  label: string;
  message?: string;
}

// The order the table sorts phases in: trouble first
export const BUCKET_PHASE_ORDER: BucketHealth["state"][] = ["Failed", "Pending", "Terminating", "Unknown", "Ready"];

/**
 * What SeaweedFS's operator reports on everything it makes: a phase,
 * and a Ready condition.
 */
export interface Reported {
  metadata: Bucket["metadata"];
  status?: { phase?: BucketPhase; conditions?: Condition[] };
}

/**
 * How a bucket, or anything else SeaweedFS's operator reports on, is
 * doing, from its phase and its Ready condition.
 *
 * @param bucket
 * @returns
 */
export function bucketHealth(bucket: Reported): BucketHealth {
  const phase = bucket.metadata.deletionTimestamp ? "Terminating" : bucket.status?.phase;
  const ready = bucket.status?.conditions?.find((condition) => condition.type === "Ready");
  const message = ready?.status === "True" ? undefined : ready?.message || undefined;
  switch (phase) {
    case "Ready":
      return { state: "Ready", tone: "success", label: "Ready" };
    case "Pending":
      return { state: "Pending", tone: "warning", label: "Pending", message };
    case "Failed":
      return { state: "Failed", tone: "danger", label: "Failed", message };
    case "Terminating":
      return { state: "Terminating", tone: "neutral", label: "Deleting" };
    default:
      return { state: "Unknown", tone: "neutral", label: "Not reported yet" };
  }
}

/**
 * The bucket's name in SeaweedFS: what S3 clients call it.
 *
 * @param bucket
 * @returns
 */
export function bucketName(bucket: Bucket): string {
  return bucket.status?.bucketName ?? bucket.spec.name ?? bucket.metadata.name;
}

export interface BucketUsage {
  usedBytes?: number;
  quotaBytes?: number;
  objects?: number;
  // Of the quota, 0 to 1, when there's both
  fraction?: number;
  // As the table shows it, e.g. "1.2 GiB of 20 GiB"
  text: string;
}

/**
 * How full a bucket is: what SeaweedFS last counted, against its quota.
 *
 * @param bucket
 * @returns
 */
export function bucketUsage(bucket: Bucket): BucketUsage {
  const usedBytes = bucket.status?.usage?.sizeBytes;
  const size = bucket.spec.quota?.size;
  const quotaBytes = bucket.status?.quota?.sizeBytes ?? (size === undefined ? undefined : parseQuantity(String(size)));
  const objects = bucket.status?.usage?.objectCount;
  const used = usedBytes === undefined ? undefined : formatBytes(usedBytes);
  const quota = quotaBytes === undefined ? undefined : formatBytes(quotaBytes);
  const text =
    used !== undefined && quota !== undefined
      ? `${used} of ${quota}`
      : (used ?? (quota !== undefined ? `Nothing counted yet, of ${quota}` : "Nothing counted yet"));
  return {
    usedBytes,
    quotaBytes,
    objects,
    fraction: usedBytes !== undefined && quotaBytes ? Math.min(1, Math.max(0, usedBytes / quotaBytes)) : undefined,
    text,
  };
}

export interface BucketManager {
  kind: "application" | "installer" | "other";
  name?: string;
  // Where to see it, when Meteorologist has a page for it
  href?: string;
}

/**
 * What else looks after a bucket or a user and may change it back: the
 * application Cirrus made it for, or the installer, which applies its
 * packages' buckets and users again whenever it runs.
 *
 * @param bucket
 * @returns nothing, when it's only people
 */
export function bucketManager(bucket: { metadata: Bucket["metadata"] }): BucketManager | undefined {
  const owner = bucket.metadata.ownerReferences?.find((reference) => reference.kind === "WebApplication");
  if (owner !== undefined) {
    const namespace = bucket.metadata.namespace ?? "";
    return { kind: "application", name: owner.name, href: `/apps/${namespace}/${owner.name}` };
  }
  if (bucket.metadata.labels?.["app.kubernetes.io/managed-by"] === "community-cloud") {
    return { kind: "installer" };
  }
  const other = bucket.metadata.ownerReferences?.[0];
  return other ? { kind: "other", name: `${other.kind} ${other.name}` } : undefined;
}

/**
 * Where a bucket's page is.
 *
 * @param bucket
 * @returns
 */
export function bucketHref(bucket: Bucket): string {
  return `/storage/${encodeURIComponent(bucket.metadata.namespace ?? "")}/${encodeURIComponent(bucket.metadata.name)}`;
}

export interface StorageTotals {
  buckets: number;
  ready: number;
  usedBytes: number;
  quotaBytes: number;
  objects: number;
}

/**
 * Everything at once, for the figures above the table.
 *
 * @param buckets
 * @returns
 */
export function storageTotals(buckets: Bucket[]): StorageTotals {
  return buckets.reduce<StorageTotals>(
    (totals, bucket) => {
      const usage = bucketUsage(bucket);
      return {
        buckets: totals.buckets + 1,
        ready: totals.ready + (bucketHealth(bucket).state === "Ready" ? 1 : 0),
        usedBytes: totals.usedBytes + (usage.usedBytes ?? 0),
        quotaBytes: totals.quotaBytes + (usage.quotaBytes ?? 0),
        objects: totals.objects + (usage.objects ?? 0),
      };
    },
    { buckets: 0, ready: 0, usedBytes: 0, quotaBytes: 0, objects: 0 },
  );
}

/**
 * What deleting a bucket does to what's in it, said before it's done.
 *
 * @param bucket
 * @returns
 */
export function bucketDeletion(bucket: Bucket): { removed: string[]; kept: string[] } {
  const name = bucketName(bucket);
  const deletes = bucket.spec.reclaimPolicy === "Delete";
  return deletes
    ? {
        removed: [
          `The Bucket resource ${bucket.metadata.name}`,
          `The bucket ${name} in SeaweedFS, and everything in it`,
        ],
        kept: [],
      }
    : {
        removed: [`The Bucket resource ${bucket.metadata.name}`],
        kept: [
          `The bucket ${name} in SeaweedFS, and everything in it, since its reclaim policy is Retain. Making a Bucket for it again, with "take over an existing bucket", picks it up.`,
        ],
      };
}
