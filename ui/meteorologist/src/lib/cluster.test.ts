import { describe, expect, test } from "bun:test";

import { bytesIn, clusterMessage, nodeInterface, summarizeCluster, type NodeUsage } from "./cluster";

const GiB = 2 ** 30;

/**
 * A node with 8 cores and 32GiB, using some of each.
 *
 * @param name
 * @param cores in use
 * @param memory GiB in use
 * @returns
 */
function node(name: string, cores: number, memory: number): NodeUsage {
  return {
    name,
    cpuCores: 8,
    memoryBytes: 32 * GiB,
    summary: {
      cpu: { usageNanoCores: cores * 1e9 },
      memory: { rssBytes: memory * GiB },
      network: {
        name: "eth0",
        interfaces: [
          { name: "eth0", rxBytes: 900, txBytes: 900 },
          { name: "defined1", rxBytes: 100, txBytes: 50 },
        ],
      },
    },
  };
}

const running = (count: number) => Array.from({ length: count }, () => "Running");

describe("the cluster's figures", () => {
  test("add up across nodes, counting each node's overlay traffic once", () => {
    const summary = summarizeCluster({ nodes: [node("a", 2, 8), node("b", 1, 4)], podPhases: running(10) });
    expect(summary.cpu).toEqual({ usedCores: 3, totalCores: 16 });
    expect(summary.memory).toEqual({ usedBytes: 12 * GiB, totalBytes: 64 * GiB });
    expect(summary.network).toEqual({ rxBytes: 200, txBytes: 100 });
    expect(summary.pods).toEqual({ healthy: 10, total: 10 });
    expect(summary.health).toBe("green");
    expect(summary.reasons).toEqual([]);
  });

  test("keep a node whose kubelet didn't answer in the capacity, and name it", () => {
    const silent: NodeUsage = { name: "c", cpuCores: 8, memoryBytes: 32 * GiB };
    const summary = summarizeCluster({ nodes: [node("a", 2, 8), silent], podPhases: [] });
    expect(summary.cpu.totalCores).toBe(16);
    expect(summary.unreported).toEqual(["c"]);
  });

  test("are under strain past 80%, and in trouble past 95%", () => {
    expect(summarizeCluster({ nodes: [node("a", 7, 8)], podPhases: running(1) }).reasons).toEqual(["CPU is at 88%"]);
    const red = summarizeCluster({ nodes: [node("a", 2, 31)], podPhases: running(1) });
    expect(red.health).toBe("red");
    expect(red.label).toBe("In trouble");
  });

  test("count failing pods, and are in trouble when most are", () => {
    const some = summarizeCluster({ nodes: [node("a", 1, 1)], podPhases: [...running(3), "Failed"] });
    expect(some.health).toBe("yellow");
    expect(some.reasons).toEqual(["1 of 4 pods is failing"]);
    const most = summarizeCluster({ nodes: [node("a", 1, 1)], podPhases: ["Running", "Failed", "Unknown"] });
    expect(most.health).toBe("red");
  });
});

test("a node's traffic is its overlay's, or else its default interface's", () => {
  expect(nodeInterface({ interfaces: [{ name: "eth0" }, { name: "cilium_vxlan" }] })?.name).toBe("cilium_vxlan");
  expect(nodeInterface({ name: "bond0", interfaces: [{ name: "eth0" }, { name: "bond0" }] })?.name).toBe("bond0");
  expect(nodeInterface({ interfaces: [{ name: "lo" }, { name: "enp3s0" }] })?.name).toBe("enp3s0");
  expect(nodeInterface(undefined)).toBeUndefined();
});

test("bytes share their total's unit", () => {
  expect(bytesIn(12 * GiB, 64 * GiB)).toEqual({ value: 12, unit: "GiB" });
  expect(bytesIn(512 * 2 ** 20, 64 * GiB)).toEqual({ value: 0.5, unit: "GiB" });
  expect(bytesIn(3 * 2 ** 40)).toEqual({ value: 3, unit: "TiB" });
});

test("the status line has something to say for every state", () => {
  expect(clusterMessage("green", 0)).toBe("Huzzah!");
  expect(clusterMessage("red", 0.99)).toBe("Rekt 😭");
  expect(clusterMessage("yellow", 0.5)).toBe("YOLO");
});
