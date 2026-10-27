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

import { FAILURE, MARK_WIDTH, SUCCESS, heading, padMark } from "../util/chalk.ts";
import CloudConfig from "../util/CloudConfig.ts";
import { ALL_NODES, displayNode, getDisplayNames, resolveTarget } from "../pipeline/fleet.ts";
import {
  CommandPurpose,
  PROMPT_PURPOSES,
  READ_ONLY_PURPOSES,
} from "../cli/commands/Command.ts";
import { ConsoleReporter, StepOutcome, numberBundle } from "../pipeline/reporter.ts";
import { ExecuteOutcome, executePipeline } from "../pipeline/execute.ts";
import { Step, getRunningBundles } from "../pipeline/plan.ts";
import {
  getBundle,
  getBundleCommands,
  getBundleNames,
  getCheckableBundleNames,
} from "../cli/commands/bundles.ts";
import { COMMAND_NAME } from "../cli/name.ts";
import { quoteForShell } from "../util/shell.ts";
import { loadPlugins } from "../plugins/registry.ts";
import { INSTALL_PIPELINE } from "./install.ts";
import { printConfigurationWarnings } from "./preflight.ts";
import { layOut } from "../util/prose.ts";

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

// What every node has to get through before anything else is asked
// of it. A node that can't sudo, or can't reach the outside world,
// would otherwise fail most of what follows for that one reason, and
// the reason would be one line among fifty.
const GATE = "preflight";

/**
 * The bundles to look at, as a pipeline, with the gate first.
 *
 * Everything except the ones that take a cluster apart. Their checks
 * are real checks and they assert the opposite of what this is asking:
 * "K3s isn't running on this node" is the whole point after an
 * uninstall and is the first thing you would want to hear about during
 * a check-up. Asked for by name they run as normal, because then it is
 * a question somebody meant to put.
 *
 * @param options
 * @returns
 */
function getPipeline(options: DoctorOptions): string {
  if (options.bundle !== undefined && getBundle(options.bundle) === undefined) {
    throw new Error(
      `Couldn't find a command bundle named "${options.bundle}". The bundles that can be run are: ${getBundleNames().join(", ")}.`,
    );
  }

  // One bundle asked for by name still goes through the gate first,
  // for the same reason everything does
  const asked =
    options.bundle !== undefined ? [options.bundle] : orderForCheckup(getCheckableBundleNames());

  return [GATE, ...asked.filter((name) => name !== GATE)].join(",");
}

/**
 * The bundles in the order an install runs them, with anything an
 * install doesn't run afterwards, as they were.
 *
 * Install order because most of a cluster is built in stages — Cilium
 * on K3s, the charts on Helm — and a check-up in the same order reads
 * the same way: the first failure is the lowest broken layer, and
 * everything after it is likely to be its consequence.
 *
 * @param names
 * @returns
 */
export function orderForCheckup(names: string[]): string[] {
  const staged = INSTALL_PIPELINE.filter((name) => names.includes(name));
  return [...staged, ...names.filter((name) => !staged.includes(name))];
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
  const displayNames = getDisplayNames(config);

  // Settings that are ignored are worth hearing about even when the
  // cluster is fine, since it's fine for some other reason
  printConfigurationWarnings(config);

  const outcome = await executePipeline(config, {
    pipeline: getPipeline(options),
    nodes: names,
    what: "asked",
    heading: `\n${chalk.bold("Asking")} ${chalk.cyan(`${names.length} node${names.length === 1 ? "" : "s"}`)} ${chalk.bold("how they are")}`,
    purposes: getPurposes(options),
    gate: GATE,

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
      displayNames,
    ),
  });

  report(outcome, displayNames, {
    config,
    configPath,
    nodes: names,
    everyNode: options.node === undefined || options.node === ALL_NODES,
  });
}

/**
 * What the report needs to say how to put things right.
 *
 * - configPath: the configuration as it was given here, which is what
 *   a suggested command should be given too
 * - nodes: the nodes that were asked
 * - everyNode: whether that was all of them, so a fix needed on every
 *   one can be suggested once, for "all"
 */
export interface RemedyContext {
  config: CloudConfig;
  configPath: string;
  nodes: string[];
  everyNode: boolean;
}

/**
 * What one node had to say about one bundle.
 */
