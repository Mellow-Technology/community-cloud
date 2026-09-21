/**
 * @file
 * Build the database of manifests that travels inside the binary.
 *
 * A compiled executable has no repository next to it, so the values
 * files and manifests in k8s/ have to be carried along. Bun embeds a
 * SQLite database when it's imported with a "sqlite" attribute, so
 * that's what this writes: one row per file, looked up by path.
 *
 * Paths lose the leading "k8s/", which only exists to keep the
 * repository tidy and is no use to someone typing one. So
 * k8s/ai/vLLM/vllm-amd.yaml is stored, and referred to, as
 * ai/vLLM/vllm-amd.yaml.
 *
 * Run after adding or removing anything under k8s/:
 *
 *   bun run build:embedded
 */
import { Database } from "bun:sqlite";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// What gets built, and what goes into it
const DATABASE_FILE = "src/generated/embedded.sqlite";
const SOURCE_DIRECTORY = "k8s";

// The manifests and values files. The READMEs under k8s/ are for
// people reading the repository, and nothing at runtime opens them.
const EMBED_EXTENSIONS = [".yaml", ".yml"];

/**
 * The root of the repository, from this file's own location.
 *
 * @returns
 */
function getRepoRoot(): string {
  // installer/scripts -> the root of the repository
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
}

/**
 * Every file worth embedding, relative to the source directory.
 *
 * Sorted, so that building the same tree twice produces the same
 * database and a rebuild doesn't show up as a change when nothing
 * has actually changed.
 *
 * @param root
 * @param directory
 * @returns
 */
async function findFiles(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries.sort((one, other) => one.name.localeCompare(other.name))) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await findFiles(root, path)));
      continue;
    }

    if (EMBED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(path);
    }
  }

  return found;
}

/**
 * Write the database.
 */
async function generate() {
  const root = getRepoRoot();
  const databasePath = join(root, "installer", DATABASE_FILE);

  // Built from scratch every time, so a file deleted from k8s/ leaves
  // with it rather than lingering in the binary
  await rm(databasePath, { force: true });

  const database = new Database(databasePath, { create: true });
  database.run("CREATE TABLE files (path TEXT NOT NULL, contents TEXT NOT NULL)");
  database.run("CREATE UNIQUE INDEX files_path ON files (path)");

  const insert = database.prepare("INSERT INTO files (path, contents) VALUES ($path, $contents)");
  const files = await findFiles(root, SOURCE_DIRECTORY);

  let bytes = 0;
  for (const file of files) {
    const contents = await readFile(join(root, file), { encoding: "utf8" });
    bytes += contents.length;

    // Stored without the "k8s/" prefix, and with forward slashes, so
    // the path is the same one on every platform
    const path = relative(SOURCE_DIRECTORY, file).split("\\").join("/");
    insert.run({ $path: path, $contents: contents });
  }

  database.close();

  console.log(
    `Embedded ${files.length} files (${(bytes / 1024).toFixed(0)} KB) from ${SOURCE_DIRECTORY}/ into ${DATABASE_FILE}`,
  );
}

await generate();
