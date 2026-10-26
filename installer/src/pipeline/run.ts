/**
 * @file
 * Running a plan across a whole cluster.
 *
 * The rule the whole thing is built on: every node finishes a step
 * before any node starts the next one. Within a step the nodes work at
 * once — installing K3s on six agents should take as long as installing
 * it on one — and at the end of the step they wait for each other.
 *
 * That barrier is the point. Without it, a failure on one node leaves
 * the cluster smeared across the install: one machine has storage set
 * up and Cilium running, another is three steps behind with half a
 * package list. With it, a failure means every node is at the same
 * place, which is a state somebody can look at, reason about, and
 * resume from.
 *
 * It costs something — a step is as slow as its slowest node — and
 * that is the right trade for an installer. Being able to say "every
 * machine got as far as here" is worth more than finishing sooner.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

import { CommandBundle } from "../cli/commands/CommandBundle.ts";
import CloudConfig from "../util/CloudConfig.ts";
import { CommandScope, CommandTarget } from "../cli/commands/Command.ts";
import { Fleet, FleetMember } from "./fleet.ts";
import { Plan, Step, getRunningBundles } from "./plan.ts";
import { Outcome, Reporter, RunSummary, SilentReporter, StepOutcome } from "./reporter.ts";

/**
 * How a run should behave.
 *
 * - keepGoing: carry on past a failed step. Off by default and worth
 *   being sure about — the steps after it were written for a cluster
 *   that got through this one.
 */
export interface RunOptions {
  keepGoing?: boolean;
  reporter?: Reporter;

  // What every node should know before anything runs. The doctor
  // tells the commands not to wait for anything this way, since
  // nothing it does has just changed and so nothing has to settle.
  context?: Record<string, unknown>;

  // Let commands narrate as they go, on top of the step reporting.
  // Off by default: a command explaining what it found is useful when
  // one is being watched and unreadable when six nodes do it at once.
  verbose?: boolean;

  // A bundle a node has to get through before anything else is asked
  // of it. For the doctor and preflight: a node that can't sudo, or
  // can't reach anything, fails every check after it for the same
  // reason, and fifty failures with one cause bury the cause. An
  // install doesn't need it, since it stops at the first failure
  // anyway.
  gate?: string;
}

/**
 * Which node the code running now is on behalf of.
 *
 * Commands say things with console.log — a warning about swap, who
 * the connection is as — from inside steps running on several nodes
 * at once. Nothing passes the node down to them, and nothing should
 * have to, so it's carried alongside instead, and the console is
 * pointed at the reporter while a plan runs. What they say then comes
 * out labelled with its node and in between the reporter's own lines,
 * rather than written over the top of its progress bar.
 */
const speaker = new AsyncLocalStorage<string>();

// The console methods pointed at the reporter during a run
const CAPTURED = ["log", "info", "warn", "error"] as const;

/**
 * Send what's said on the console to the reporter until the returned
 * function is called.
 *
 * Only what's said on behalf of a node. Anything else during a run is
 * left as it was, since there's no node to label it with.
 *
 * @param reporter
 * @returns a function that puts the console back
 */
function captureConsole(reporter: Reporter): () => void {
  const originals = CAPTURED.map((method) => [method, console[method]] as const);

  for (const [method, original] of originals) {
    console[method] = (...args: unknown[]) => {
      const node = speaker.getStore();

      if (node === undefined) {
        original.apply(console, args);
        return;
      }

      reporter.nodeSaid(node, format(...args));
    };
  }

  return () => {
    for (const [method, original] of originals) {
      console[method] = original;
    }
  };
}

/**
 * What one node did with one step.
 */
interface StepResult {
  node: string;
  outcome: Outcome;
  why?: string;
  output?: string;
}

/**
 * What each node knows, and what the cluster knows.
 *
 * Two layers rather than one because the two have genuinely different
 * lifetimes. What a node found out about its own disks belongs to that
 * node. What a cluster-wide step found out — which device classes the
 * nodes between them serve, whether this is a Community Cloud cluster
 * at all — belongs to everybody, and a node-scoped step after it has
 * to be able to see it.
 */
