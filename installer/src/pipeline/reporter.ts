/**
 * @file
 * Saying what is happening, while several nodes do it at once.
 *
 * Parallel work is hard to read. Five machines printing into one
 * terminal produces something nobody can follow, so every line here is
 * labelled with the node it came from and given that node's colour,
 * and the progress bar stays pinned at the bottom rather than
 * scrolling away.
 *
 * Reporting is an interface rather than a pile of console.log calls
 * because the runner should be testable without reading its output,
 * and because a terminal that isn't a terminal — a log file, CI —
 * wants plain lines rather than something redrawing itself.
 */
import chalk from "chalk";

import { layOut } from "../util/prose.ts";

/**
 * What the runner tells whoever is watching.
 */
export interface Reporter {
  // The whole run, before anything happens. The bundles are the ones
  // with something to run, in the order they'll run.
  planned(nodes: string[], steps: number, bundles: string[]): void;

  // A new bundle's steps are starting
  bundleStarted(bundle: string, description: string): void;

  // One step, on one node
  nodeStarted(step: string, node: string): void;
  nodeFinished(step: string, node: string, outcome: Outcome): void;

  // Something a command wanted to say
  nodeSaid(node: string, message: string): void;

  // A step is done on every node it applies to
  stepFinished(step: string, index: number, total: number): void;

  // The run is over
  finished(summary: RunSummary): void;
}

/**
 * How one node got on with one step.
 */
//
// "blocked" is a step that wasn't run for a node because the node
// didn't get through a gate before it — see RunOptions.gate. Not a
// failure of its own: the failure is the gate's.
export type Outcome = "ok" | "skipped" | "failed" | "blocked";

/**
 * What happened overall.
 */
export interface RunSummary {
  completed: number;
  total: number;
  failures: { step: string; node: string; why: string }[];
  elapsedMs: number;

  // Every step, on every node, and how it went. The progress report
  // is written as it happens and is gone as soon as it scrolls; this
  // is what's left to group, count and summarise afterwards, which is
  // how the doctor turns a run into a report.
  outcomes: StepOutcome[];
}

/**
 * One step, on one node, and what came of it.
 */
export interface StepOutcome {
  bundle: string;
  step: string;
  node: string;
  outcome: Outcome;
  why?: string;
}

// The colours nodes are given, in order. Chosen to stay apart from one
// another and from the red a failure uses.
const NODE_COLOURS = ["cyan", "magenta", "yellow", "blue", "green", "white"] as const;

const MARKS: Record<Outcome, string> = {
  ok: "✓",
  skipped: "·",
  failed: "✗",
  blocked: "–",
};

/**
 * Cut a line to a width, counting what is printed rather than what is
 * written: colour is escape codes, which take up no room on screen.
 *
 * @param text
 * @param width
 * @returns
 */
