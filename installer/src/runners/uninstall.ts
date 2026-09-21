/**
 * @file
 * Take a node back out of a cluster.
 *
 * This is the install read backwards, and only the part of it that
 * belongs to one machine. Nothing here touches Cilium, the Gateway,
 * Helm or the charts: those are the cluster, they are shared, and
 * removing them because one node is leaving would take the cluster
 * down to remove a machine from it.
 *
 * The order, and why:
 *
 *  1. cluster-online  — is there a cluster to take this out of
 *  2. drain           — move the workloads off before stopping them
 *  3. k3s-uninstall   — stop K3s and remove it, keeping the data
 *  4. node-removed    — tell the cluster the machine has gone
 *
 * Draining first is the whole reason this is a pipeline rather than a
 * single command. Stopping K3s on a node kills whatever is on it and
 * the cluster reschedules it a couple of minutes later, once it has
 * noticed; draining moves the work first and waits for it to land, so
 * the difference between the two is whether anything goes down.
 *
 * Removing the node from the cluster comes last for the same kind of
 * reason: a Node object deleted while its kubelet is still running is
 * simply recreated a few seconds later by the kubelet registering
 * again, so it can only be made to stick once the agent is stopped.
 *
 * What is not checked here, deliberately, is whether the configuration
 * would produce a working install. An install refuses to start against
 * a configuration with a problem in it, which is right — there is no
 * point building half a cluster. Uninstalling is the opposite case: a
 * configuration nobody can install from is a more likely reason to be
 * taking a node apart than a healthy one, and refusing to clean up
 * after a bad configuration because it is bad would be absurd.
 */
import chalk from "chalk";

import CloudConfig from "../util/CloudConfig.ts";
import { ALL_NODES, isServerNode } from "../pipeline/fleet.ts";
import { describeStop, executePipeline, printPlan } from "../pipeline/execute.ts";
import { loadPlugins } from "../plugins/registry.ts";

/**
 * The bundles taking an agent out of a cluster runs, in order.
 */
export const UNINSTALL_PIPELINE = [
  "cluster-online",
  "drain",
  "k3s-uninstall",
  "node-removed",
];

/**
 * The same, for a node whose cluster isn't going to be asked anything.
 *
 * A server has no cluster to be removed from — it was the cluster —
 * and nowhere to drain to, since draining the control plane means
 * evicting the pods that would carry out the eviction. What is left is
 * the part that is about the machine.
 */
export const UNINSTALL_SERVER_PIPELINE = ["k3s-uninstall"];

/**
 * Options for an uninstall.
 *
 * - server: take down a control plane, which destroys the cluster.
 *   Required rather than implied, and see below for why.
 * - skipDrain: stop the workloads rather than moving them. For a node
 *   whose pods can't be evicted — a disruption budget that can't be
 *   satisfied, a machine that is half dead anyway.
 * - drainTimeout: how long to give the eviction API, in seconds
 */
export interface UninstallOptions {
  dryRun?: boolean;
  keepGoing?: boolean;
  timeout?: string | number;
  verbose?: boolean;
  server?: boolean;
  skipDrain?: boolean;
  drainTimeout?: string | number;
}

/**
 * Take a node out of the cluster and K3s off it.
 *
 * @param nodeName the node, as it is named in the configuration
 * @param configPath
 * @param options
 */
