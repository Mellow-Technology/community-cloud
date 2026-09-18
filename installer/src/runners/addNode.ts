/**
 * @file
 * Add a machine to a cluster that already exists.
 *
 * This is an install with the cluster-wide half taken out. Everything
 * that builds the cluster itself — Cilium, the Gateway, Helm and the
 * charts — has already happened and would either be re-applied for
 * nothing or, worse, re-applied differently because the configuration
 * has moved on since. What's left is everything that makes one
 * machine into a member: packages, kernel settings, hardware, storage,
 * the agent itself, and the labels that describe it.
 *
 * Agents only, for now. A second server is a different and much
 * touchier operation — etcd has to be brought from one member to
 * three, and a cluster that was started without it can't simply be
 * told to grow one — so this refuses rather than half-doing it. The
 * scopes already distinguish the two, so when that work is done it
 * belongs here rather than somewhere new.
 *
 * The node has to be in the configuration before it can be added. That
 * is not a limitation so much as the point: the configuration is the
 * record of what the cluster is, and a node added without being
 * written down is one that vanishes from the next install.
 */
import chalk from "chalk";

import CloudConfig from "../util/CloudConfig.ts";
import { describeStop, executePipeline, printPlan } from "../pipeline/execute.ts";
import { checkConfiguration } from "./preflight.ts";
import { isServerNode } from "../pipeline/fleet.ts";
import { loadPlugins } from "../plugins/registry.ts";

/**
 * The bundles adding a node runs, in order.
 *
 * The install pipeline, minus what belongs to the cluster rather than
 * to a node, with the cluster's own health checked at the front and
 * the node's membership checked at the back.
 *
 *  1. cluster-online — is there a cluster to join
 *  2. preflight      — say what would stop this before anything changes
 *  3. base           — the packages every later step assumes
 *  4. network        — kernel networking
 *  5. gpu            — detect hardware, so the labels can describe it
 *  6. registries     — credentials, before K3s starts and reads them
 *  7. lvm            — volume groups, before anything wants storage
 *  8. k3s            — the agent joins
 *  9. nodeLabels     — the node described to the cluster
 * 10. node-joined    — the cluster's own word that it worked
 */
export const ADD_NODE_PIPELINE = [
  "cluster-online",
  "preflight",
  "base",
  "network",
  "gpu",
  "registries",
  "lvm",
  "k3s",
  "nodeLabels",
  "node-joined",
];

/**
 * Options for adding a node.
 */
export interface AddNodeOptions {
  dryRun?: boolean;
  keepGoing?: boolean;
  timeout?: string | number;
  verbose?: boolean;
}

/**
 * Add a node to a running cluster.
 *
 * @param nodeName the node to add, as it is named in the configuration
 * @param configPath
 * @param options
 */
export async function addNode(
  nodeName: string,
  configPath: string,
  options: AddNodeOptions = {},
) {
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);
  loadPlugins(config);

  const node = config.getNode(nodeName);

  if (node === null || node === undefined) {
    const known = configuredNodeNames(config);

    throw new Error(
      `There's no node called "${nodeName}" in this configuration, so there's nothing to add. Add it under "nodes" first — that file is the record of what the cluster is. It currently has: ${known.join(", ") || "no nodes at all"}.`,
    );
  }

  if (isServerNode(node)) {
    throw new Error(
      `"${nodeName}" is configured as a server, and add-node can only add agents at the moment. Growing the control plane means bringing the cluster's datastore from one member to several, which isn't something to do halfway — set "type": "agent" on it, or add the server by hand.`,
    );
  }

  // Whatever preflight would say about the configuration, said before
  // a single connection is opened
  const problems = checkConfiguration(config);

  if (problems.length > 0) {
    throw new Error(
      `This configuration can't be installed from as it stands:\n${problems
        .map((problem) => `  · ${problem.what}`)
        .join("\n")}`,
    );
  }

  const outcome = await executePipeline(config, {
    pipeline: ADD_NODE_PIPELINE.join(","),
    nodes: [nodeName],
    what: "added",
    heading: `\n${chalk.bold("Adding")} ${chalk.cyan(nodeName)} ${chalk.bold("to the cluster")}`,
    keepGoing: options.keepGoing,
    dryRun: options.dryRun,
    timeout: options.timeout,
    verbose: options.verbose,

    // The node is in the cluster or it isn't, and the checks that
    // answer that are already in the pipeline
    verify: true,
  });

  if (outcome.dryRun) {
    printPlan(outcome.plan);
    return;
  }

  const { summary, verification } = outcome;

  if (summary.failures.length > 0) {
    throw new Error(
      `Adding ${nodeName} ${describeStop(summary)}. The cluster is untouched apart from this node — fix what failed and run add-node again.`,
    );
  }

  // Verification was asked for and the run got to the end, so
  // there is always one of these
  const checks = verification ?? { failures: [] };

  if (checks.failures.length > 0) {
    throw new Error(
      `${nodeName} ran every step and ${checks.failures.length} check${checks.failures.length === 1 ? " doesn't" : "s don't"} pass. It is in the cluster and something about it isn't working.`,
    );
  }

  console.log(chalk.green.bold(`${nodeName} is in the cluster.\n`));
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
