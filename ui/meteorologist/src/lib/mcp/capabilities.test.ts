import { describe, expect, test } from "bun:test";

import { KubeError } from "../kube/client";
import { readCapabilities, unavailable, type Capabilities } from "./capabilities";

const baseReport: Capabilities = {
  version: 1,
  namespace: "team-shop",
  services: {
    postgres: { available: true },
    rabbitmq: { available: false, reason: "RabbitMQ's topology operator isn't installed in this cluster." },
    bucket: { available: true },
  },
  storage: [{ type: "fast", storageClass: "cc-local-ssd-fast", available: true }],
  ingress: { available: false },
  egress: { restricted: false },
  offerings: [],
};
const report = baseReport;
const nothing = { services: new Set<string>(), connections: new Set<string>() };

describe("reading the report", () => {
  test("is nothing when Cirrus's roles don't let it be read", async () => {
    const kube = {
      getConfigMap: async () => {
        throw new KubeError(403, "forbidden", "Forbidden");
      },
      listServiceOfferings: async () => [],
    };
    expect(await readCapabilities(kube, "team-shop")).toBeUndefined();
  });

  test("is nothing when it isn't JSON", async () => {
    const kube = {
      getConfigMap: async () => ({ metadata: { name: "x" }, data: { "capabilities.json": "{" } }),
      listServiceOfferings: async () => [],
    };
    expect(await readCapabilities(kube, "team-shop")).toBeUndefined();
  });

  test("still fails when the API server can't be reached", async () => {
    const kube = {
      getConfigMap: async () => {
        throw new KubeError(0, "connection refused");
      },
      listServiceOfferings: async () => [],
    };
    await expect(readCapabilities(kube, "team-shop")).rejects.toThrow("connection refused");
  });
});

describe("the offerings in the report", () => {
  const report = {
    ...structuredClone(baseReport),
    offerings: [
      { name: "old", namespace: "team-shop", title: "Gone since", protocol: "http", ready: true },
      { name: "plane", namespace: "cc-office", title: "Plane API", protocol: "http", ready: true },
    ],
  };
  const kube = (own: string[] | Error) => ({
    getConfigMap: async () => ({ metadata: { name: "x" }, data: { "capabilities.json": JSON.stringify(report) } }),
    listServiceOfferings: async () => {
      if (own instanceof Error) throw own;
      return own.map((name) => ({
        metadata: { name, namespace: "team-shop" },
        spec: { title: name, service: { name } },
        status: {
          conditions: [{ type: "Ready", status: "True" as const, reason: "", message: "", lastTransitionTime: "" }],
        },
      }));
    },
  });

  test("are the namespace's own as they are now, and others' as reported", async () => {
    // One just offered, which the report is too old to have
    const read = await readCapabilities(kube(["sonic-ml"]), "team-shop");
    expect(read?.offerings.map((each) => `${each.namespace}/${each.name}`)).toEqual([
      "cc-office/plane",
      "team-shop/sonic-ml",
    ]);
    expect(unavailable({ connections: [{ offering: "sonic-ml" }] }, read, nothing)).toEqual([]);
  });

  test("are the report's when the namespace's can't be listed", async () => {
    const read = await readCapabilities(kube(new KubeError(403, "forbidden", "Forbidden")), "team-shop");
    expect(read?.offerings.map((each) => each.name)).toEqual(["old", "plane"]);
  });
});

describe("what can't be had", () => {
  test("is a service that isn't available, with why", () => {
    expect(unavailable({ rabbitmq: true }, report, nothing)).toEqual([
      "rabbitmq isn't available here: RabbitMQ's topology operator isn't installed in this cluster.",
    ]);
  });

  test("isn't something the application already has", () => {
    expect(unavailable({ rabbitmq: true }, report, { ...nothing, services: new Set(["rabbitmq"]) })).toEqual([]);
  });

  test("is a storage type with no StorageClass, saying which there are", () => {
    expect(
      unavailable({ volumes: [{ name: "d", mountPath: "/d", size: "1Gi", type: "hdd" }] }, report, nothing),
    ).toEqual([]);
    const noSata = { ...report, storage: [...report.storage, { type: "sata", available: false }] };
    expect(
      unavailable({ volumes: [{ name: "d", mountPath: "/d", size: "1Gi", type: "sata" }] }, noSata, nothing)[0],
    ).toContain("Use fast");
  });

  test("is nothing at all without a report", () => {
    expect(unavailable({ rabbitmq: true }, undefined, nothing)).toEqual([]);
  });
});
