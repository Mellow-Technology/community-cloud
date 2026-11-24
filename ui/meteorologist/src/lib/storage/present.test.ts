import { describe, expect, test } from "bun:test";

import { bucketDeletion, bucketHealth, bucketManager, bucketName, bucketUsage, storageTotals } from "./present";
import type { Bucket } from "./types";

const bucket = (overrides: Partial<Bucket> = {}): Bucket => ({
  metadata: { name: "uploads", namespace: "team-shop" },
  spec: { clusterRef: { name: "seaweed", namespace: "seaweedfs" }, name: "team-shop-uploads" },
  ...overrides,
});

describe("health", () => {
  test("follows the phase, with the Ready condition's message when it isn't", () => {
    expect(bucketHealth(bucket({ status: { phase: "Ready" } })).tone).toBe("success");
    expect(
      bucketHealth(
        bucket({
          status: {
            phase: "Failed",
            conditions: [{ type: "Ready", status: "False", message: "bucket name taken" }],
          },
        }),
      ),
    ).toEqual({ state: "Failed", tone: "danger", label: "Failed", message: "bucket name taken" });
    expect(bucketHealth(bucket()).state).toBe("Unknown");
    expect(
      bucketHealth(bucket({ metadata: { name: "x", deletionTimestamp: "now" }, status: { phase: "Ready" } })).label,
    ).toBe("Deleting");
  });
});

describe("names", () => {
  test("SeaweedFS's, then the spec's, then the resource's", () => {
    expect(bucketName(bucket({ status: { bucketName: "reported" } }))).toBe("reported");
    expect(bucketName(bucket())).toBe("team-shop-uploads");
    expect(bucketName(bucket({ spec: { clusterRef: { name: "seaweed" } } }))).toBe("uploads");
  });
});

describe("usage", () => {
  test("against the quota SeaweedFS reports, or the one asked for", () => {
    const used = bucketUsage(
      bucket({
        status: { usage: { sizeBytes: 5 * 1024 ** 3, objectCount: 12 }, quota: { sizeBytes: 20 * 1024 ** 3 } },
      }),
    );
    expect(used).toEqual({
      usedBytes: 5 * 1024 ** 3,
      quotaBytes: 20 * 1024 ** 3,
      objects: 12,
      fraction: 0.25,
      text: "5Gi of 20Gi",
    });
    expect(bucketUsage(bucket({ spec: { clusterRef: { name: "s" }, quota: { size: "1Gi" } } })).text).toBe(
      "Nothing counted yet, of 1Gi",
    );
    expect(bucketUsage(bucket()).text).toBe("Nothing counted yet");
  });

  test("adds up", () => {
    expect(
      storageTotals([
        bucket({ status: { phase: "Ready", usage: { sizeBytes: 10, objectCount: 2 }, quota: { sizeBytes: 100 } } }),
        bucket({ status: { phase: "Pending", usage: { sizeBytes: 5 } } }),
      ]),
    ).toEqual({ buckets: 2, ready: 1, usedBytes: 15, quotaBytes: 100, objects: 2 });
  });
});

describe("what looks after it", () => {
  test("the application Cirrus made it for, the installer, or nothing", () => {
    expect(
      bucketManager(
        bucket({
          metadata: { name: "x", namespace: "team-shop", ownerReferences: [{ kind: "WebApplication", name: "shop" }] },
        }),
      ),
    ).toEqual({ kind: "application", name: "shop", href: "/apps/team-shop/shop" });
    expect(
      bucketManager(bucket({ metadata: { name: "x", labels: { "app.kubernetes.io/managed-by": "community-cloud" } } })),
    ).toEqual({ kind: "installer" });
    expect(bucketManager(bucket())).toBeUndefined();
  });
});

describe("deleting", () => {
  test("keeps the contents unless the reclaim policy says otherwise", () => {
    expect(bucketDeletion(bucket()).kept).toHaveLength(1);
    const deletes = bucketDeletion(bucket({ spec: { clusterRef: { name: "s" }, reclaimPolicy: "Delete" } }));
    expect(deletes.kept).toEqual([]);
    expect(deletes.removed[1]).toContain("everything in it");
  });
});
