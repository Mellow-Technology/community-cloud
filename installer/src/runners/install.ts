/**
 * @file
 * Install a whole cluster.
 *
 * This is the pipeline in a particular order, and the order is the
 * interesting part, so it is written out here rather than assembled
 * from something cleverer. Somebody debugging an install at two in the
 * morning should be able to read the sequence.
 *
 * The order, and why:
 *
 *  1. preflight   — say what would stop this before anything changes
 *  2. base        — the packages every later step assumes
 *  3. network     — kernel networking, before anything uses the network
 *  4. gpu         — detect hardware, so the labels later can describe it
 *  5. registries  — credentials, before K3s starts and reads them
 *  6. lvm         — volume groups, before anything wants storage
 *  7. k3s         — servers, then agents; the cluster starts existing
 *  8. nodeLabels  — every node described, including what lvm and gpu found
 *  9. cilium      — the network the pods actually use
 * 10. gateway     — a way in from outside
 * 11. helm        — Helm itself, on the control plane
 * 12. helm-charts — storage classes, databases, applications
 * 13. cluster     — record what this cluster was built from
 *
 * Nebula is not here. A mesh is a decision about how sites reach each
 * other rather than a step in building one cluster, and a
 * configuration that wants it should run it deliberately.
 */
import chalk from "chalk";

import CloudConfig from "../util/CloudConfig.ts";
import { ALL_NODES, resolveTarget } from "../pipeline/fleet.ts";
import { describeStop, executePipeline, printPlan } from "../pipeline/execute.ts";
import { checkConfiguration } from "./preflight.ts";
import { loadPlugins } from "../plugins/registry.ts";

/**
 * The bundles an install runs, in order.
 */
export const INSTALL_PIPELINE = [
  "preflight",
  "base",
  "network",
  "gpu",
  "registries",
  "lvm",
  "k3s",
  "nodeLabels",
  "cilium",
  "gateway",
  "helm",
  "helm-charts",
  "cluster",
];

/**
 * Options for an install.
 *
 * - dryRun: work out every step and print it, changing nothing
 * - keepGoing: carry on past a failed step
 * - node: install onto one node rather than the whole cluster, which
 *   is for adding a machine to a cluster that already exists
 */
export interface InstallOptions {
  dryRun?: boolean;
  keepGoing?: boolean;
  node?: string;
  timeout?: string | number;
}

/**
 * Install Community Cloud.
 *
 * @param configPath
 * @param options
 */
export async function install(configPath: string, options: InstallOptions = {}) {
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);
  loadPlugins(config);

  // Whatever preflight would say, said before a single connection is
  // opened. A configuration with two servers in it is not going to
  // become installable halfway through.
  const problems = checkConfiguration(config);

  if (problems.length > 0) {
    throw new Error(
      `This configuration can't be installed as it stands:\n${problems
        .map((problem) => `  · ${problem.what}`)
        .join("\n")}`,
    );
  }

  const target = options.node !== undefined ? options.node : ALL_NODES;
  const names = resolveTarget(config, target);

  const outcome = await executePipeline(config, {
    pipeline: INSTALL_PIPELINE.join(","),
    nodes: names,
    what: "installed",
    heading: `\n${chalk.bold("Installing Community Cloud")} onto ${chalk.cyan(`${names.length} node${names.length === 1 ? "" : "s"}`)}`,
    keepGoing: options.keepGoing,
    dryRun: options.dryRun,
    timeout: options.timeout,

    // The install is over; say whether the thing it built works. The
    // verifications are already in the pipeline, so this is the whole
    // cluster asked once more rather than a different question, and it
    // is worth asking because a step that passed in isolation can be
    // undone by one after it.
    verify: true,
  });

  if (outcome.dryRun) {
    printPlan(outcome.plan);
    return;
  }

  const { summary, verification } = outcome;

  if (summary.failures.length > 0) {
    throw new Error(
      `The install ${describeStop(summary)} — fix what failed and run the install again.`,
    );
  }

  // Verification was asked for and the run got to the end, so
  // there is always one of these
  const checks = verification ?? { failures: [] };

  if (checks.failures.length > 0) {
    throw new Error(
      `The install ran to the end and ${checks.failures.length} check${checks.failures.length === 1 ? " doesn't" : "s don't"} pass. The cluster is built and something in it isn't working.`,
    );
  }

  console.log(chalk.green.bold("The cluster is up.\n"));
}
