import { describe, expect, test } from "bun:test";

import { defaultBucketName, emptyBucketForm, fromBucketForm, toBucketForm, validateBucketForm } from "./form";
import type { Bucket } from "./types";

const methods: Bucket = {
  apiVersion: "seaweed.seaweedfs.com/v1",
  kind: "Bucket",
  metadata: { name: "methods", namespace: "cc-office", resourceVersion: "9", labels: { a: "b" } },
  spec: {
    clusterRef: { name: "seaweed", namespace: "seaweedfs" },
    access: [{ user: "methods", actions: ["Read", "Write", "List", "Tagging"] }],
    quota: { size: "20Gi", enforce: true },
    reclaimPolicy: "Retain",
    versioning: "Off",
    objectLock: false,
    anonymousRead: false,
    // Something the form doesn't show, which has to survive an edit
    owner: "methods",
  },
  status: { bucketName: "methods", phase: "Ready", versioning: "Off" },
};

describe("a new bucket", () => {
  const form = { ...emptyBucketForm("team-shop"), name: "uploads", quota: "5Gi" };

  test("is named in SeaweedFS for its namespace, unless told otherwise", () => {
    expect(defaultBucketName("team-shop", "uploads")).toBe("team-shop-uploads");
    expect(fromBucketForm(form).spec.name).toBe("team-shop-uploads");
    expect(fromBucketForm({ ...form, bucketName: " shop-files " }).spec.name).toBe("shop-files");
  });

  test("is in the cluster's SeaweedFS, with only what was asked for", () => {
    expect(fromBucketForm(form)).toEqual({
      apiVersion: "seaweed.seaweedfs.com/v1",
      kind: "Bucket",
      metadata: { name: "uploads", namespace: "team-shop" },
      spec: {
        clusterRef: { name: "seaweed", namespace: "seaweedfs" },
        name: "team-shop-uploads",
        objectLock: false,
        adoptExisting: false,
        quota: { size: "5Gi", enforce: true },
        versioning: "Off",
        anonymousRead: false,
        reclaimPolicy: "Retain",
      },
    });
  });

  test("keeps access in SeaweedFS's order and drops blank users", () => {
    const spec = fromBucketForm({
      ...form,
      access: [
        { user: " shop ", actions: ["List", "Read"] },
        { user: "", actions: ["Read"] },
      ],
      replication: "001",
      ttl: "30d",
    }).spec;
    expect(spec.access).toEqual([{ user: "shop", actions: ["Read", "List"] }]);
    expect(spec.placement).toEqual({ replication: "001", ttl: "30d" });
  });

  test("is checked", () => {
    expect(validateBucketForm(form)).toEqual({});
    expect(Object.keys(validateBucketForm(emptyBucketForm()))).toEqual(["namespace", "name"]);
    expect(validateBucketForm({ ...form, name: "Uploads" }).name).toBeDefined();
    expect(validateBucketForm({ ...form, bucketName: "a" }).bucketName).toBeDefined();
    expect(validateBucketForm({ ...form, bucketName: "has.dots" }).bucketName).toBeDefined();
    expect(validateBucketForm({ ...form, quota: "lots" }).quota).toBeDefined();
    expect(validateBucketForm({ ...form, quota: "0" }).quota).toBeDefined();
    expect(validateBucketForm({ ...form, objectLock: true }).objectLock).toBeDefined();
    expect(validateBucketForm({ ...form, objectLock: true, versioning: "Enabled" })).toEqual({});
    expect(validateBucketForm({ ...form, access: [{ user: "shop", actions: [] }] })["access.0"]).toBeDefined();
    expect(validateBucketForm({ ...form, replication: "1" }).replication).toBeDefined();
    expect(validateBucketForm({ ...form, ttl: "30 days" }).ttl).toBeDefined();
  });
});

describe("an existing bucket", () => {
  test("comes back as it was", () => {
    const form = toBucketForm(methods);
    expect(form).toMatchObject({ namespace: "cc-office", name: "methods", bucketName: "methods", quota: "20Gi" });
    const back = fromBucketForm(form, methods);
    expect(back.spec).toEqual(methods.spec);
    expect(back.metadata).toEqual(methods.metadata);
  });

  test("keeps its name, object lock and adoption, whatever the form says", () => {
    const form = { ...toBucketForm(methods), bucketName: "else", objectLock: true, adoptExisting: true };
    const spec = fromBucketForm(form, methods).spec;
    expect(spec.name).toBeUndefined();
    expect(spec.objectLock).toBe(false);
    expect(spec.adoptExisting).toBeUndefined();
  });

  test("can lose its quota", () => {
    expect(fromBucketForm({ ...toBucketForm(methods), quota: "" }, methods).spec.quota).toBeUndefined();
  });

  test("can't turn versioning off once it's been on", () => {
    const versioned: Bucket = { ...methods, status: { ...methods.status, versioning: "Suspended" } };
    expect(validateBucketForm({ ...toBucketForm(versioned), versioning: "Off" }, versioned).versioning).toBeDefined();
    expect(validateBucketForm({ ...toBucketForm(versioned), versioning: "Enabled" }, versioned)).toEqual({});
  });

  test("with object lock keeps versioning on", () => {
    const locked: Bucket = { ...methods, spec: { ...methods.spec, objectLock: true, versioning: "Enabled" } };
    expect(validateBucketForm({ ...toBucketForm(locked), versioning: "Suspended" }, locked).versioning).toBeDefined();
  });
});