export async function uninstall(
  nodeName: string,
  configPath: string,
  options: UninstallOptions = {},
) {
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);
  loadPlugins(config);

  // "all" is every node everywhere else, and it can't mean that here.
  // Draining every node at once cannot succeed — there is nowhere for
  // the work to go — so the whole run would sit through its timeouts
  // and then fail, having cordoned the entire cluster on the way.
  if (nodeName === ALL_NODES) {
    throw new Error(
      `Uninstalling takes one node at a time. Every node at once would mean draining every node at once, which can't work: there would be nowhere for the workloads to go. Take the agents out one by one, and the server last with --server.`,
    );
  }

  const node = config.getNode(nodeName);

  if (node === null || node === undefined) {
    const known = configuredNodeNames(config);

    throw new Error(
      `There's no node called "${nodeName}" in this configuration, so there's nothing to uninstall. It has: ${known.join(", ") || "no nodes at all"}.`,
    );
  }

  const isServer = isServerNode(node);

  // The one thing in here that isn't reversible by running something
  // else. An agent can be taken out and added back; a server taking
  // its datastore and its certificate authority with it is the cluster
  // ending, so it is something to have typed on purpose.
  if (isServer && options.server !== true) {
    throw new Error(
      `"${nodeName}" is a server. Uninstalling it destroys the cluster: the datastore, the certificate authority and the token all live on it, and every agent loses its control plane. Nothing here can put that back.\n` +
        `Pass --server if that is what you mean. To take a machine out of a cluster that carries on without it, uninstall an agent instead.`,
    );
  }

  if (!isServer && options.server === true) {
    throw new Error(
      `--server says "yes, destroy the cluster", and "${nodeName}" is an agent, so it would be agreeing to something that isn't going to happen. Leave it off.`,
    );
  }

  const pipeline = getPipeline(isServer, options);

  if (isServer && options.dryRun !== true) {
    console.log(
      `\n${chalk.red.bold("This destroys the cluster.")} ${chalk.cyan(nodeName)} is its control plane, and what is on it — the datastore, the certificate authority, the token — is not written down anywhere else.`,
    );
  }

  const outcome = await executePipeline(config, {
    pipeline: pipeline.join(","),
    nodes: [nodeName],
    what: "uninstalled",
    heading: `\n${chalk.bold("Uninstalling")} ${chalk.cyan(nodeName)}`,
    keepGoing: options.keepGoing,
    dryRun: options.dryRun,
    timeout: options.timeout,
    verbose: options.verbose,

    context: {
      ...(options.drainTimeout !== undefined
        ? { drainTimeout: Number(options.drainTimeout) }
        : {}),
    },

    // The node is out or it isn't, and the checks that answer that are
    // already in the pipeline
    verify: true,
  });

  if (outcome.dryRun) {
    printPlan(outcome.plan);
    return;
  }

  const { summary, verification } = outcome;

  if (summary.failures.length > 0) {
    throw new Error(
      `Uninstalling ${nodeName} ${describeStop(summary)}. Nothing else in the cluster was touched — fix what failed and run it again.`,
    );
  }

  const checks = verification ?? { failures: [] };

  if (checks.failures.length > 0) {
    throw new Error(
      `${nodeName} ran every step and ${checks.failures.length} check${checks.failures.length === 1 ? " doesn't" : "s don't"} pass, so something about it is not as it should be.`,
    );
  }

  console.log(
    chalk.green.bold(
      isServer
        ? `\nK3s is off ${nodeName}. The cluster is gone.\n`
        : `\n${nodeName} is out of the cluster.\n`,
    ),
  );

  console.log(
    `Its configuration and data are still on it — ${chalk.cyan("/etc/rancher/k3s")}, ${chalk.cyan("/var/lib/rancher/k3s")} and every volume group — so it can be built again${isServer ? "" : ` with ${chalk.cyan(`add-node ${nodeName}`)}`}. To remove those as well: ${chalk.cyan(`clean ${nodeName}`)}.\n`,
  );
}

/**
 * The bundles this particular uninstall should run.
 *
 * @param isServer
 * @param options
 * @returns
 */
function getPipeline(isServer: boolean, options: UninstallOptions): string[] {
  if (isServer) {
    return UNINSTALL_SERVER_PIPELINE;
  }

  return options.skipDrain === true
    ? UNINSTALL_PIPELINE.filter((bundle) => bundle !== "drain")
    : UNINSTALL_PIPELINE;
}

/**
 * The nodes a configuration describes.
 *
 * @param config
 * @returns
 */
function configuredNodeNames(config: CloudConfig): string[] {
  const { nodes } = config.getConfig();

  return Array.isArray(nodes) ? nodes.map((node: any) => node.name) : [];
}
