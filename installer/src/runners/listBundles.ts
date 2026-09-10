/**
 * @file
 * Show what there is to run.
 */
import chalk from "chalk";

import CloudConfig from "../util/CloudConfig.ts";
import { getCommandType } from "../cli/commands/createCommand.ts";
import { CommandSpec, CommandTarget, CommandType } from "../cli/commands/Command.ts";
import { getConfiguredPipelines } from "./runPipeline.ts";
import {
  BundleDefinition,
  bundles,
  getBundle,
  getBundleCommands,
  getBundleNames,
  isBuiltFromConfig,
} from "../cli/commands/bundles.ts";

/**
 * Options for a listing.
 *
 * - config: a configuration file. Only needed for bundles whose
 *   commands are built from one.
 */
export interface ListBundlesOptions {
  config?: string;
}

/**
 * List the bundles that can be run, or the commands in one of them.
 *
 * @param bundleName
 * @param options
 */
export async function listBundles(
  bundleName?: string,
  options: ListBundlesOptions = {},
) {
  // Only loaded when there's something to load. Listing what exists
  // shouldn't need a configuration for the bundles that don't use one.
  const config = await loadConfig(options.config);

  if (bundleName !== undefined) {
    listOneBundle(bundleName, config);
    return;
  }

  listEveryBundle(config);
}

/**
 * Show every bundle with a line each.
 *
 * @param config
 */
function listEveryBundle(config: CloudConfig | null) {
  console.log(`\n${chalk.bold("Command bundles")}\n`);

  const summaries = bundles.map((bundle) => describeCommands(bundle, config));
  const nameWidth = Math.max(...bundles.map((bundle) => bundle.name.length));
  const summaryWidth = Math.max(...summaries.map((summary) => summary.length));

  bundles.forEach((bundle, index) => {
    const name = chalk.cyan.bold(bundle.name.padEnd(nameWidth));
    const summary = chalk.dim((summaries[index] ?? "").padEnd(summaryWidth));
    console.log(`  ${name}  ${summary}  ${bundle.description}`);
  });

  listPipelines(config);

  console.log(`
${chalk.dim("Run one:")}              community-cloud run-bundle <bundle> <node> <ccFilePath>
${chalk.dim("Run several:")}          community-cloud run-pipeline <bundle,bundle,...> <node> <ccFilePath>
${chalk.dim("Show its commands:")}    community-cloud list-bundles <bundle>
`);
}

/**
 * Show the pipelines a configuration defines, when there is one to
 * read them from.
 *
 * @param config
 */
function listPipelines(config: CloudConfig | null) {
  if (config === null) {
    console.log(`\n  ${chalk.dim("Pass --config <ccFilePath> to also list the pipelines it defines.")}`);
    return;
  }

  const pipelines = getConfiguredPipelines(config);
  const names = Object.keys(pipelines);

  if (names.length === 0) {
    console.log(`\n  ${chalk.dim('No pipelines in this configuration. Add them under "pipelines".')}`);
    return;
  }

  console.log(`\n${chalk.bold("Pipelines")}\n`);

  const width = Math.max(...names.map((name) => name.length));
  for (const name of names) {
    const bundles = pipelines[name];
    const steps = Array.isArray(bundles) ? bundles.join(" → ") : chalk.red("not a list of bundles");
    console.log(`  ${chalk.cyan.bold(name.padEnd(width))}  ${steps}`);
  }
}

/**
 * Show the commands in a single bundle.
 *
 * @param bundleName
 * @param config
 */
function listOneBundle(bundleName: string, config: CloudConfig | null) {
  const bundle = getBundle(bundleName);
  if (bundle === undefined) {
    throw new Error(
      `Couldn't find a command bundle named "${bundleName}". The bundles that can be run are: ${getBundleNames().join(", ")}.`,
    );
  }

  console.log(`\n${chalk.cyan.bold(bundle.name)} — ${bundle.description}\n`);

  // A bundle built from the configuration has nothing to show until
  // there's a configuration to build it from
  if (isBuiltFromConfig(bundle) && config === null) {
    console.log(
      chalk.dim(
        `  This bundle's commands come from the configuration.\n  Pass --config <ccFilePath> to list them.\n`,
      ),
    );
    return;
  }

  const commands = getBundleCommands(bundle, config as CloudConfig);
  const width = Math.max(...commands.map((command) => command.name.length));
  const targets = commands.map(describeTarget);
  const targetWidth = Math.max(...targets.map((target) => target.length));

  commands.forEach((command, index) => {
    const step = String(index + 1).padStart(2);
    const name = chalk.bold(command.name.padEnd(width));
    const kind = chalk.dim((getCommandType(command) ?? "unknown").padEnd(8));
    const target = chalk.dim((targets[index] ?? "").padEnd(targetWidth));
    console.log(`  ${chalk.dim(step + ".")} ${name}  ${kind}  ${target}  ${command.description}`);
  });

  console.log();
}

/**
 * Where a command runs, for the listing.
 *
 * Worth showing: a bundle aimed at one node can still have steps that
 * run somewhere else, and that isn't obvious from the name.
 *
 * @param command
 * @returns
 */
function describeTarget(command: CommandSpec): string {
  if (getCommandType(command) === CommandType.Web) {
    return "installer";
  }

  return command.runOn === CommandTarget.ControlPlane ? "control plane" : "node";
}

/**
 * A line saying what a bundle is made of.
 *
 * @param bundle
 * @param config
 * @returns
 */
function describeCommands(bundle: BundleDefinition, config: CloudConfig | null): string {
  if (isBuiltFromConfig(bundle) && config === null) {
    return "built from configuration";
  }

  const commands = getBundleCommands(bundle, config as CloudConfig);
  const kinds = commands.map((command) => getCommandType(command));
  const web = kinds.filter((kind) => kind === "web").length;
  const terminal = kinds.length - web;

  const parts = [];
  if (terminal > 0) {
    parts.push(`${terminal} command${terminal === 1 ? "" : "s"}`);
  }
  if (web > 0) {
    parts.push(`${web} API call${web === 1 ? "" : "s"}`);
  }

  return parts.join(", ");
}

/**
 * Load the configuration, if one was named.
 *
 * @param configPath
 * @returns
 */
async function loadConfig(configPath?: string): Promise<CloudConfig | null> {
  if (configPath === undefined) {
    return null;
  }

  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);
  return config;
}
