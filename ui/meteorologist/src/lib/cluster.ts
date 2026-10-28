/**
 * @file
 * How the cluster as a whole is doing: CPU, memory, pods and network,
 * as the Community Cloud homepage shows them
 * (community-cloud-hq, src/util/K8sResources.ts).
 *
 * The figures come from each node's kubelet summary, read through the
 * API server, and the cluster's pods. Both need cluster-wide reads,
 * which only admins have, so for anyone else the overview leaves the
 * panel out rather than show it broken.
 *
 * This file is the arithmetic, kept apart from fetching so it can be
 * tested; the homepage's choices are kept so the two agree.
 */
import type { HealthTone } from "./webapp/health";

/**
 * A node's share: what it has, and what its kubelet said it's using.
 *
 * - cpuCores and memoryBytes: the node's capacity
 * - summary: the "node" part of the kubelet's stats/summary, or
 *   nothing when the kubelet couldn't be asked
 */
export interface NodeUsage {
  name: string;
  cpuCores: number;
  memoryBytes: number;
  summary?: KubeletNodeSummary;
}

/**
 * The parts of a kubelet's stats/summary node entry used here.
 */
export interface KubeletNodeSummary {
  cpu?: { usageNanoCores?: number };
  memory?: { rssBytes?: number };
  network?: { name?: string; interfaces?: { name: string; rxBytes?: number; txBytes?: number }[] };
}

export interface ClusterUsage {
  nodes: NodeUsage[];
  podPhases: string[];
}

export type ClusterHealth = "green" | "yellow" | "red";

export interface ClusterSummary {
  health: ClusterHealth;
  tone: HealthTone;
  label: string;
  // What made it less than green
  reasons: string[];
  cpu: { usedCores: number; totalCores: number };
  memory: { usedBytes: number; totalBytes: number };
  pods: { healthy: number; total: number };
  network: { rxBytes: number; txBytes: number };
  // Nodes whose kubelet couldn't be asked, so aren't in the usage
  unreported: string[];
}

/**
 * Overlay interfaces, in the order they're preferred: the network
 * joining nodes across regions, then the CNI's. Adding up every
 * interface would count the same bytes several times, since the NIC,
 * the overlay and each pod's veth all see them.
 */
const OVERLAY_INTERFACES = [
  /^defined\d+$/, // Defined Networking
  /^flannel\.\d+$/,
  /^cilium_(vxlan|geneve)$/,
  /^vxlan\.calico$/,
  /^tunl0$/,
  /^wg\d+$/,
];

const PHYSICAL_INTERFACE = /^(en|eth|wl)/;

// Past these, the cluster is under strain, then in trouble
const STRAINED = 0.8;
const OVERLOADED = 0.95;

// A pod in any of these is where it should be
const HEALTHY_PHASES = new Set(["Running", "Pending", "Succeeded"]);

const PRESENTATION: Record<ClusterHealth, { tone: HealthTone; label: string }> = {
  green: { tone: "success", label: "Healthy" },
  yellow: { tone: "warning", label: "Under strain" },
  red: { tone: "danger", label: "In trouble" },
};

/**
 * The one interface whose traffic stands for a node's. On a CNI not
 * listed, the kubelet's default interface, then the first physical
 * one, so the node still counts.
 *
 * @param network
 * @returns
 */
export function nodeInterface(network: KubeletNodeSummary["network"]) {
  const interfaces = network?.interfaces ?? [];
  for (const pattern of OVERLAY_INTERFACES) {
    const overlay = interfaces.find((each) => pattern.test(each.name));
    if (overlay) {
      return overlay;
    }
  }
  return (
    interfaces.find((each) => each.name === network?.name) ??
    interfaces.find((each) => PHYSICAL_INTERFACE.test(each.name))
  );
}

/**
 * A percentage for a sentence.
 *
 * @param fraction
 * @returns
 */
function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * The cluster's figures, and how it's doing.
 *
 * @param usage
 * @returns
 */
export function summarizeCluster(usage: ClusterUsage): ClusterSummary {
  const reported = usage.nodes.filter((node) => node.summary !== undefined);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

  const cpu = {
    usedCores: sum(reported.map((node) => (node.summary?.cpu?.usageNanoCores ?? 0) / 1e9)),
    totalCores: sum(usage.nodes.map((node) => node.cpuCores)),
  };
  const memory = {
    usedBytes: sum(reported.map((node) => node.summary?.memory?.rssBytes ?? 0)),
    totalBytes: sum(usage.nodes.map((node) => node.memoryBytes)),
  };
  const interfaces = reported.map((node) => nodeInterface(node.summary?.network));
  const network = {
    rxBytes: sum(interfaces.map((each) => each?.rxBytes ?? 0)),
    txBytes: sum(interfaces.map((each) => each?.txBytes ?? 0)),
  };
  const pods = {
    healthy: usage.podPhases.filter((phase) => HEALTHY_PHASES.has(phase)).length,
    total: usage.podPhases.length,
  };

  const cpuFraction = cpu.totalCores > 0 ? cpu.usedCores / cpu.totalCores : 0;
  const memoryFraction = memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : 0;
  const unhealthy = pods.total - pods.healthy;

  const red: string[] = [];
  const yellow: string[] = [];
  for (const [name, fraction] of [
    ["CPU", cpuFraction],
    ["Memory", memoryFraction],
  ] as const) {
    if (fraction >= OVERLOADED) {
      red.push(`${name} is at ${percent(fraction)}`);
    } else if (fraction >= STRAINED) {
      yellow.push(`${name} is at ${percent(fraction)}`);
    }
  }
  if (pods.healthy < pods.total / 2) {
    red.push(`${unhealthy} of ${pods.total} pods are failing`);
  } else if (unhealthy > 0) {
    yellow.push(`${unhealthy} of ${pods.total} pods ${unhealthy === 1 ? "is" : "are"} failing`);
  }

  const health: ClusterHealth = red.length > 0 ? "red" : yellow.length > 0 ? "yellow" : "green";
  return {
    health,
    ...PRESENTATION[health],
    reasons: [...red, ...yellow],
    cpu,
    memory,
    pods,
    network,
    unreported: usage.nodes.filter((node) => node.summary === undefined).map((node) => node.name),
  };
}

/**
 * Bytes as a figure and a unit, in the unit a reference amount reads
 * best in, so a used amount and its total share one.
 *
 * @param bytes
 * @param reference what picks the unit; the bytes themselves by default
 * @returns
 */
export function bytesIn(bytes: number, reference: number = bytes): { value: number; unit: string } {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let unit = 0;
  while (Math.abs(reference) >= 1024 ** (unit + 1) && unit < units.length - 1) {
    unit += 1;
  }
  return { value: Number((bytes / 1024 ** unit).toFixed(1)), unit: units[unit]! };
}
