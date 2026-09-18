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
 * they're for, and only the purposes that change nothing are asked
 * for here, which is what makes this safe to point at a cluster people
 * depend on.
 *
 * It runs on the same machinery as an install, which is the part worth
 * insisting on. The doctor's job is to say where a whole cluster is,
 * and a cluster is several machines: asking them one after another
 * means the report is a description of six different moments, and the
 * first slow node delays every answer behind it. Every node is asked
 * the same question at the same time, and the step doesn't move on
 * until they have all answered — the same barrier an install uses, for
 * the same reason.
 *
 * Two things are relaxed, because the questions are read-only. A node
 * that can't be reached doesn't stop the others being asked: a cluster
 * with a machine down is exactly the case somebody runs this for. And
 * one failure doesn't stop the run, because one thing being broken is
 * the most likely reason to want to know what else is.
 */
import chalk from "chalk";

import CloudConfig from "../util/CloudConfig.ts";
import { ALL_NODES, resolveTarget } from "../pipeline/fleet.ts";
import {
  CommandPurpose,
  PROMPT_PURPOSES,
  READ_ONLY_PURPOSES,
} from "../cli/commands/Command.ts";
import { ConsoleReporter, StepOutcome } from "../pipeline/reporter.ts";
import { ExecuteOutcome, executePipeline } from "../pipeline/execute.ts";
import { getBundle, getBundleNames } from "../cli/commands/bundles.ts";
import { loadPlugins } from "../plugins/registry.ts";

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
 * The bundles to look at, as a pipeline.
 *
 * @param options
 * @returns
 */
function getPipeline(options: DoctorOptions): string {
  if (options.bundle === undefined) {
    return getBundleNames().join(",");
  }

  if (getBundle(options.bundle) === undefined) {
    throw new Error(
      `Couldn't find a command bundle named "${options.bundle}". The bundles that can be run are: ${getBundleNames().join(", ")}.`,
    );
  }

  return options.bundle;
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
  loadPlugins(config);

  const names = resolveTarget(config, options.node ?? ALL_NODES);

  const outcome = await executePipeline(config, {
    pipeline: getPipeline(options),
    nodes: names,
    what: "asked",
    heading: `\n${chalk.bold("Asking")} ${chalk.cyan(`${names.length} node${names.length === 1 ? "" : "s"}`)} ${chalk.bold("how they are")}`,
    purposes: getPurposes(options),

    // Nothing here just changed anything, so there's nothing to wait
    // for. The waits inside these commands exist to ride out the gap
    // after an install, and on a node with a real problem they would
    // make this sit through every timeout in turn before saying so.
    context: { noWaiting: options.wait !== true },

    // A broken cluster is the reason to be running this, so neither a
    // node that's down nor a bundle that won't build is allowed to
    // cost you the rest of the report
    partial: true,
    tolerant: true,
    keepGoing: true,
    verbose: options.verbose,

    // The report below is the summary, so the runner shouldn't print
    // one saying the run "stopped" — it didn't, it finished and found
    // something
    reporter: new ConsoleReporter(
      process.stdout,
      options.verbose === true ? false : undefined,
      false,
    ),
  });

  report(outcome);
}

/**
 * What one node had to say about one bundle.
 */
interface Finding {
  node: string;
  bundle: string;
  ran: number;
  skipped: number;
  failures: StepOutcome[];
}

/**
 * Gather the outcomes into something worth printing.
 *
 * Grouped by node and then by bundle, which is the shape of the
 * question people actually ask — "what's wrong with that machine" —
 * rather than the order the steps happened to run in.
 *
 * @param outcomes
 * @returns
 */
function gather(outcomes: StepOutcome[]): Finding[] {
  const findings = new Map<string, Finding>();

  for (const outcome of outcomes) {
    const key = `${outcome.node}/${outcome.bundle}`;
    const finding = findings.get(key) ?? {
      node: outcome.node,
      bundle: outcome.bundle,
      ran: 0,
      skipped: 0,
      failures: [],
    };

    if (outcome.outcome === "skipped") {
      finding.skipped += 1;
    } else {
      finding.ran += 1;
    }

    if (outcome.outcome === "failed") {
      finding.failures.push(outcome);
    }

    findings.set(key, finding);
  }

  return [...findings.values()].sort((one, other) =>
    one.node === other.node
      ? one.bundle.localeCompare(other.bundle)
      : one.node.localeCompare(other.node),
  );
}

/**
 * Say what was found.
 *
 * @param outcome
 */
function report(outcome: ExecuteOutcome) {
  // A doctor run is never a dry run, so there is always a summary;
  // the check is what tells the compiler so
  const findings = gather(outcome.dryRun ? [] : outcome.summary.outcomes);
  const problems: string[] = [];
  let asked = 0;

  console.log(`\n${chalk.bold("── what was found ──")}`);

  // Anything that couldn't be asked at all comes first: a node that's
  // down is a bigger fact than anything the nodes that are up said
  for (const failure of outcome.failures) {
    console.log(`  ${chalk.red("✗")} ${failure.name} ${chalk.dim("·")} ${failure.why}`);
    problems.push(`${failure.name}: ${failure.kind}`);
  }

  for (const problem of outcome.plan.problems) {
    console.log(
      `  ${chalk.yellow("!")} ${problem.bundle} ${chalk.dim("·")} ${chalk.dim(problem.why)}`,
    );
  }

  let node: string | undefined;

  for (const finding of findings) {
    if (finding.node !== node) {
      node = finding.node;
      console.log(`\n  ${chalk.bold(node)}`);
    }

    // Everything it would have asked turned out not to apply to this
    // cluster, which is not the same as everything being fine
    if (finding.ran === 0) {
      console.log(`    ${chalk.dim("·")} ${finding.bundle} ${chalk.dim("nothing to check")}`);
      continue;
    }

    asked += finding.ran;

    const mark = finding.failures.length > 0 ? chalk.red("✗") : chalk.green("✓");
    const detail =
      finding.failures.length > 0
        ? chalk.red(`${finding.failures.length} of ${finding.ran}`)
        : chalk.dim(`${finding.ran} checked`);

    console.log(`    ${mark} ${finding.bundle} ${detail}`);

    for (const failure of finding.failures) {
      const why = (failure.why !== undefined && failure.why !== "" ? failure.why : "failed")
        .split("\n")[0];

      console.log(`        ${chalk.yellow(failure.step)}: ${why}`);
      problems.push(`${finding.node} · ${finding.bundle} · ${failure.step}`);
    }
  }

  console.log(
    problems.length === 0
      ? `\n${chalk.green(`Nothing to report. ${asked} checks, all of them happy.`)}\n`
      : `\n${chalk.red(`${problems.length} problem${problems.length === 1 ? "" : "s"}`)} out of ${asked} checks.\n`,
  );
}
