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
import { ClusterOnlineCommands, NodeJoinedCommands } from "./AddNode.ts";
import { BasePackageCommands } from "./BasePackages.ts";
import { NodeLabelCommands } from "./NodeLabels.ts";
import { LvmCommands } from "./LVM.ts";
import { NetworkingCommands } from "./Networking.ts";
import { CiliumCommands } from "./Cilium.ts";
import { GpuInfoCommands } from "./GpuInfo.ts";
import { GatewayCommands } from "./GatewayNodes.ts";
import { PreflightCommands } from "./Preflight.ts";
import { ClusterConfigCommands } from "./ClusterConfig.ts";
import { HelmInstallCommands } from "./Helm.install.ts";
import { HelmCommands } from "./Helm.ts";
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

  // Which plugin contributed this, when one did. Built-in bundles
  // leave it unset, and the listing says where a bundle came from so
  // that what a node will run can be traced to who asked for it.
  plugin?: string;
}

/**
 * The bundles this installer was built with.
 *
 * Kept separate from the registry below so that a plugin can add to
 * the list without being able to take anything out of it.
 */
const builtInBundles: BundleDefinition[] = [
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
    name: "cluster",
    description: "Record this cluster's configuration in the cluster itself",
    commands: ClusterConfigCommands,
  },
  {
    name: "cluster-online",
    description: "Check the cluster is up and answering, before joining a node to it",
    commands: ClusterOnlineCommands,
  },
  {
    name: "gateway",
    description: "Give the cluster a way in from outside, from the control plane",
    commands: GatewayCommands,
  },
  {
    name: "gpu",
    description: "Detect video hardware and whether its vendor tooling is installed",
    commands: GpuInfoCommands,
  },
  {
    name: "helm",
    description: "Install Helm on the control plane",
    commands: HelmInstallCommands,
  },
  {
    name: "helm-charts",
    description: "Install the configured Helm charts, dependencies first",
    commands: HelmCommands,
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
    name: "preflight",
    description: "Check a node could be installed on, changing nothing",
    commands: PreflightCommands,
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
    name: "node-joined",
    description: "Check a node has joined the cluster and gone Ready",
    commands: NodeJoinedCommands,
  },
  {
    name: "nodeLabels",
    description: "Label a node with its roles, its own labels, and what was detected on it",
    commands: NodeLabelCommands,
  },
];

/**
 * Everything that can be run: what shipped, plus what plugins added.
 *
 * A live array rather than a snapshot, because the listing and the
 * runners both read it and plugins are loaded after the module is.
 */
export const bundles: BundleDefinition[] = [...builtInBundles];

/**
 * Add a bundle from a plugin.
 *
 * A plugin can't replace a built-in, and two plugins can't both claim
 * a name — the names are already prefixed with the plugin's own, so a
 * collision here means one plugin has two bundles called the same
 * thing.
 *
 * @param definition
 * @param plugin the plugin adding it
 */
export function registerBundle(definition: BundleDefinition, plugin: string) {
  const existing = getBundle(definition.name);

  if (existing !== undefined) {
    throw new Error(
      existing.plugin === undefined
        ? `The plugin "${plugin}" tried to add a bundle called "${definition.name}", which is one this installer ships. A plugin can add bundles and can't replace them.`
        : `The plugin "${plugin}" has two bundles called "${definition.name}".`,
    );
  }

  bundles.push({ ...definition, plugin });
}

/**
 * Forget every bundle a plugin added. For tests, and for a process
 * that loads more than one configuration.
 */
export function resetBundles() {
  bundles.length = 0;
  bundles.push(...builtInBundles);
}

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
