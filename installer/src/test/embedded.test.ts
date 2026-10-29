/**
 * @file
 * The committed embedded database says what k8s/ says.
 *
 * The installer applies the copy of each manifest inside
 * src/generated/embedded.sqlite, not the file in k8s/, and a run from a
 * checkout uses the committed database as it is. So a change to k8s/
 * without `bun run build:embedded` is a change nobody's cluster gets:
 * a release that bumped an image's pin in k8s/ alone went on applying
 * the old image. CI runs this before its own rebuild, which would
 * otherwise hide the difference.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { INSTALLER_ROOT, REPO_ROOT } from "./helpers.ts";

// What build:embedded stores from k8s/, and what it stores besides
const EMBED_EXTENSIONS = [".yaml", ".yml"];
const PLUGIN_PREFIX = "headlamp-plugins/";

/**
 * Every manifest under k8s/, by the path it's stored under.
 *
 * @param directory
 * @returns
 */
function manifestsOnDisk(directory = join(REPO_ROOT, "k8s")): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of manifestsOnDisk(path)) {
        found.set(key, value);
      }
    } else if (EMBED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.set(relative(join(REPO_ROOT, "k8s"), path), readFileSync(path, "utf8"));
    }
  }
  return found;
}

describe("the committed embedded database", () => {
  const database = new Database(join(INSTALLER_ROOT, "src/generated/embedded.sqlite"), { readonly: true });
  const rows = database.query("select path, contents from files").all() as { path: string; contents: string }[];
  const embedded = new Map(rows.filter((row) => !row.path.startsWith(PLUGIN_PREFIX)).map((row) => [row.path, row.contents]));
  const onDisk = manifestsOnDisk();
  const hint = 'Run "bun run build:plugins && bun run build:embedded" in installer/ and commit the database.';

  it("has every manifest in k8s/, as it is there", () => {
    const stale = [...onDisk].filter(([path, contents]) => embedded.get(path) !== contents).map(([path]) => path);
    assert.deepEqual(stale, [], `Out of date or missing in embedded.sqlite: ${stale.join(", ")}. ${hint}`);
  });

  it("has nothing k8s/ no longer has", () => {
    const gone = [...embedded.keys()].filter((path) => !onDisk.has(path));
    assert.deepEqual(gone, [], `In embedded.sqlite but not in k8s/: ${gone.join(", ")}. ${hint}`);
  });
});
