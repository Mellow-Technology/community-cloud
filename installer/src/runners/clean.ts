/**
 * @file
 * Remove what an uninstall kept.
 *
 * Uninstalling leaves a node's configuration, its container images,
 * its certificates and — most of all — its volume groups exactly where
 * they were, so that a machine taken out of a cluster can be put back
 * into one and find everything still there. This is the command for
 * when that isn't what you want: the machine is being repurposed, or
 * given away, or rebuilt from nothing.
 *
 * Two levels, because there are two different sizes of loss:
 *
 * - by default, the K3s directories. The datastore, the kubeconfig,
 *   the registry credentials, the image cache. Painful to lose and all
 *   of it rebuildable by installing again.
 * - with --full, the volume groups as well, which is where the data
 *   actually is. TopoLVM carves every persistent volume out of them,
 *   so this is the contents of every database and every upload on the
 *   node. Nothing here can put that back, which is why --full on its
 *   own only prints what it would destroy and --yes is what does it.
 *
 * Cleaning a node that is still running K3s is refused rather than
 * attempted, and not only because it would be pointless. A volume
 * still mounted under /var/lib/kubelet turns "rm -rf /var/lib/kubelet"
 * into a delete of what is inside the volume, which is the one outcome
 * every other decision in here exists to avoid.
 */
import chalk from "chalk";

import CloudConfig from "../util/CloudConfig.ts";
import { ALL_NODES, resolveTarget } from "../pipeline/fleet.ts";
import { describeStop, executePipeline, printPlan } from "../pipeline/execute.ts";
import { loadPlugins } from "../plugins/registry.ts";

/**
 * The bundles a clean runs, in order.
 *
 * The filesystem first and the disks second, so that a run stopped in
 * the middle has removed the recoverable half rather than the other
 * one.
 */
export const CLEAN_PIPELINE = ["clean"];
export const CLEAN_FULL_PIPELINE = ["clean", "storage-remove"];

/**
 * Options for a clean.
 *
 * - full: also destroy the volume groups this installer created
 * - yes: having seen what --full would destroy, do it
 */
export interface CleanOptions {
  full?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  keepGoing?: boolean;
  timeout?: string | number;
  verbose?: boolean;
}

/**
 * Remove what is left of Community Cloud from a node.
 *
 * @param target a node name, or "all" for every node in the cluster
 * @param configPath
 * @param options
 */
export async function clean(
  target: string,
  configPath: string,
  options: CleanOptions = {},
) {
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);
  loadPlugins(config);

  // Unlike an uninstall, this is happy to do every node at once. There
  // is no ordering between machines here and nothing to move anywhere:
  // each node is being tidied up on its own.
  const names = resolveTarget(config, target);
  const full = options.full === true;
  const where = target === ALL_NODES ? `${names.length} nodes` : target;

  const outcome = await executePipeline(config, {
    pipeline: (full ? CLEAN_FULL_PIPELINE : CLEAN_PIPELINE).join(","),
    nodes: names,
    what: "cleaned",
    heading: `\n${chalk.bold("Cleaning")} ${chalk.cyan(where)}${full ? chalk.red.bold(" and destroying their volume groups") : ""}`,
    keepGoing: options.keepGoing,
    dryRun: options.dryRun,
    timeout: options.timeout,
    verbose: options.verbose,

    // What the storage bundle refuses to run without. The bundle
    // checks this itself rather than trusting the runner, so that
    // reaching it by another route — run-bundle, a pipeline in the
    // configuration — is no shorter a path to destroying a disk.
    context: { storageApproved: full && options.yes === true },

    verify: true,
  });

  if (outcome.dryRun) {
    printPlan(outcome.plan);
    return;
  }

  const { summary, verification } = outcome;

  if (summary.failures.length > 0) {
    // The one failure worth reading differently: it isn't a thing that
    // went wrong, it is the command declining to do the irreversible
    // half until somebody says so
    const refused = summary.failures.some(
      (failure) => failure.step === "check-storage-approved",
    );

    throw new Error(
      refused
        ? `Nothing was destroyed. The volume groups listed above hold what the cluster stored on ${names.length === 1 ? "this node" : "these nodes"} — run the same command again with --yes to remove them.`
        : `Cleaning ${where} ${describeStop(summary)}.`,
    );
  }

  const checks = verification ?? { failures: [] };

  if (checks.failures.length > 0) {
    throw new Error(
      `The clean ran every step and ${checks.failures.length} check${checks.failures.length === 1 ? " doesn't" : "s don't"} pass, so something is still there that shouldn't be.`,
    );
  }

  console.log(
    chalk.green.bold(
      full
        ? `\n${where} cleaned, and the volume groups are gone.\n`
        : `\n${where} cleaned.\n`,
    ),
  );

  if (!full) {
    console.log(
      `The volume groups are still there, and so is what was stored in them. To remove those as well: ${chalk.cyan("clean --full --yes")}.\n`,
    );
  }
}
