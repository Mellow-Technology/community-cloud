/**
 * @file
 * The bundles that can be run, and what each of them is for.
 *
 * This is the one list: the runner takes what it executes from here,
 * and so does the listing, so a bundle can't be runnable without
 * showing up when someone asks what there is to run.
 */
import { CommandSpec } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";

// Command Bundles
import { K3sCommands } from "./K3s.ts";
import { BasePackageCommands } from "./BasePackages.ts";
import { NodeLabelCommands } from "./NodeLabels.ts";
import { LvmCommands } from "./LVM.ts";
import { NetworkingCommands } from "./Networking.ts";
import { CiliumCommands } from "./Cilium.ts";
import { GpuInfoCommands } from "./GpuInfo.ts";
import { RegistryCommands } from "./Registries.ts";
import { NebulaCommands } from "./Nebula.ts";
import { NebulaNetworkCommands } from "./NebulaNetwork.ts";

/**
 * A bundle that can be run.
 *
 * Most bundles are a fixed list of commands. A few are a function of
 * the configuration instead, because only the configuration knows how
 * many commands there should be — the roles on a Nebula network are
 * one command each.
 */
export interface BundleDefinition {
  name: string;
  description: string;
  commands: CommandSpec[] | Function;
}

export const bundles: BundleDefinition[] = [
  {
    name: "base",
    description: "Install the base packages every node needs",
    commands: BasePackageCommands,
  },
  {
    name: "cilium",
    description: "Install Cilium as the cluster CNI, from the control plane",
    commands: CiliumCommands,
  },
  {
    name: "gpu",
    description: "Detect video hardware and whether its vendor tooling is installed",
    commands: GpuInfoCommands,
  },
  {
    name: "k3s",
    description: "Install K3s, as a server or an agent depending on the node",
    commands: K3sCommands,
  },
  {
    name: "lvm",
    description: "Set up LVM volumes for node local storage",
    commands: LvmCommands,
  },
  {
    name: "nebula",
    description: "Join a node to the cluster's Nebula network",
    commands: NebulaCommands,
  },
  {
    name: "nebula-network",
    description: "Set up the Nebula network and the roles on it",
    commands: NebulaNetworkCommands,
  },
  {
    name: "registries",
    description: "Give K3s the credentials for the configured private registries",
    commands: RegistryCommands,
  },
  {
    name: "network",
    description: "Set kernel networking properties, including BBR congestion control",
    commands: NetworkingCommands,
  },
  {
    name: "nodeLabels",
    description: "Label a node with its configured Kubernetes roles",
    commands: NodeLabelCommands,
  },
];

/**
 * Find a bundle by name.
 *
 * @param bundleName
 * @returns
 */
export function getBundle(bundleName: string): BundleDefinition | undefined {
  return bundles.find((bundle) => bundle.name === bundleName);
}

/**
 * The names of every bundle, for telling someone what they could have
 * asked for.
 *
 * @returns
 */
export function getBundleNames(): string[] {
  return bundles.map((bundle) => bundle.name);
}

/**
 * Whether a bundle's commands come from the configuration, which is
 * to say whether it can be listed without one.
 *
 * @param bundle
 * @returns
 */
export function isBuiltFromConfig(bundle: BundleDefinition): boolean {
  return typeof bundle.commands === "function";
}

/**
 * The commands in a bundle.
 *
 * @param bundle
 * @param config
 * @param context
 * @returns
 */
export function getBundleCommands(
  bundle: BundleDefinition,
  config: CloudConfig,
  context: object = {},
): CommandSpec[] {
  return typeof bundle.commands === "function"
    ? bundle.commands(config, context)
    : bundle.commands;
}
