/**
 * @file
 * Running bundles against nodes, wherever the asking came from.
 *
 * Installing a cluster, running one bundle, adding a node and asking
 * the doctor for a report are four commands with four different things
 * to say and one shared middle: work out the steps, connect to the
 * machines, run the steps in lock step, close the connections. That
 * middle lives here.
 *
 * Keeping it in one place is not tidiness. The barrier between steps,
 * the refusal to start when two nodes turn out to be one machine, the
 * results carried from one command to the next — those are the parts
 * that were hard to get right, and a second copy of this loop written
 * for one command would be a second copy that has none of them.
 *
 * What differs between the callers is genuinely small and all of it is
 * an option here: which commands to include, whether an unreachable
 * node is fatal, and what to say at the end.
 */
import chalk from "chalk";

import CloudConfig from "../util/CloudConfig.ts";
import {
  CommandPurpose,
  CommandTarget,
  PROMPT_PURPOSES,
} from "../cli/commands/Command.ts";
import {
  Fleet,
  FleetFailure,
  describeFleetFailures,
  paperFleet,
  raiseFleet,
} from "./fleet.ts";
import { Plan, buildPlan, resolvePipeline } from "./plan.ts";
import { ConsoleReporter, Reporter, RunSummary } from "./reporter.ts";
import { runPlan } from "./run.ts";

/**
 * What to run, where, and how to behave while doing it.
 *
 * - pipeline: a comma separated list of bundles, or a pipeline named
 *   in the configuration
 * - nodes: the nodes this is on behalf of
 * - what: the word for what didn't happen, when nothing could be
 *   started — "installed", "run", "added"
 * - purposes: only run commands for these, which is how the same
 *   pipeline both builds a cluster and asks after one
 * - partial / tolerant: carry on past an unreachable node or a bundle
 *   that won't build. For the read-only commands, where a partial
 *   answer beats none.
 * - verify: when everything passed, ask the same pipeline's checks
 *   again. A step can pass and then be undone by a later one, and the
 *   end of an install is the moment that matters.
 */
export interface ExecuteOptions {
  pipeline: string;
  nodes: string[];
  what?: string;
  heading?: string;
  keepGoing?: boolean;
  dryRun?: boolean;
  timeout?: string | number;
  purposes?: CommandPurpose[];
  context?: Record<string, unknown>;
  partial?: boolean;
  tolerant?: boolean;
  verbose?: boolean;
  verify?: boolean;
  reporter?: Reporter;
  showSummary?: boolean;
}

/**
 * What happened.
 *
 * Two shapes rather than one with optional fields, because a dry run
 * genuinely has no summary — nothing ran. Checking "dryRun" is what
 * gives a caller the summary, so the one thing it must not forget to
 * do is the thing that lets it carry on.
 */
export type ExecuteOutcome = DryRunOutcome | RunOutcome;

export interface DryRunOutcome {
  dryRun: true;
  plan: Plan;
  failures: FleetFailure[];
}

export interface RunOutcome {
  dryRun: false;
  plan: Plan;
  summary: RunSummary;

  // Present when the run asked for verification and got far enough to
  // do it
  verification?: RunSummary;

  // Nodes that couldn't be reached, when the run was allowed to carry
  // on without them
  failures: FleetFailure[];
}

/**
 * Run a pipeline.
 *
 * @param config
 * @param options
 * @returns what happened, for the caller to report on
 */
export async function executePipeline(
  config: CloudConfig,
  options: ExecuteOptions,
): Promise<ExecuteOutcome> {
  const what = options.what ?? "run";

  // Checked before anything is connected to, so a pipeline with a
  // misspelled bundle at the end of it fails now rather than twenty
  // minutes in with half a cluster built
  resolvePipeline(config, options.pipeline);

  // The whole plan, worked out with nothing connected. It answers the
  // dry run outright, and it answers a question the real run needs
  // asked first: whether any of this has to talk to the cluster, and
  // so whether a server has to be reachable even when none was asked
  // for.
  const paper = planFor(config, paperFleet(config, options.nodes), options);

  if (options.dryRun === true) {
    return { dryRun: true, plan: paper, failures: [] };
  }

  if (options.heading !== undefined) {
    console.log(options.heading);
  }

  const { fleet, failures } = await raiseFleet(config, options.nodes, {
    timeout: options.timeout !== undefined ? Number(options.timeout) : undefined,
    controlPlane: needsControlPlane(paper),
    partial: options.partial,
  });

  if (fleet.members.length === 0) {
    throw new Error(describeFleetFailures(failures, options.nodes, what));
  }

  const reporter =
    options.reporter ??
    new ConsoleReporter(process.stdout, undefined, options.showSummary !== false);

  try {
    const plan = planFor(config, fleet, options);

    const summary = await runPlan(config, plan, fleet, {
      keepGoing: options.keepGoing,
      context: options.context,
      verbose: options.verbose,
      reporter,
    });

    const verification =
      options.verify === true && summary.failures.length === 0
        ? await verify(config, fleet, options, reporter)
        : undefined;

    return {
      dryRun: false,
      plan,
      summary,
      ...(verification !== undefined ? { verification } : {}),
      failures,
    };
  } finally {
    await fleet.disconnect();
  }
}

