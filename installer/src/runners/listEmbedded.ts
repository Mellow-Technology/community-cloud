/**
 * @file
 * Show the manifests that ship inside the installer.
 *
 * Without this, using an embed:// path means knowing it already.
 */
import chalk from "chalk";

import { EMBED_SCHEME, listEmbeddedFiles } from "../util/embedded.ts";

/**
 * List what the installer carries, optionally filtered.
 *
 * @param filter only show paths containing this
 */
export async function listEmbedded(filter?: string) {
  const all = listEmbeddedFiles();

  const matching =
    filter !== undefined
      ? all.filter((path) => path.toLowerCase().includes(filter.toLowerCase()))
      : all;

  if (matching.length === 0) {
    console.log(
      `\nNothing shipped with the installer matches "${filter}". It carries ${all.length} files.\n`,
    );
    return;
  }

  console.log(`\n${chalk.bold("Manifests that ship with the installer")}\n`);

  // Grouped by directory, since that's how someone looks for one
  let directory = null;
  for (const path of matching) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";

    if (parent !== directory) {
      console.log(`  ${chalk.dim(parent)}`);
      directory = parent;
    }

    console.log(`    ${chalk.cyan(EMBED_SCHEME + path)}`);
  }

  console.log(
    `\n${chalk.dim(`${matching.length} of ${all.length} files. Use one with:`)}\n${chalk.dim(`   community-cloud run-template ${EMBED_SCHEME}${matching[0]} <ccFilePath>`)}\n`,
  );
}
