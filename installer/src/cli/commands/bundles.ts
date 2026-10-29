/**
 * @file
 * The bundles that can be run, and what each of them is for.
 *
 * This is the one list: the runner takes what it executes from here,
 * and so does the listing, so a bundle can't be runnable without
 * showing up when someone asks what there is to run.
 */
import { CommandPurpose, CommandSpec } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";

// Command Bundles
import { ClusterSignInCommands, K3sCommands } from "./K3s.ts";
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
import { HelmCommands, buildPackagesBundle, buildSinglePackageBundle } from "./Helm.ts";
import { RegistryCommands } from "./Registries.ts";
import { NebulaCommands } from "./Nebula.ts";
import { NebulaNetworkCommands } from "./NebulaNetwork.ts";
import { DrainCommands } from "./Drain.ts";
import { K3sUninstallCommands, NodeRemovedCommands } from "./Uninstall.ts";
import { CleanCommands, StorageRemoveCommands } from "./Clean.ts";
import { DnsCommands } from "./Dns.ts";
import { PlacementCommands } from "./Placement.ts";

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

  // Whether this bundle takes something apart rather than building it.
  //
  // It matters because of the doctor, which runs every bundle's
  // read-only commands to say how a cluster is. These bundles' checks
  // assert the opposite of a working cluster — "K3s isn't running",
  // "this node isn't a member", "no volume group is ours" — so running
  // them during a check-up would report a healthy cluster as broken.
  // They are left out of a check-up that asks about everything, and
  // run as normal when one is asked for by name.
  teardown?: boolean;

  // Another bundle whose checks already cover this one's.
  //
  // For the bundles that install a single package on its own. Their
  // checks are the package's checks, which "helm-charts" asks too for
  // every package the configuration enables — so in a check-up of
  // everything they would either say the same thing twice, or, for a
  // package the cluster doesn't have, report it as broken: Lago's
  // checks fail on a cluster with no Lago, which is the right answer
  // to a question nobody asked. Left out of a
  // check-up of everything, and run as normal when asked for by name.
  checkedBy?: string;

  // Whether running this can destroy something that's already there.
  //
  // For the doctor, which suggests re-running a bundle to put right
  // what its checks found. A bundle that formats disks shouldn't be
  // offered as something to type without looking, so it's suggested
  // with --dry-run, to see what it would do first.
  destructive?: boolean;
}

/**
 * Commands that find something out, run only when nothing earlier in
 * the run already has.
 *
 * For the nodeLabels bundle, whose labels for GPUs and storage come
 * from what the gpu and lvm bundles found. In an install those have
 * just run and their findings are in the context. Run on its own, it
 * would know of no GPU and no disk and leave those labels off, so it
 * looks for itself — with the read-only commands only, since labelling
 * a node shouldn't be able to format its disks.
 *
 * @param commands
 * @param key the context entry they fill in
 * @returns
 */
function unlessKnown(commands: CommandSpec[], key: string): CommandSpec[] {
  // Set by the first of them, so the rest can tell what they found
  // from what an earlier bundle did: they run after it has filled the
  // key in, and would otherwise take that as their cue to skip
  const looking = `${key}:lookedForByNodeLabels`;
  const inspecting = commands.filter((command) => command.purpose === CommandPurpose.Inspect);

  return inspecting.map((command, index) => {
    const save = command.saveToContext;

    if (index === 0 && typeof save !== "function") {
      throw new Error(`"${command.name}" has to save its findings with a function to be run by nodeLabels.`);
    }

    return {
      ...command,
      skipWhen: (config: CloudConfig, context: any) =>
        (context[key] !== undefined && context[looking] !== true) ||
        (command.skipWhen !== undefined && command.skipWhen(config, context)),
      ...(index === 0
        ? {
            saveToContext: (output: any, context: any, config: CloudConfig) => ({
              ...(save as Function)(output, context, config),
              [looking]: true,
            }),
          }
        : {}),
    };
  });
}

/**
 * The bundles this installer was built with.
 *
 * Kept separate from the registry below so that a plugin can add to
 * the list without being able to take anything out of it.
 */
