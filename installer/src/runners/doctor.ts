/**
 * @file
 * Ask a cluster how it's doing.
 *
 * Every bundle in here already knows how to tell whether its part of
 * the world is right — that's what the check and verify commands are.
 * The trouble is that those answers only surface while installing
 * something, which is the one time you already know what you changed.
 * The interesting moment is the other one: a cluster that has been
 * running for months and something is off.
 *
 * So this runs all of them and none of the rest. Commands say what
 * they're for, and only the three purposes that change nothing are
 * asked for here, which is what makes this safe to point at a cluster
 * people depend on.
 *
 * It also doesn't stop at the first failure, unlike an install. One
 * thing being broken is the most likely reason to want to know what
 * else is.
 */
import { CommandBundle, CommandResult } from "../cli/commands/CommandBundle.ts";
import {
  CommandPurpose,
  CommandTarget,
  PROMPT_PURPOSES,
  READ_ONLY_PURPOSES,
} from "../cli/commands/Command.ts";
import { getCommandType } from "../cli/commands/createCommand.ts";
import {
  BundleDefinition,
  bundles,
  getBundle,
  getBundleCommands,
  getBundleNames,
} from "../cli/commands/bundles.ts";
import CloudConfig from "../util/CloudConfig.ts";
import { connectToControlPlane, connectToNode, NodeConnection } from "./nodeConnection.ts";
import chalk from "chalk";

/**
 * Options for a check-up.
 *
 * - node: look at this node only, rather than every one configured
 * - bundle: run this bundle's checks only
 * - verifications: skip the Inspect commands and only run the ones
 *   that assert something. Quieter, and closer to "what's wrong".
 * - wait: also run the commands that wait for something to settle.
 *   They change nothing either, but on a cluster with a problem — the
 *   reason to be running this — each one waits out its whole timeout
 *   before agreeing there's a problem.
 * - verbose: print each command's output as it goes, on top of the
 *   report at the end
 */
export interface DoctorOptions {
  node?: string;
  bundle?: string;
  verifications?: boolean;
  wait?: boolean;
  verbose?: boolean;
}

/**
 * What one bundle had to say about one node.
 */
interface BundleReport {
  bundle: string;
  node: string;
  results: Record<string, CommandResult>;
}

/**
 * The purposes to run.
 *
 * @param options
 * @returns
 */
function getPurposes(options: DoctorOptions): CommandPurpose[] {
  const asserting = [CommandPurpose.Require, CommandPurpose.Verify];

  const purposes =
    options.verifications === true
      ? asserting
      : options.wait === true
        ? READ_ONLY_PURPOSES
        : PROMPT_PURPOSES;

  return options.wait === true && options.verifications === true
    ? [...asserting, CommandPurpose.Settle]
    : purposes;
}

/**
 * The bundles to look at.
 *
 * @param options
 * @returns
 */
function getBundles(options: DoctorOptions): BundleDefinition[] {
  if (options.bundle === undefined) {
    return bundles;
  }

  const wanted = getBundle(options.bundle);
  if (wanted === undefined) {
    throw new Error(
      `Couldn't find a command bundle named "${options.bundle}". The bundles that can be run are: ${getBundleNames().join(", ")}.`,
    );
  }

  return [wanted];
}

/**
 * The nodes to look at.
 *
 * @param config
 * @param options
 * @returns
 */
function getNodes(config: CloudConfig, options: DoctorOptions): any[] {
  const { nodes } = config.getConfig();
  const configured = Array.isArray(nodes) ? nodes : [];

  if (options.node === undefined) {
    if (configured.length === 0) {
      throw new Error(
        'This configuration describes no nodes, so there is nothing to look at. Add them under "nodes".',
      );
    }

    return configured;
  }

  const node = config.getNode(options.node);
  if (node === null) {
    throw new Error(
      `Couldn't find node "${options.node}" in the specified configuration. Was the name misspelled?`,
    );
  }

  return [node];
}

/**
 * Whether everything a bundle would ask is asked of the cluster
 * rather than of a node.
 *
 * A bundle like cilium or helm-charts is about the cluster: running it
 * against each node in turn would ask the same control plane the same
 * questions over and over. One that reads the hardware or the kernel
 * has to be asked of each node separately. Which one a bundle is
 * follows from where its commands want to run, so nothing has to be
 * declared twice.
 *
 * @param specs
 * @returns
 */
function isAboutTheCluster(specs: any[]): boolean {
  return specs.every((spec) => spec.runOn === CommandTarget.ControlPlane);
}

/**
 * Run one bundle's questions against one node.
 *
 * @param config
 * @param bundle
 * @param connection
 * @param controlPlane
 * @param options
 * @returns
 */