function truncate(text: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/\u001b\[[0-9;]*m/g, "").length;

  if (visible <= width) {
    return text;
  }

  // Cutting inside an escape sequence would leave the terminal coloured
  // from here on, so the colour is reset at the end whatever happened
  let kept = "";
  let seen = 0;
  let index = 0;

  while (index < text.length && seen < width) {
    const escape = /^\u001b\[[0-9;]*m/.exec(text.slice(index));

    if (escape !== null) {
      kept += escape[0];
      index += escape[0].length;
      continue;
    }

    kept += text[index];
    seen += 1;
    index += 1;
  }

  return `${kept}\u001b[0m`;
}

/**
 * A bundle with its place in the run, counting from one.
 *
 * @param index where it comes, counting from zero
 * @param bundle
 * @returns
 */
export function numberBundle(index: number, bundle: string): string {
  return `${index + 1}. ${bundle}`;
}

/**
 * A reporter that says nothing. For tests, and for anything rendering
 * its own output.
 */
export class SilentReporter implements Reporter {
  planned() {}
  bundleStarted() {}
  nodeStarted() {}
  nodeFinished() {}
  nodeSaid(_node: string, _message: string) {}
  stepFinished() {}
  finished() {}
}

/**
 * A reporter that writes to a terminal.
 */
export class ConsoleReporter implements Reporter {
  private colours = new Map<string, (text: string) => string>();
  private width = 0;
  private done = 0;
  private total = 0;
  private current = "";
  private bar = false;
  private bundles: string[] = [];

  // What each node has said during the step it's on, held until the
  // step's own line is written so the output reads under its label
  // rather than above it. Nodes run side by side, so this also keeps
  // one node's lines together instead of shuffled in with another's.
  private held = new Map<string, string[]>();

  /**
   * @param stream where to write, so this can be pointed somewhere else
   * @param interactive whether to draw a progress bar that redraws
   *   itself. Off when the output isn't a terminal, since a log full
   *   of escape codes helps nobody.
   * @param summary whether to say how it went at the end. Off for
   *   anything printing its own report afterwards: a run of checks
   *   that finds three problems has not "stopped after 40 of 61
   *   steps", it has finished and found three problems.
   * @param displayNames what to print each node as, where it isn't its
   *   name. See getDisplayNames.
   */
  constructor(
    private stream: NodeJS.WriteStream = process.stdout,
    private interactive: boolean = process.stdout.isTTY === true,
    private summary: boolean = true,
    private displayNames: Map<string, string> = new Map(),
  ) {}

  planned(nodes: string[], steps: number, bundles: string[]) {
    this.total = steps;
    this.bundles = bundles;
    this.width = Math.max(...nodes.map((name) => this.display(name).length), 4);

    for (const [index, name] of nodes.entries()) {
      const colour = NODE_COLOURS[index % NODE_COLOURS.length]!;
      this.colours.set(name, (text: string) => (chalk as any)[colour](text));
    }

    this.write(
      `\n${chalk.bold(`${nodes.length} node${nodes.length === 1 ? "" : "s"}`)}  ${chalk.dim("·")}  ${chalk.bold(`${steps} step${steps === 1 ? "" : "s"}`)}\n`,
    );
    this.write(`${chalk.dim(nodes.map((name) => this.label(name)).join("  "))}\n`);
    this.write(
      `${chalk.dim(bundles.map((bundle, index) => numberBundle(index, bundle)).join(" → "))}\n\n`,
    );
  }

  bundleStarted(bundle: string, description: string) {
    this.clearBar();
    // Numbered in the order they run, since a lot of what's here
    // depends on what came before it, and the order is worth seeing
    const index = this.bundles.indexOf(bundle);
    const number = index >= 0 ? `${chalk.dim(`${index + 1}.`)} ` : "";

    this.write(`${number}${chalk.bold.underline(bundle)} ${chalk.dim(description)}\n`);
    this.drawBar();
  }

  nodeStarted(step: string, node: string) {
    // Anything left from a step that ended without saying how — it was
    // filtered out, say — goes out now rather than under this one
    this.release(node);
    this.held.set(node, []);
    this.current = `${this.display(node)} · ${step}`;
    this.drawBar();
  }

  nodeFinished(step: string, node: string, outcome: Outcome) {
    const mark =
      outcome === "failed"
        ? chalk.red(MARKS[outcome])
        : outcome === "skipped"
          ? chalk.dim(MARKS[outcome])
          : chalk.green(MARKS[outcome]);

    const name = outcome === "skipped" ? chalk.dim(step) : step;

    this.line(`${this.label(node)} ${mark} ${name}`);
    this.release(node);
  }

  nodeSaid(node: string, message: string) {
    const lines = message
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => `${this.label(node)} ${chalk.dim("│")} ${line}`);
    const held = this.held.get(node);

    if (held !== undefined) {
      held.push(...lines);
      return;
    }

    // Not in the middle of a step, so there's no label to wait for
    for (const line of lines) {
      this.line(line);
    }
  }

  stepFinished(_step: string, index: number, total: number) {
    for (const node of [...this.held.keys()]) {
      this.release(node);
    }

    this.done = index + 1;
    this.total = total;
    this.drawBar();
  }

  finished(summary: RunSummary) {
    this.clearBar();

    if (!this.summary) {
      return;
    }

    const seconds = (summary.elapsedMs / 1000).toFixed(1);

    if (summary.failures.length === 0) {
      this.write(
        `\n${chalk.green.bold("✓")} ${chalk.bold(`${summary.completed} steps`)} in ${seconds}s\n\n`,
      );
      return;
    }

    this.write(
      `\n${chalk.red.bold("✗")} stopped after ${chalk.bold(`${summary.completed} of ${summary.total} steps`)} in ${seconds}s\n\n`,
    );

    for (const failure of summary.failures) {
      this.write(`  ${this.label(failure.node)} ${chalk.red(failure.step)}\n`);

      // A sentence a line under the label, kept inside the terminal;
      // see layOut. Cut short, since a command that failed loudly can
      // say a great deal and the first few lines are the useful ones.
      const indent = `  ${" ".repeat(this.width + 2)}`;
      const columns = Math.min(this.stream.columns ?? 100, 120);

      for (const line of layOut(failure.why, indent, columns).slice(0, 10)) {
        this.write(`${chalk.dim(line)}\n`);
      }
    }

    this.write("\n");
  }

  /**
   * Write out what a node said during its step, and stop holding it.
   */
  private release(node: string) {
    const held = this.held.get(node);
    this.held.delete(node);

    for (const line of held ?? []) {
      this.line(line);
    }
  }

  /**
   * A node's name, padded and coloured so a column of them lines up.
   */
  private label(node: string): string {
    const colour = this.colours.get(node);
    const padded = this.display(node).padEnd(this.width);

    return colour !== undefined ? colour(padded) : padded;
  }

  /**
   * What a node is printed as.
   */
  private display(node: string): string {
    return this.displayNames.get(node) ?? node;
  }

  /**
   * Write a line above the progress bar.
   */
  private line(text: string) {
    this.clearBar();
    this.write(`${text}\n`);
    this.drawBar();
  }

  private write(text: string) {
    this.stream.write(text);
  }

  private drawBar() {
    if (!this.interactive || this.total === 0) {
      return;
    }

    // Always start from a clean line. Two draws in a row otherwise
    // leave the first one sitting there, and the bar walks across the
    // terminal instead of staying put.
    this.clearBar();

    const columns = this.stream.columns ?? 80;
    const width = Math.max(10, Math.min(30, columns - 40));
    const filled = Math.round((this.done / this.total) * width);

    const bar = `${chalk.cyan("█".repeat(filled))}${chalk.dim("░".repeat(width - filled))}`;
    const counter = `${this.done}/${this.total}`;
    const line = `  ${bar}  ${chalk.bold(counter)}  ${chalk.dim(this.current)}`;

    // Trimmed to the terminal's width so a long step name doesn't wrap
    // onto a second row, which the clear below would then only half
    // remove
    this.write(truncate(line, columns - 1));
    this.bar = true;
  }

  private clearBar() {
    if (!this.interactive || !this.bar) {
      return;
    }

    // Back to the start of the line and wipe it, so the next thing
    // written lands on a clean row rather than over the bar
    this.write("\r[2K");
    this.bar = false;
  }
}