const builtInBundles: BundleDefinition[] = [
  {
    name: "authentik",
    description: "Install Authentik into cc-office, for single sign on",
    commands: buildSinglePackageBundle("authentik"),
    checkedBy: "helm-charts",
  },
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
    name: "cirrus",
    description: "Install Cirrus into community-cloud, to run WebApplications",
    commands: buildSinglePackageBundle("cirrus"),
    checkedBy: "helm-charts",
  },
  {
    name: "clean",
    description: "Remove the configuration and data directories an uninstall kept",
    commands: CleanCommands,
    teardown: true,
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
    name: "cluster-sign-in",
    description: "Rewrite the API server's sign in settings on each server, without reinstalling K3s",
    commands: ClusterSignInCommands,
    checkedBy: "k3s",
  },
  {
    name: "dns",
    description: "Install ExternalDNS for each configured DNS provider and namespace",
    commands: DnsCommands,
  },
  {
    name: "documenso",
    description: "Install Documenso into cc-office, signing in through Authentik",
    commands: buildSinglePackageBundle("documenso"),
    checkedBy: "helm-charts",
  },
  {
    name: "drain",
    description: "Move the workloads off a node, before taking it out of service",
    commands: DrainCommands,
    teardown: true,
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
    name: "k3s-uninstall",
    description: "Take K3s off a node, keeping its configuration and data",
    commands: K3sUninstallCommands,
    teardown: true,
  },
  {
    name: "lago",
    description: "Install Lago billing into cc-office",
    commands: buildSinglePackageBundle("lago"),
    checkedBy: "helm-charts",
  },
  {
    name: "lvm",
    description: "Set up LVM volumes for node local storage",
    commands: LvmCommands,

    // It makes physical volumes of whatever disks it finds free
    destructive: true,
  },
  {
    name: "mariadb",
    description: "Install the MariaDB operator into community-cloud, and the MariaDB cc-office shares",
    commands: buildPackagesBundle(["mariadb-operator-crds", "mariadb-operator"]),
    checkedBy: "helm-charts",
  },
  {
    name: "mattermost",
    description: "Install Mattermost chat into cc-office",
    commands: buildSinglePackageBundle("mattermost"),
    checkedBy: "helm-charts",
  },
  {
    name: "meteorologist",
    description: "Install Meteorologist into community-cloud, Community Cloud's web interface",
    commands: buildSinglePackageBundle("meteorologist"),
    checkedBy: "helm-charts",
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
    name: "picoclaw",
    description: "Install the Picoclaw agent into cc-office, behind Authentik",
    commands: buildSinglePackageBundle("picoclaw"),
    checkedBy: "helm-charts",
  },
  {
    name: "plane",
    description: "Install Plane into cc-office",
    commands: buildSinglePackageBundle("plane"),
    checkedBy: "helm-charts",
  },
  {
    name: "postgres",
    description: "Install the CloudNativePG operator, and the Postgres cc-office shares",
    commands: buildSinglePackageBundle("cloudnative-pg"),
    checkedBy: "helm-charts",
  },
  {
    name: "placement",
    description: "Keep each placed namespace's pods in its region",
    commands: PlacementCommands,
  },
  {
    name: "preflight",
    description: "Check a node could be installed on, changing nothing",
    commands: PreflightCommands,
  },
  {
    name: "projectsend",
    description: "Install ProjectSend into cc-office, signing in through Authentik",
    commands: buildSinglePackageBundle("projectsend"),
    checkedBy: "helm-charts",
  },
  {
    name: "rabbitmq",
    description: "Install the RabbitMQ operators into rabbitmq-system, and the RabbitMQ cc-office shares",
    commands: buildSinglePackageBundle("rabbitmq-operator"),
    checkedBy: "helm-charts",
  },
  {
    name: "redis",
    description: "Install the Redis operator into community-cloud, and the Redis cc-office shares",
    commands: buildSinglePackageBundle("redis-operator"),
    checkedBy: "helm-charts",
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
    name: "node-removed",
    description: "Remove a node from the cluster, and check the cluster agrees",
    commands: NodeRemovedCommands,
    teardown: true,
  },
  {
    name: "nodeLabels",
    description: "Label a node with its roles, its own labels, and what was detected on it",
    commands: [
      ...unlessKnown(GpuInfoCommands, "videoDevices"),
      ...unlessKnown(LvmCommands, "storageClassesPresent"),
      ...NodeLabelCommands,
    ],
  },
  {
    name: "twenty",
    description: "Install the Twenty CRM into cc-office",
    commands: buildSinglePackageBundle("twenty"),
    checkedBy: "helm-charts",
  },
  {
    name: "storage-remove",
    description: "Destroy the volume groups this installer created, and the data in them",
    commands: StorageRemoveCommands,
    teardown: true,
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
 * The bundles that describe a working cluster rather than one being
 * taken apart, and whose checks no other bundle already asks.
 *
 * What a check-up should ask about, and nothing else.
 *
 * @returns
 */
export function getCheckableBundleNames(): string[] {
  return bundles
    .filter((bundle) => bundle.teardown !== true && bundle.checkedBy === undefined)
    .map((bundle) => bundle.name);
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
