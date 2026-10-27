import chalk from "chalk";

const log = console.log;

// What success and failure look like wherever the installer reports
// them, so a check that passed reads the same in preflight, the
// doctor and a pipeline run.
export const SUCCESS = "✅";
export const FAILURE = "🛑";

// Both marks are emoji, which a terminal draws two columns wide.
// Anything printed in the same column — a skipped step's dot, the bar
// under a step's output — is padded to this so the text after it
// still lines up.
export const MARK_WIDTH = 2;

/**
 * A one column mark, padded to sit in a column of emoji.
 *
 * @param mark
 * @returns
 */
export function padMark(mark: string): string {
  return mark + " ".repeat(MARK_WIDTH - 1);
}

export function communityCloud() {
  log(`${chalk.blue.bold("Community")} ${chalk.red.bold("Cloud")}`);
}

export function successMessage(label: string, description: string) {
  log(`${SUCCESS} ${chalk.green.bold(label + ":")} ${description}`);
}

export function failureMessage(label: string, description: string) {
  log(`${FAILURE} ${chalk.red(label + ":")} ${description}`);
}

/**
 * A heading for a section of a report, ruled across the terminal.
 *
 * Bold and coloured, with a rule out to the edge, so the parts of a
 * long report can be found by scrolling back through it. Not wider
 * than 120 columns, to match the width the report text is broken at.
 *
 * @param title in title case, as headings are
 * @param width
 * @returns
 */
export function heading(title: string, width = Math.min(process.stdout.columns ?? 100, 120)): string {
  const lead = `━━ ${title} `;
  const rule = "━".repeat(Math.max(width - lead.length, 3));
  return `\n${chalk.bold.cyan(lead)}${chalk.cyan(rule)}`;
}
