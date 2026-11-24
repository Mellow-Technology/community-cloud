import { describe, expect, test } from "bun:test";

import { storageTabHref } from "./tabs";
import type { Bucket, S3Identity } from "./types";
import { accessOptions, bucketsFor, identityName, keysFor } from "./users";

const identity = (namespace: string, name: string, extra: Partial<S3Identity> = {}): S3Identity => ({
  metadata: { name, namespace },
  spec: { seaweedRef: { name: "seaweed" } },
  ...extra,
});

const bucket = (namespace: string, name: string, access: Bucket["spec"]["access"]): Bucket => ({
  metadata: { name, namespace },
  spec: { clusterRef: { name: "seaweed" }, access },
});

describe("users", () => {
  test("are named in SeaweedFS as it reports, then as asked, then for the resource", () => {
    expect(identityName(identity("a", "x", { status: { identityName: "reported" } }))).toBe("reported");
    expect(identityName(identity("a", "x", { spec: { seaweedRef: { name: "s" }, name: "asked" } }))).toBe("asked");
    expect(identityName(identity("a", "x"))).toBe("x");
  });

  test("have the keys made for them in their own namespace", () => {
    const keys = [
      { namespace: "a", name: "k1", identity: "x", secret: "x-s3" },
      { namespace: "b", name: "k2", identity: "x", secret: "other" },
      { namespace: "a", name: "k3", identity: "y" },
    ];
    expect(keysFor(identity("a", "x"), keys).map((each) => each.name)).toEqual(["k1"]);
  });

  test("may use any namespace's bucket that names them", () => {
    const found = bucketsFor(identity("a", "x", { status: { identityName: "shop" } }), [
      bucket("a", "one", [{ user: "shop", actions: ["Read"] }]),
      bucket("b", "two", [{ user: "shop", actions: ["Read", "Write"] }]),
      bucket("a", "three", [{ user: "x", actions: ["Admin"] }]),
      bucket("a", "four", undefined),
    ]);
    expect(found.map(({ bucket, actions }) => [bucket.metadata.name, actions])).toEqual([
      ["one", ["Read"]],
      ["two", ["Read", "Write"]],
    ]);
  });
});

test("tabs keep the namespace being shown", () => {
  expect(storageTabHref("buckets")).toBe("/storage");
  expect(storageTabHref("users", "cc-office")).toBe("/storage/users?namespace=cc-office");
});

describe("a bucket's access options", () => {
  const users = [
    { user: "team-shop-api", namespace: "team-shop" },
    { user: "methods", namespace: "cc-office", displayName: "Methods" },
    { user: "anvAdmin", namespace: "seaweedfs", disabled: true },
    { user: "authentik", namespace: "cc-office" },
  ];

  test("start with the bucket's own namespace, and say where each user is", () => {
    const options = accessOptions(users, "cc-office", "", []);
    expect(options.map((each) => each.value)).toEqual(["authentik", "methods", "anvAdmin", "team-shop-api"]);
    expect(options[1]?.description).toBe("cc-office · Methods");
    expect(options[2]?.description).toBe("seaweedfs · disabled");
  });

  test("won't give a user access twice, but keep the row's own", () => {
    const options = accessOptions(users, "cc-office", "methods", ["methods", "authentik"]);
    expect(options.find((each) => each.value === "authentik")?.disabled).toBe(true);
    expect(options.find((each) => each.value === "methods")?.disabled).toBe(false);
  });

  test("keep a user that isn't among those the person can see", () => {
    const options = accessOptions(users, "cc-office", "someone-else", []);
    expect(options[0]).toEqual({
      value: "someone-else",
      label: "someone-else",
      description: "Not among the users you can see",
      disabled: false,
    });
  });
});
