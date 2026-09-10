/**
 * @file
 * Run several bundles against a node, one after another.
 *
 * The reason this exists rather than running the bundles by hand is
 * that they have things to tell each other. Detecting what video
 * hardware a node has is only useful if whatever installs the vendor
 * runtime can see the answer, so a pipeline hands one context through
 * every bundle in turn: what one puts in, the next can read.
 *
 * A failure stops the pipeline. A bundle stops at its first failing
 * command, and the bundles after it don't run at all, on the grounds
 * that a step which didn't finish has left the node in a state the
 * next step wasn't written for.
 */
import chalk from "chalk";

import { CommandBundle } from "../cli/commands/CommandBundle.ts";
import CloudConfig from "../util/CloudConfig.ts";
import {
  BundleDefinition,
  getBundle,
  getBundleCommands,
  getBundleNames,
} from "../cli/commands/bundles.ts";
import { NodeConnection, connectToControlPlane, connectToNode } from "./nodeConnection.ts";

/**
 * Options for a pipeline run.
 *
 * - keepGoing: carry on after a bundle fails instead of stopping.
 *   Off by default, and worth being sure about: the bundles that
 *   follow will be running against a node that isn't in the state
 *   they expect.
 */
export interface RunPipelineOptions {
  keepGoing?: boolean;
}

/**
 * Run a pipeline of bundles against a node.
 *
 * @param pipelineName either a comma separated list of bundles, or the
 *   name of one defined under "pipelines" in the configuration
 * @param nodeName
 * @param configPath
 * @param options
 */
export async function runPipeline(
  pipelineName: string,
  nodeName: string,
  configPath: string,
  options: RunPipelineOptions = {},
) {
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);

  // Work out the whole pipeline before running any of it, so a name
  // misspelled at the end doesn't come to light three bundles in
  const definitions = resolvePipeline(config, pipelineName);

  console.log(
    `\n${chalk.bold("Pipeline")} ${chalk.cyan(pipelineName)} on ${chalk.cyan(nodeName)}: ${definitions.map((bundle) => bundle.name).join(" → ")}\n`,
  );

  const connection = await connectToNode(config, nodeName);

  // One context for the whole run. Each bundle reads what the ones
  // before it left, which is the point of running them together.
  const context: Record<string, unknown> = {
    nodeName,
    node: connection.node,
    params: [],
  };

  const completed: string[] = [];
  const failures: string[] = [];

  // Opened once, the first time a bundle asks for it, and shared by
  // every bundle after that. Held on an object rather than in a plain
  // variable so the assignment inside the closure is visible to the
  // cleanup below.
  const opened: { controlPlane?: NodeConnection } = {};
  const getControlPlane = async (): Promise<NodeConnection> => {
    if (opened.controlPlane === undefined) {
      opened.controlPlane = await connectToControlPlane(config, connection);
    }

    return opened.controlPlane;
  };

  try {
    for (const definition of definitions) {
      console.log(`${chalk.bold("▶")} ${chalk.cyan.bold(definition.name)}  ${chalk.dim(definition.description)}`);

      const commands = getBundleCommands(definition, config, context);
      const bundle = new CommandBundle(config, commands, context);
      bundle.setExec(connection.exec);

      if (bundle.needsControlPlane(commands)) {
        bundle.setControlPlaneExec((await getControlPlane()).exec);
      }

      await bundle.runAllCommands();

      if (!bundle.hasFailed()) {
        completed.push(definition.name);
        continue;
      }

      const failedCommand = bundle.getFailedCommand();
      failures.push(definition.name);

      if (options.keepGoing !== true) {
        reportPipeline(definitions, completed, failures, context);
        throw new Error(
          `The pipeline stopped in the "${definition.name}" bundle, at the "${failedCommand}" command. The bundles after it weren't run.`,
        );
      }

      console.log(
        chalk.red(
          `⚠️  "${definition.name}" failed at "${failedCommand}", carrying on because --keep-going was set`,
        ),
      );
    }
  } finally {
    if (opened.controlPlane !== undefined && opened.controlPlane !== connection) {
      await opened.controlPlane.disconnect();
    }

    await connection.disconnect();
  }

  reportPipeline(definitions, completed, failures, context);

  if (failures.length > 0) {
    throw new Error(
      `The pipeline finished with failures in: ${failures.join(", ")}.`,
    );
  }
}

/**
 * Work out which bundles a pipeline is made of.
 *
 * @param config
 * @param pipelineName
 * @returns
 */
export function resolvePipeline(
  config: CloudConfig,
  pipelineName: string,
): BundleDefinition[] {
  const names = getPipelineBundles(config, pipelineName);

  if (names.length === 0) {
    throw new Error(`The pipeline "${pipelineName}" has no bundles in it.`);
  }

  return names.map((name) => {
    const bundle = getBundle(name);

    if (bundle === undefined) {
      throw new Error(
        `The pipeline "${pipelineName}" names a bundle "${name}" that doesn't exist. The bundles that can be run are: ${getBundleNames().join(", ")}.`,
      );
    }

    return bundle;
  });
}

/**
 * The bundle names in a pipeline.
 *
 * A pipeline is either written out on the command line as a comma
 * separated list, or named in the configuration. Configurations are
 * where a cluster's own install order belongs, since only the cluster
 * knows what order its nodes want.
 *
 * @param config
 * @param pipelineName
 * @returns
 */
function getPipelineBundles(config: CloudConfig, pipelineName: string): string[] {
  const named = getConfiguredPipelines(config)[pipelineName];
  if (named !== undefined) {
    return named;
  }

  return pipelineName
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/**
 * The pipelines a configuration defines.
 *
 * @param config
 * @returns
 */
export function getConfiguredPipelines(config: CloudConfig): Record<string, string[]> {
  const { pipelines } = config.getConfig();
  return pipelines !== undefined && pipelines !== null ? pipelines : {};
}

/**
 * Say what ran, what didn't, and what the bundles left behind for
 * each other.
 *
 * @param definitions
 * @param completed
 * @param failures
 * @param context
 */
function reportPipeline(
  definitions: BundleDefinition[],
  completed: string[],
  failures: string[],
  context: Record<string, unknown>,
) {
  console.log(`\n${chalk.bold("Pipeline summary")}\n`);

  for (const definition of definitions) {
    if (completed.includes(definition.name)) {
      console.log(`  ${chalk.green("✅")} ${definition.name}`);
    }
    else if (failures.includes(definition.name)) {
      console.log(`  ${chalk.red("⛔")} ${definition.name}`);
    }
    else {
      console.log(`  ${chalk.dim("⏸  " + definition.name + " (not run)")}`);
    }
  }

  // The values the bundles put where the next one could find them.
  // Printed as keys rather than values, since a hardware inventory
  // doesn't belong in a summary.
  const shared = Object.keys(context).filter(
    (key) => !["nodeName", "node", "params"].includes(key),
  );

  console.log(
    shared.length > 0
      ? `\n  ${chalk.dim("shared context: " + shared.join(", "))}\n`
      : `\n  ${chalk.dim("nothing was added to the shared context")}\n`,
  );
}