class Memory {
  private cluster: Record<string, unknown>;
  private nodes = new Map<string, Record<string, unknown>>();

  /**
   * @param known what every node should start out knowing
   */
  constructor(known: Record<string, unknown> = {}) {
    this.cluster = { ...known };
  }

  // What every command returned, kept the same way. A command can read
  // what an earlier one returned rather than what it put in the
  // context — the Cilium CLI install reads the version the step before
  // it printed — and a runner that executes one command at a time has
  // to carry that forward or those commands simply break.
  private clusterResults: Record<string, any> = {};
  private nodeResults = new Map<string, Record<string, any>>();

  /**
   * What a step running for this node should see.
   *
   * @param member
   * @returns
   */
  contextFor(member: FleetMember): Record<string, unknown> {
    if (!this.nodes.has(member.name)) {
      this.nodes.set(member.name, {});
    }

    return {
      ...this.cluster,
      ...this.nodes.get(member.name),
      nodeName: member.name,
      node: member.node,
      params: [],
    };
  }

  /**
   * What earlier commands returned, as this step should see them.
   *
   * @param member
   * @returns
   */
  resultsFor(member: FleetMember): Record<string, any> {
    return { ...this.clusterResults, ...this.nodeResults.get(member.name) };
  }

  /**
   * Keep what a step learned, where whoever needs it will find it.
   *
   * @param step
   * @param member
   * @param context the context after the command ran
   * @param results what the command returned
   */
  remember(
    step: Step,
    member: FleetMember,
    context: Record<string, unknown>,
    results: Record<string, any>,
  ) {
    // The fields the runner puts in are its own, not the command's
    const { nodeName, node, params, ...learned } = context;

    if (step.scope === CommandScope.Cluster) {
      Object.assign(this.cluster, learned);
      Object.assign(this.clusterResults, results);
      return;
    }

    this.nodes.set(member.name, { ...this.nodes.get(member.name), ...learned });
    this.nodeResults.set(member.name, { ...this.nodeResults.get(member.name), ...results });
  }
}

/**
 * Run a plan.
 *
 * @param config
 * @param plan
 * @param fleet
 * @param options
 * @returns what happened
 */
export async function runPlan(
  config: CloudConfig,
  plan: Plan,
  fleet: Fleet,
  options: RunOptions = {},
): Promise<RunSummary> {
  const reporter = options.reporter ?? new SilentReporter();
  const memory = new Memory(options.context);
  const started = Date.now();

  const failures: RunSummary["failures"] = [];
  const outcomes: StepOutcome[] = [];
  let completed = 0;
  let bundle: string | undefined;

  // Nodes that didn't get through the gate
  const blocked = new Set<string>();

  reporter.planned(plan.nodes, plan.steps.length, getRunningBundles(plan));
  const restoreConsole = captureConsole(reporter);

  try {
    for (const [index, step] of plan.steps.entries()) {
      if (step.bundle !== bundle) {
        bundle = step.bundle;
        reporter.bundleStarted(bundle, step.bundleDescription);
      }

      const gated = options.gate !== undefined && step.bundle === options.gate;

      // Every node at once. allSettled rather than all: a node that
      // throws shouldn't stop the others being waited for, because the
      // whole point is that they finish together.
      const results = await Promise.all(
        step.nodes.map((name) => {
          const why = gated ? undefined : whyBlocked(step, name, fleet, blocked, options.gate);

          return why !== undefined
            ? Promise.resolve<StepResult>({ node: name, outcome: "blocked", why })
            : runStepForNode(config, step, fleet, name, memory, reporter, options);
        }),
      );

      if (gated) {
        for (const result of results) {
          if (result.outcome === "failed" && !blocked.has(result.node)) {
            blocked.add(result.node);
            reporter.nodeSaid(
              result.node,
              `Nothing else will be asked of this node until ${options.gate} passes`,
            );
          }
        }
      }

      completed += 1;
      reporter.stepFinished(step.command.name, index, plan.steps.length);

      for (const result of results) {
        outcomes.push({
          bundle: step.bundle,
          step: step.command.name,
          node: result.node,
          outcome: result.outcome,
          ...(result.why !== undefined ? { why: result.why } : {}),
        });
      }

      const failed = results.filter((result) => result.outcome === "failed");

      for (const result of failed) {
        failures.push({
          step: step.command.name,
          node: result.node,
          why: result.why ?? "no reason given",
        });
      }

      // The barrier. Everything above has finished on every node, so
      // this is the one place where stopping leaves the cluster
      // somewhere describable.
      if (failed.length > 0 && options.keepGoing !== true) {
        break;
      }
    }
  } finally {
    restoreConsole();
  }

  const summary: RunSummary = {
    completed,
    total: plan.steps.length,
    failures,
    elapsedMs: Date.now() - started,
    outcomes,
  };

  reporter.finished(summary);

  return summary;
}

