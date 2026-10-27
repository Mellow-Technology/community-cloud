import { describe, expect, test } from "bun:test";

import {
  CAPABILITIES,
  capabilityLabelPatch,
  capabilityPatch,
  enabledCapabilities,
  getCapability,
  hasCapability,
} from "./capabilities";

describe("the capability registry", () => {
  test("names each capability once", () => {
    const ids = CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("matches the labels the manifests select on", () => {
    // k8s/networking/cilium/gateway/Gateway.yaml
    expect(getCapability("gateway")).toMatchObject({ label: "whereWereGoing", value: "weDontNeedRoads" });
    // k8s/storage/SeaweedFS/SeaweedFS.yaml
    expect(getCapability("buckets")).toMatchObject({
      label: "storage.community-cloud.technology/buckets",
      value: "true",
    });
  });

  test("explains every capability", () => {
    for (const capability of CAPABILITIES) {
      expect(capability.title).not.toBe("");
      expect(capability.explanation.length).toBeGreaterThan(40);
    }
  });
});

describe("hasCapability", () => {
  const gateway = getCapability("gateway");

  test("is on only for the exact value", () => {
    expect(hasCapability({ whereWereGoing: "weDontNeedRoads" }, gateway)).toBe(true);
    expect(hasCapability({ whereWereGoing: "true" }, gateway)).toBe(false);
    expect(hasCapability({}, gateway)).toBe(false);
    expect(hasCapability(undefined, gateway)).toBe(false);
  });

  test("lists what a namespace has", () => {
    const labels = { whereWereGoing: "weDontNeedRoads", "storage.community-cloud.technology/buckets": "true" };
    expect(enabledCapabilities(labels).map((capability) => capability.id)).toEqual(["gateway", "buckets"]);
    expect(enabledCapabilities({})).toEqual([]);
  });
});

describe("capability patches", () => {
  const buckets = getCapability("buckets");

  test("set the label to turn on", () => {
    expect(capabilityLabelPatch(buckets, true)).toEqual({ "storage.community-cloud.technology/buckets": "true" });
  });

  test("remove the label to turn off", () => {
    expect(capabilityPatch(buckets, false)).toEqual({
      metadata: { labels: { "storage.community-cloud.technology/buckets": null } },
    });
  });
});
