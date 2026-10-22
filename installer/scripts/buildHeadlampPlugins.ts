/**
 * @file
 * Build the Headlamp plugins in headlamp/plugins/, for embedding.
 *
 * Each plugin is its own npm project, with its own dependencies, so
 * this installs those where they're missing and runs the plugin's own
 * build. The output, dist/main.js, is what generateEmbedded.ts carries
 * into the installer. The plugins' build scripts are used rather than
 * "headlamp-plugin build", whose CLI doesn't run on recent Node.
 *
 *   bun run build:plugins
 */
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIRECTORY = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "headlamp", "plugins");

/**
 * Run a command in a plugin's folder, failing loudly.
 *
 * @param directory
 * @param command
 */
function run(directory: string, command: string[]) {
  const result = Bun.spawnSync(command, { cwd: directory, stdout: "inherit", stderr: "inherit" });

  if (result.exitCode !== 0) {
    throw new Error(`"${command.join(" ")}" failed in ${directory}`);
  }
}

const entries = await readdir(PLUGIN_DIRECTORY, { withFileTypes: true });

for (const entry of entries.filter((each) => each.isDirectory()).sort((one, other) => one.name.localeCompare(other.name))) {
  const directory = join(PLUGIN_DIRECTORY, entry.name);

  if (!existsSync(join(directory, "package.json"))) {
    continue;
  }

  console.log(`Building the Headlamp plugin ${entry.name}`);

  // "ci" rather than "install", so the lockfile decides what's built
  if (!existsSync(join(directory, "node_modules"))) {
    run(directory, ["npm", "ci"]);
  }

  run(directory, ["npm", "run", "build"]);
}