/**
 * Ask the pipeline's own checks whether what just happened worked.
 *
 * Only the checks that assert something and answer without waiting:
 * this runs after everything succeeded, so whatever needed to settle
 * already has.
 *
 * @param config
 * @param fleet
 * @param options
 * @param reporter
 * @returns
 */
async function verify(
  config: CloudConfig,
  fleet: Fleet,
  options: ExecuteOptions,
  reporter: Reporter,
): Promise<RunSummary> {
  console.log(chalk.bold("\nChecking the cluster works\n"));

  const checks = buildPlan(config, options.pipeline, fleet, {
    purposes: PROMPT_PURPOSES,
    tolerant: options.tolerant,
  });

  return runPlan(config, checks, fleet, {
    keepGoing: true,
    context: options.context,
    verbose: options.verbose,
    reporter,
  });
}

/**
 * The plan for a fleet, built the way these options ask for.
 *
 * @param config
 * @param fleet
 * @param options
 * @returns
 */
function planFor(config: CloudConfig, fleet: Fleet, options: ExecuteOptions): Plan {
  return buildPlan(config, options.pipeline, fleet, {
    ...(options.purposes !== undefined ? { purposes: options.purposes } : {}),
    ...(options.tolerant !== undefined ? { tolerant: options.tolerant } : {}),
  });
}

/**
 * Whether anything in a plan has to talk to the cluster.
 *
 * Asked so that running a bundle against a single agent opens a
 * connection to a server when it needs one, and doesn't when it
 * doesn't. Installing packages on one node shouldn't require a working
 * control plane.
 *
 * @param plan
 * @returns
 */
function needsControlPlane(plan: Plan): boolean {
  return plan.steps.some((step) => step.runOn === CommandTarget.ControlPlane);
}

/**
 * How far a run got, in words.
 *
 * Two different things can have happened and they want saying
 * differently. A run that stopped is sitting at a barrier with every
 * node in the same place, which is the thing somebody needs to know to
 * decide what to do next. A run told to keep going reached the end and
 * has failures scattered through it, and telling somebody it "stopped
 * after 10 of 10 steps" is just wrong.
 *
 * @param summary
 * @returns
 */
export function describeStop(summary: RunSummary): string {
  const failed = summary.failures.length;

  if (summary.completed < summary.total) {
    return `stopped after ${summary.completed} of ${summary.total} steps. Every node is at the same step, so things are where the report above says they are`;
  }

  return `ran every one of its ${summary.total} steps and ${failed} of them failed`;
}

/**
 * Print what would run, without running it.
 *
 * @param plan
 */
export function printPlan(plan: Plan) {
  console.log(
    `\n${chalk.bold(`${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}`)} across ${chalk.bold(`${plan.nodes.length} node${plan.nodes.length === 1 ? "" : "s"}`)}, and nothing run\n`,
  );

  let bundle: string | undefined;

  for (const [index, step] of plan.steps.entries()) {
    if (step.bundle !== bundle) {
      bundle = step.bundle;
      console.log(chalk.bold.underline(bundle));
    }

    console.log(
      `  ${chalk.dim(String(index + 1).padStart(3))}  ${step.command.name.padEnd(36)} ${chalk.dim(step.nodes.join(", "))}`,
    );
  }

  for (const problem of plan.problems) {
    console.log(`  ${chalk.yellow(problem.bundle)}: ${chalk.dim(problem.why)}`);
  }

  console.log();
}