export interface Finding {
  node: string;
  bundle: string;
  ran: number;
  skipped: number;
  blocked: number;
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
function gather(outcomes: StepOutcome[], order: string[]): Finding[] {
  const findings = new Map<string, Finding>();

  for (const outcome of outcomes) {
    const key = `${outcome.node}/${outcome.bundle}`;
    const finding = findings.get(key) ?? {
      node: outcome.node,
      bundle: outcome.bundle,
      ran: 0,
      skipped: 0,
      blocked: 0,
      failures: [],
    };

    if (outcome.outcome === "skipped") {
      finding.skipped += 1;
    } else if (outcome.outcome === "blocked") {
      finding.blocked += 1;
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
      ? order.indexOf(one.bundle) - order.indexOf(other.bundle)
      : one.node.localeCompare(other.node),
  );
}

/**
 * Say what was found.
 *
 * @param outcome
 * @param displayNames what to print each node as
 * @param remedies
 */
function report(outcome: ExecuteOutcome, displayNames: Map<string, string>, remedies: RemedyContext) {
  // A doctor run is never a dry run, so there is always a summary;
  // the check is what tells the compiler so
  const order = getRunningBundles(outcome.plan);
  const findings = gather(outcome.dryRun ? [] : outcome.summary.outcomes, order);
  const problems: string[] = [];
  let asked = 0;

  // Every fix suggested, with the nodes it was suggested for, to be
  // said again together at the end
  const fixes = new Map<string, { bundles: string[]; nodes: Set<string> }>();
  const remedyFor = (failure: StepOutcome) => {
    const bundles = getRemedy(findStep(outcome.plan.steps, failure), failure, remedies.config);

    if (bundles !== undefined) {
      const fix = fixes.get(bundles.join(",")) ?? { bundles, nodes: new Set<string>() };
      fix.nodes.add(failure.node);
      fixes.set(bundles.join(","), fix);
    }

    return bundles;
  };
  const suggest = (bundles: string[] | undefined, node: string, indent: string) => {
    if (bundles !== undefined) {
      console.log(`${indent}${chalk.dim("fix:")} ${chalk.cyan(formatRemedy(bundles, node, remedies.configPath))}`);
    }
  };

  console.log(heading("What Was Found"));

  // The widest a line of the report gets before it's broken, rather
  // than left to wrap back to the edge. Wide terminals still get
  // lines short enough to read.
  const width = Math.min(process.stdout.columns ?? 100, 120);
  const say = (why: string, indent: string) => {
    for (const line of layOut(why, indent, width)) {
      console.log(line);
    }
  };

  // Anything that couldn't be asked at all comes first: a node that's
  // down is a bigger fact than anything the nodes that are up said
  for (const failure of outcome.failures) {
    console.log(`  ${FAILURE} ${displayNode(displayNames, failure.name)}`);
    say(failure.why, "      ");
    problems.push(`${failure.name}: ${failure.kind}`);
  }

  // A bundle that couldn't be planned is one nothing was asked about,
  // which is a problem in its own right, not a footnote: a run whose
  // only finding is this would otherwise call itself clean
  for (const problem of outcome.plan.problems) {
    console.log(`  ${FAILURE} ${problem.bundle}`);
    say(problem.why, "      ");
    problems.push(`${problem.bundle}: couldn't be checked`);
  }

  // A cause several checks share is said once, with everything it
  // took down listed under it. One bad API key failing five checks is
  // one problem, and five copies of its explanation bury whatever else
  // the report has to say.
  const shared = findSharedCauses(findings);

  for (const [why, where] of shared) {
    // Labelled with everywhere it happened, the way the others are
    // labelled with the one place, and said once underneath
    for (const [index, { finding, steps }] of where.entries()) {
      const bundle = numberBundle(order.indexOf(finding.bundle), finding.bundle);
      const mark = index === 0 ? FAILURE : " ".repeat(MARK_WIDTH);
      console.log(`  ${mark} ${chalk.dim(`${displayNode(displayNames, finding.node)} · ${bundle}:`)} ${chalk.yellow(steps.join(", "))}`);
    }

    say(why, "      ");

    // One fix each place it happened, said once per command. A cause
    // whose message is the remedy, like a refused API key, has none.
    const said = new Set<string>();
    for (const { finding, steps } of where) {
      for (const step of steps) {
        const failure = finding.failures.find((one) => one.step === step);
        const bundles = failure !== undefined ? remedyFor(failure) : undefined;
        const command = bundles !== undefined ? formatRemedy(bundles, finding.node, remedies.configPath) : undefined;

        if (command !== undefined && !said.has(command)) {
          said.add(command);
          suggest(bundles, finding.node, "      ");
        }
      }
    }

    problems.push(why);
  }

  let node: string | undefined;

  for (const finding of findings) {
    // Numbered as the run was, so the report and what scrolled past
    // during it agree
    const bundle = numberBundle(order.indexOf(finding.bundle), finding.bundle);

    if (finding.node !== node) {
      node = finding.node;
      console.log(`\n  ${chalk.bold(displayNode(displayNames, node))}`);
    }

    // Not asked because the node didn't get through the gate. Not
    // counted as a problem: the gate's failure already is, and it's
    // the one worth reading.
    if (finding.ran === 0 && finding.blocked > 0) {
      console.log(`    ${chalk.dim("–")} ${bundle} ${chalk.dim(`not asked, because ${GATE} failed`)}`);
      continue;
    }

    // Everything it would have asked turned out not to apply to this
    // cluster, which is not the same as everything being fine
    if (finding.ran === 0) {
      console.log(`    ${chalk.dim(padMark("·"))} ${bundle} ${chalk.dim("nothing to check")}`);
      continue;
    }

    asked += finding.ran;

    const mark = finding.failures.length > 0 ? FAILURE : SUCCESS;
    const detail =
      finding.failures.length > 0
        ? chalk.red(`${finding.failures.length} of ${finding.ran}`)
        : chalk.dim(`${finding.ran} checked`);
    const unasked = finding.blocked > 0 ? chalk.dim(`, ${finding.blocked} not asked because ${GATE} failed`) : "";

    console.log(`    ${mark} ${bundle} ${detail}${unasked}`);

    // Steps that failed for a shared reason point back at it, together
    // on one line, rather than each repeating it
    for (const [why, steps] of groupByCause(finding.failures)) {
      if (shared.has(why)) {
        console.log(`        ${chalk.yellow(steps.join(", "))}: ${chalk.dim(`↑ ${headline(why)}`)}`);
        continue;
      }

      for (const step of steps) {
        console.log(`        ${chalk.yellow(step)}`);
        say(why, "            ");
        const failure = finding.failures.find((one) => one.step === step);
        suggest(failure !== undefined ? remedyFor(failure) : undefined, finding.node, "            ");
        problems.push(`${displayNode(displayNames, finding.node)} · ${finding.bundle} · ${step}`);
      }
    }
  }

  sayFixes(fixes, order, remedies);

  console.log(
    problems.length === 0
      ? `\n${chalk.green(`Nothing to report. ${asked} checks, all of them happy.`)}\n`
      : `\n${chalk.red(`${problems.length} problem${problems.length === 1 ? "" : "s"}`)} out of ${asked} checks.\n`,
  );
}

/**
 * Every fix the report suggested, together, as the commands to run.
 *
 * In the order an install would run them, since a lower layer being
 * put right can be what puts the one above it right. A fix needed on
 * every node that was asked is one command for "all" rather than one
 * per node.
 *
 * @param fixes
 * @param order
 * @param remedies
 */
function sayFixes(
  fixes: Map<string, { bundles: string[]; nodes: Set<string> }>,
  order: string[],
  remedies: RemedyContext,
) {
  if (fixes.size === 0) {
    return;
  }

  console.log(heading("To Put It Right"));

  const sorted = [...fixes.values()].sort(
    (one, other) => order.indexOf(one.bundles.at(-1) ?? "") - order.indexOf(other.bundles.at(-1) ?? ""),
  );

  for (const { bundles, nodes } of sorted) {
    const everywhere = remedies.everyNode && nodes.size > 1 && remedies.nodes.every((node) => nodes.has(node));
    const targets = everywhere ? [ALL_NODES] : remedies.nodes.filter((node) => nodes.has(node));

    for (const node of targets) {
      console.log(`  ${chalk.cyan(formatRemedy(bundles, node, remedies.configPath))}`);
    }
  }

  if (sorted.some(({ bundles }) => isDestructive(bundles))) {
    console.log(
      chalk.dim("  The ones with --dry-run can destroy what's there. Read what they would do, then run them without it."),
    );
  }
}

/**
 * The step a failure came from.
 *
 * @param steps
 * @param failure
 * @returns
 */
function findStep(steps: Step[], failure: StepOutcome): Step | undefined {
  return steps.find((step) => step.bundle === failure.bundle && step.command.name === failure.step);
}

/**
 * The bundles that would put a failed check right, when there's
 * something to run.
 *
 * The check's own "remedy" when it has one. Otherwise its own bundle,
 * which is idempotent and exists to make true what its checks look for,
 * but only when that bundle changes anything: re-running one that only
 * looks would find the same thing again. Nothing when the failure is a
 * known one the check explained, such as a refused API key, because the
 * explanation is the remedy and no bundle will do it.
 *
 * @param step
 * @param failure
 * @param config
 * @returns
 */
export function getRemedy(step: Step | undefined, failure: StepOutcome, config: CloudConfig): string[] | undefined {
  if (step === undefined || step.command.remedy === false) {
    return undefined;
  }

  const explained = "explainStatus" in step.command ? step.command.explainStatus : undefined;
  if (explained !== undefined && Object.values(explained).some((text) => failure.why?.includes(text) === true)) {
    return undefined;
  }

  if (step.command.remedy !== undefined) {
    return step.command.remedy;
  }

  return changesAnything(failure.bundle, config) ? [failure.bundle] : undefined;
}

/**
 * Whether a bundle has anything in it besides looking.
 *
 * @param name
 * @param config
 * @returns
 */
function changesAnything(name: string, config: CloudConfig): boolean {
  const bundle = getBundle(name);

  if (bundle === undefined) {
    return false;
  }

  // A bundle built from the configuration can refuse to be built from
  // it, which the run will already have said; it just has no fix here
  try {
    return getBundleCommands(bundle, config).some(
      (command) => command.purpose === undefined || command.purpose === CommandPurpose.Apply,
    );
  } catch {
    return false;
  }
}

/**
 * Whether any of these bundles can destroy something that's there.
 *
 * @param bundles
 * @returns
 */
function isDestructive(bundles: string[]): boolean {
  return bundles.some((name) => getBundle(name)?.destructive === true);
}

/**
 * The command that runs a fix, as somebody would type it.
 *
 * With --dry-run when it could destroy something, so the first thing
 * typed shows what it would do rather than doing it.
 *
 * @param bundles
 * @param node
 * @param configPath
 * @returns
 */
export function formatRemedy(bundles: string[], node: string, configPath: string): string {
  return [
    COMMAND_NAME,
    bundles.length === 1 ? "run-bundle" : "run-pipeline",
    bundles.join(","),
    asShellWord(node),
    asShellWord(configPath),
    ...(isDestructive(bundles) ? ["--dry-run"] : []),
  ].join(" ");
}

/**
 * A word for the shell, quoted only when it has to be, so the usual
 * case reads as it would be typed.
 *
 * @param word
 * @returns
 */
function asShellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : quoteForShell(word);
}

// What a failure says when it didn't say anything. Never treated as a
// shared cause: two checks failing silently haven't failed for the
// same reason, they've both declined to give one.
const UNEXPLAINED = "failed";

/**
 * The first line of why a step failed, which is the part that's
 * printed and the part failures are matched on.
 *
 * @param failure
 * @returns
 */
function explain(failure: StepOutcome): string {
  return (failure.why !== undefined && failure.why !== "" ? failure.why : UNEXPLAINED).split("\n")[0] ?? UNEXPLAINED;
}

/**
 * A bundle's failures, with the steps that failed for the same reason
 * together, in the order they ran.
 *
 * @param failures
 * @returns
 */
function groupByCause(failures: StepOutcome[]): Map<string, string[]> {
  const causes = new Map<string, string[]>();

  for (const failure of failures) {
    const why = explain(failure);
    causes.set(why, [...(causes.get(why) ?? []), failure.step]);
  }

  return causes;
}

/**
 * The reasons more than one check failed for, each with where.
 *
 * Matched on the exact text. Commands that fail for one underlying
 * reason say so in the same words — that's what an explanation keyed
 * on a status code is — and anything looser would risk folding two
 * different problems that happen to read alike into one.
 *
 * @param findings
 * @returns
 */
export function findSharedCauses(
  findings: Finding[],
): Map<string, { finding: Finding; steps: string[] }[]> {
  const causes = new Map<string, { finding: Finding; steps: string[] }[]>();

  for (const finding of findings) {
    for (const [why, steps] of groupByCause(finding.failures)) {
      if (why !== UNEXPLAINED) {
        causes.set(why, [...(causes.get(why) ?? []), { finding, steps }]);
      }
    }
  }

  return new Map(
    [...causes].filter(([, where]) => where.reduce((total, { steps }) => total + steps.length, 0) > 1),
  );
}

/**
 * Enough of a reason to recognise it by: up to the first colon or full
 * stop, which is where these messages turn from what happened to why.
 *
 * @param why
 * @returns
 */
export function headline(why: string): string {
  const first = why.split(/[:.](?:\s|$)/)[0] ?? why;
  return first.length > 72 ? `${first.slice(0, 71)}…` : first;
}
