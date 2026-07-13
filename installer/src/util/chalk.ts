import chalk from "chalk";

const log = console.log;

export function communityCloud() {
  log(`${chalk.blue.bold("Community")} ${chalk.red.bold("Cloud")}`);
}

export function successMessage(label, description) {
  log(`✅ ${chalk.green.bold(label + ":")} ${description}`);
}

export function failureMessage(label, description) {
  log(`⛔ ${chalk.red(label + ":")} ${description}`);
}