async function askBundle(
  config: CloudConfig,
  bundle: BundleDefinition,
  connection: NodeConnection,
  controlPlane: NodeConnection,
  options: DoctorOptions,
): Promise<BundleReport | undefined> {
  const context: any = {
    nodeName: connection.node.name,
    node: connection.node,
    params: [],

    // Nothing here just changed anything, so there's nothing to wait
    // for. The waits inside these commands exist to ride out the gap
    // after an install, and on a node with a real problem they would
    // make this sit through every timeout in turn before saying so.
    noWaiting: options.wait !== true,
  };

  let specs: any[];
  try {
    specs = getBundleCommands(bundle, config, context);
  } catch (error: any) {
    // A bundle built from the configuration can refuse to be built at
    // all, which is itself worth reporting rather than hiding
    return {
      bundle: bundle.name,
      node: connection.node.name,
      results: {
        [`${bundle.name}-configuration`]: {
          stdout: "",
          stderr: error.message,
          parsed: null,
          error: true,
        },
      },
    };
  }

  const purposes = getPurposes(options);
  const wanted = specs.filter(
    (spec) => purposes.includes(spec.purpose) && getCommandType(spec) !== undefined,
  );

  if (wanted.length === 0) {
    return undefined;
  }

  const runner = new CommandBundle(config, specs, context)
    .setPurposes(purposes)
    .setContinueOnFailure()
    .setQuiet(options.verbose !== true)
    .setExec(connection.exec)
    .setControlPlaneExec(controlPlane.exec);

  await runner.runAllCommands();

  return { bundle: bundle.name, node: connection.node.name, results: runner.getResults() };
}

/**
 * Look at a cluster and say what's true of it.
 *
 * @param configPath
 * @param options
 */
export async function doctor(configPath: string, options: DoctorOptions = {}) {
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);

  const nodes = getNodes(config, options);
  const wanted = getBundles(options);
  const reports: BundleReport[] = [];

  // Asked once rather than once per node
  const clusterBundles = new Set<string>();

  let controlPlane: NodeConnection | undefined = undefined;

  try {
    for (const node of nodes) {
      console.log(`\n${chalk.bold(`── ${node.name} ──`)}`);

      let connection: NodeConnection;
      try {
        connection = await connectToNode(config, node.name);
      } catch (error: any) {
        console.log(`  ${chalk.red("unreachable")}: ${error.message}`);
        reports.push({
          bundle: "connection",
          node: node.name,
          results: {
            connect: { stdout: "", stderr: error.message, parsed: null, error: true },
          },
        });
        continue;
      }

      try {
        // The same connection when this node is the control plane
        if (controlPlane === undefined) {
          controlPlane = await connectToControlPlane(config, connection);
        }

        for (const bundle of wanted) {
          const specs = safeSpecs(config, bundle, connection.node);

          if (isAboutTheCluster(specs)) {
            if (clusterBundles.has(bundle.name)) {
              continue;
            }
            clusterBundles.add(bundle.name);
          }

          const report = await askBundle(config, bundle, connection, controlPlane, options);
          if (report !== undefined) {
            reports.push(report);
          }
        }
      } finally {
        if (controlPlane !== connection) {
          await connection.disconnect();
        }
      }
    }
  } finally {
    if (controlPlane !== undefined) {
      await controlPlane.disconnect();
    }
  }

  report(reports);
}

/**
 * A bundle's commands, or nothing when it can't be built.
 *
 * @param config
 * @param bundle
 * @param node
 * @returns
 */
function safeSpecs(config: CloudConfig, bundle: BundleDefinition, node: any): any[] {
  try {
    return getBundleCommands(bundle, config, { nodeName: node.name, node });
  } catch {
    return [];
  }
}

/**
 * Say what was found.
 *
 * @param reports
 */
function report(reports: BundleReport[]) {
  const problems: string[] = [];
  let asked = 0;

  console.log(`\n${chalk.bold("── what was found ──")}`);

  for (const entry of reports) {
    const names = Object.keys(entry.results);
    const failed = names.filter((name) => entry.results[name]?.error === true);
    const skipped = names.filter((name) => entry.results[name]?.skipped === true);
    const ran = names.length - skipped.length;

    // Everything it would have asked turned out not to apply to this
    // cluster, which is not the same as everything being fine
    if (ran === 0) {
      console.log(`  ${chalk.dim("·")} ${entry.node} ${chalk.dim("·")} ${entry.bundle} ${chalk.dim("nothing to check")}`);
      continue;
    }

    asked += ran;

    const mark = failed.length > 0 ? chalk.red("✗") : chalk.green("✓");
    const detail =
      failed.length > 0
        ? chalk.red(`${failed.length} of ${ran}`)
        : chalk.dim(`${ran} checked`);

    console.log(`  ${mark} ${entry.node} ${chalk.dim("·")} ${entry.bundle} ${detail}`);

    for (const name of failed) {
      const result = entry.results[name];
      const why = (result?.stderr !== undefined && result.stderr !== "" ? result.stderr : "failed")
        .split("\n")[0];

      console.log(`      ${chalk.yellow(name)}: ${why}`);
      problems.push(`${entry.node} · ${entry.bundle} · ${name}`);
    }
  }

  console.log(
    problems.length === 0
      ? `\n${chalk.green(`Nothing to report. ${asked} checks, all of them happy.`)}\n`
      : `\n${chalk.red(`${problems.length} problem${problems.length === 1 ? "" : "s"}`)} out of ${asked} checks.\n`,
  );
}