/**
 * Why a step won't be run for a node, when it won't.
 *
 * The node itself not having got through the gate is the obvious
 * case. The other is a step run from the control plane — kubectl,
 * helm — when the control plane is the one that didn't: whichever
 * node it's on behalf of, it would run somewhere already known to be
 * broken.
 *
 * @param step
 * @param name the node the step would run for
 * @param fleet
 * @param blocked the nodes that didn't get through
 * @param gate
 * @returns
 */
function whyBlocked(
  step: Step,
  name: string,
  fleet: Fleet,
  blocked: Set<string>,
  gate: string | undefined,
): string | undefined {
  if (blocked.has(name)) {
    return `${gate} failed on ${name}, so this wasn't asked`;
  }

  if (step.runOn === CommandTarget.ControlPlane && blocked.size > 0) {
    const controlPlane = fleet.controlPlane().name;

    if (blocked.has(controlPlane)) {
      return `${gate} failed on ${controlPlane}, which this runs from, so this wasn't asked`;
    }
  }

  return undefined;
}

/**
 * Run one step on behalf of one node.
 *
 * The command is wrapped in a bundle of its own rather than run
 * directly, so that everything a bundle already does — deciding
 * whether there is anything to do, shaping an error into a result,
 * parsing output, passing values on — happens here exactly as it does
 * anywhere else.
 *
 * @param config
 * @param step
 * @param fleet
 * @param name the node this runs for
 * @param memory
 * @param reporter
 * @returns
 */
async function runStepForNode(
  config: CloudConfig,
  step: Step,
  fleet: Fleet,
  name: string,
  memory: Memory,
  reporter: Reporter,
  options: RunOptions = {},
): Promise<StepResult> {
  const member = fleet.get(name);

  if (member === undefined) {
    return { node: name, outcome: "failed", why: `${name} isn't in the fleet` };
  }

  reporter.nodeStarted(step.command.name, name);

  const context = memory.contextFor(member);
  const bundle = new CommandBundle(config, [step.command], context)
    .setQuiet(options.verbose !== true)
    .setResults(memory.resultsFor(member));

  // Where the shell runs is a separate question from which node the
  // step is for. Labelling a node is kubectl on a server, about a
  // machine that may be somewhere else entirely.
  bundle.setExec(member.connection.exec);
  bundle.setControlPlaneExec(fleet.controlPlane().connection.exec);

  try {
    await speaker.run(name, () => bundle.runAllCommands());
  } catch (error: any) {
    reporter.nodeFinished(step.command.name, name, "failed");
    reporter.nodeSaid(name, error.message);

    return { node: name, outcome: "failed", why: error.message };
  }

  memory.remember(step, member, bundle.getContext(), bundle.getResults());

  const result = bundle.getResults()[step.command.name];

  if (result === undefined) {
    // Filtered out before it ran — a purpose this run didn't want
    return { node: name, outcome: "skipped" };
  }

  if (result.skipped === true) {
    reporter.nodeFinished(step.command.name, name, "skipped");
    return { node: name, outcome: "skipped" };
  }

  if (bundle.hasFailed()) {
    const why = result.stderr !== "" ? result.stderr : "the command failed without saying why";
    reporter.nodeFinished(step.command.name, name, "failed");
    reporter.nodeSaid(name, why);

    return { node: name, outcome: "failed", why };
  }

  reporter.nodeFinished(step.command.name, name, "ok");

  return { node: name, outcome: "ok" };
}
