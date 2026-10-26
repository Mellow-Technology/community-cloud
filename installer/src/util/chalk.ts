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
