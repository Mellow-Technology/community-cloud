/**
 * @file
 * The interactive installer: build a Community Cloud configuration, or
 * change one that already exists.
 *
 * This is what running the command with no arguments does, because for
 * anyone who hasn't used it before it's the only useful starting point.
 * The bundles and pipelines all take a configuration file; this is
 * where that file comes from.
 *
 * A new configuration is walked through section by section. An existing
 * one opens a menu instead, so changing where the cluster's domain
 * points doesn't mean answering questions about storage.
 */
import { confirm, select } from "@inquirer/prompts";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import chalk from "chalk";

import { ConfigDraft, ConfigSection } from "../cli/configure/section.ts";
import { configSections, getSection } from "../cli/configure/index.ts";

// What the configuration is called unless told otherwise. Matches the
// pattern .gitignore already excludes, so a file full of credentials
// doesn't get committed by accident.
const DEFAULT_CONFIG_FILE = "cc.config.json";

/**
 * Options for a configure run.
 *
 * - all: walk every section rather than opening the menu, which is
 *   what a new configuration does anyway
 * - section: go straight to one section and come back out
 */
export interface ConfigureOptions {
  all?: boolean;
  section?: string;
}

/**
 * Build or edit a configuration.
 *
 * @param configPath
 * @param options
 */
export async function configure(
  configPath: string = DEFAULT_CONFIG_FILE,
  options: ConfigureOptions = {},
) {
  // Prompts need somewhere to prompt. Without this the command would
  // hang waiting on a terminal that isn't there, which is a miserable
  // thing to hit from a script.
  if (!process.stdin.isTTY) {
    throw new Error(
      "The interactive installer needs a terminal. Run it directly, or use one of the other commands (see --help).",
    );
  }

  const filePath = isAbsolute(configPath) ? configPath : join(process.cwd(), configPath);
  const { draft, existed } = await loadDraft(filePath);

  welcome(filePath, existed);

  if (options.section !== undefined) {
    const section = getSection(options.section);

    if (section === undefined) {
      throw new Error(
        `There's no "${options.section}" section. The sections are: ${configSections.map((entry) => entry.name).join(", ")}.`,
      );
    }

    await runSection(section, draft);
    await save(filePath, draft);
    return;
  }

  // A configuration that doesn't exist yet has nothing to show a menu
  // about, so it's walked through instead
  if (!existed || options.all === true) {
    for (const section of configSections) {
      await runSection(section, draft);
    }

    await save(filePath, draft);
    return;
  }

  await runMenu(draft, filePath);
}

/**
 * Read the configuration, or start an empty one.
 *
 * @param filePath
 * @returns
 */
async function loadDraft(filePath: string): Promise<{ draft: ConfigDraft; existed: boolean }> {
  let contents = null;

  try {
    contents = await readFile(filePath, { encoding: "utf8" });
  } catch {
    return { draft: {}, existed: false };
  }

  try {
    return { draft: JSON.parse(contents), existed: true };
  } catch (e: any) {
    throw new Error(
      `"${filePath}" exists but isn't valid JSON: ${e.message}. Fix or move it before running this.`,
    );
  }
}

/**
 * Say what's about to happen.
 *
 * @param filePath
 * @param existed
 */
function welcome(filePath: string, existed: boolean) {
  console.log(`\n${chalk.blue.bold("Community")} ${chalk.red.bold("Cloud")}\n`);

  console.log(
    existed
      ? `Editing ${chalk.cyan(filePath)}\n`
      : `Setting up a new configuration at ${chalk.cyan(filePath)}\n`,
  );
}

/**
 * Show what's configured and let someone pick what to change.
 *
 * @param draft
 * @param filePath
 */
async function runMenu(draft: ConfigDraft, filePath: string) {
  let done = false;

  while (!done) {
    const width = Math.max(...configSections.map((section) => section.title.length));

    const action = await select({
      message: "What would you like to change?",
      pageSize: configSections.length + 4,
      choices: [
        ...configSections.map((section) => ({
          name: `${section.title.padEnd(width)}  ${chalk.dim(describe(section, draft))}`,
          value: section.name,
        })),
        { name: "Save and exit", value: "save" },
        { name: "Exit without saving", value: "quit" },
      ],
    });

    if (action === "save") {
      await save(filePath, draft);
      return;
    }

    if (action === "quit") {
      const sure = await confirm({ message: "Leave without saving?", default: false });
      if (sure) {
        console.log("Nothing was written.\n");
        return;
      }

      continue;
    }

    const section = getSection(action);
    if (section !== undefined) {
      await runSection(section, draft);
    }
  }
}

/**
 * Run one section, with a heading so it's clear where you are.
 *
 * @param section
 * @param draft
 */
async function runSection(section: ConfigSection, draft: ConfigDraft) {
  console.log(`\n${chalk.cyan.bold(section.title)}\n`);
  await section.run(draft);
}

/**
 * A section's summary, never allowed to break the menu.
 *
 * @param section
 * @param draft
 * @returns
 */
function describe(section: ConfigSection, draft: ConfigDraft): string {
  try {
    return section.describe(draft);
  } catch (e: any) {
    return `couldn't be read: ${e.message}`;
  }
}

/**
 * Write it out.
 *
 * @param filePath
 * @param draft
 */
async function save(filePath: string, draft: ConfigDraft) {
  await writeFile(filePath, `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8" });

  console.log(`\n${chalk.green("✅")} Written to ${chalk.cyan(filePath)}`);
  console.log(
    chalk.dim(
      "   It holds credentials, so keep it out of version control. Anything matching *.config.json already is.\n",
    ),
  );

  console.log("Next:");
  console.log(chalk.dim(`   community-cloud list-bundles --config ${filePath}`));
  console.log(chalk.dim(`   community-cloud run-pipeline <bundles> <node> ${filePath}\n`));
}
