/**
 * @file
 * Run bundles against one node or the whole cluster.
 *
 * Both commands that do this live here, because a bundle is a pipeline
 * with one entry and pretending otherwise would mean two copies of the
 * same thing. Running "base" against every node gets the same barrier
 * between steps, the same refusal to start when two nodes turn out to
 * be one machine, and the same per-node reporting as an install — it is
 * the same code, and only the word in the heading differs.
 *
 * A single node is a cluster of one rather than a separate code path.
 * That is worth insisting on: the interesting bugs in multi-node work
 * are the ones that only appear with more than one machine, and having
 * one node take a different route through the code is how those hide.
 *
 * What actually runs the steps is in src/pipeline — this is the part
 * that reads a configuration and decides what to say when it is over.
 */
import chalk from "chalk";

import CloudConfig from "../util/CloudConfig.ts";
import { ALL_NODES, resolveTarget } from "../pipeline/fleet.ts";
import { describeStop, executePipeline, printPlan } from "../pipeline/execute.ts";
import { getConfiguredPipelines, resolvePipeline } from "../pipeline/plan.ts";
import { loadPlugins } from "../plugins/registry.ts";

export { getConfiguredPipelines, resolvePipeline };

/**
 * Options for a run.
 *
 * - keepGoing: carry on after a step fails instead of stopping. Off by
 *   default, and worth being sure about: the steps that follow were
 *   written for a cluster that got through this one.
 * - dryRun: work out every step and print it without running any.
 * - timeout: how long to give a node to answer when connecting.
 * - verbose: let the commands narrate as well as the run.
 */
export interface RunPipelineOptions {
  keepGoing?: boolean;
  dryRun?: boolean;
  timeout?: string | number;
  verbose?: boolean;
}

/**
 * Run a pipeline.
 *
 * @param pipelineName a comma separated list of bundles, or the name
 *   of one defined under "pipelines" in the configuration
 * @param target a node name, or "all" for every node
 * @param configPath
 * @param options
 */
export async function runPipeline(
  pipelineName: string,
  target: string,
  configPath: string,
  options: RunPipelineOptions = {},
) {
  await run("Pipeline", pipelineName, target, configPath, options);
}

/**
 * Run one bundle.
 *
 * @param bundleName
 * @param target a node name, or "all" for every node
 * @param configPath
 * @param options
 */
export async function runBundle(
  bundleName: string,
  target: string,
  configPath: string,
  options: RunPipelineOptions = {},
) {
  await run("Bundle", bundleName, target, configPath, options);
}

/**
 * Run whatever was asked for.
 *
 * @param label what to call it in the heading and the failure
 * @param pipelineName
 * @param target
 * @param configPath
 * @param options
 */
async function run(
  label: string,
  pipelineName: string,
  target: string,
  configPath: string,
  options: RunPipelineOptions,
) {
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);
  loadPlugins(config);

  const names = resolveTarget(config, target);
  const where = target === ALL_NODES ? `${names.length} nodes` : target;

  const outcome = await executePipeline(config, {
    pipeline: pipelineName,
    nodes: names,
    what: "run",
    heading: `\n${chalk.bold(label)} ${chalk.cyan(pipelineName)} on ${chalk.cyan(where)}`,
    keepGoing: options.keepGoing,
    dryRun: options.dryRun,
    timeout: options.timeout,
    verbose: options.verbose,
  });

  if (outcome.dryRun) {
    printPlan(outcome.plan);
    return;
  }

  const { summary } = outcome;

  if (summary.failures.length > 0) {
    throw new Error(`${label} "${pipelineName}" ${describeStop(summary)}.`);
  }
}
