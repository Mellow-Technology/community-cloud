/**
 * @file
 * The documentation describes things that exist.
 *
 * Docs rot in a particular way: a file gets renamed, a bundle gets
 * removed, a link goes stale, and nothing notices because prose
 * doesn't compile. Everything a document names in backticks — a
 * manifest, a path, an embed:// example, a bundle — is checked against
 * what is actually there.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { CommandPurpose } from "../cli/commands/Command.ts";
import { getBundleNames } from "../cli/commands/bundles.ts";
import { REPO_ROOT } from "./helpers.ts";

// The documents that describe the repository to somebody reading it
const DOCS = [
  "README.md",
  "docs/index.md",
  "docs/plugins.md",
  "k8s/README.md",
  "k8s/storage/README.md",
  "k8s/apps/README.md",
  "installer/README.md",
];

/**
 * Every YAML file under k8s/, as repository-relative paths.
 */
function findManifests(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...findManifests(path));
      continue;
    }

    if (/\.ya?ml$/.test(entry.name)) {
      found.push(relative(REPO_ROOT, path).split(sep).join("/"));
    }
  }

  return found;
}

const MANIFESTS = new Set(findManifests(join(REPO_ROOT, "k8s")));
const BASENAMES = new Set([...MANIFESTS].map((path) => path.split("/").pop()!));

// A plugin's own manifest. Named all over the plugin documentation
// and correctly absent from k8s/, because it belongs to a plugin
// rather than to this repository.
const PLUGIN_MANIFEST = "plugin.yaml";

/**
 * A name that is prose about the convention rather than a reference to
 * a file in k8s/: a suffix on its own, a stand-in, or a filename that
 * lives somewhere other than the manifest tree.
 */
function isPlaceholder(name: string): boolean {
  return (
    name === PLUGIN_MANIFEST ||
    name.startsWith(".") ||
    name.startsWith("Thing.") ||
    name.startsWith("Mastodon.") ||
    name.includes("values.example")
  );
}

function matchAll(text: string, pattern: RegExp): string[] {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]!))];
}

describe("every document", () => {
  for (const doc of DOCS) {
    describe(doc, () => {
      const path = join(REPO_ROOT, doc);
      const text = readFileSync(path, "utf8");
      const directory = doc.includes("/") ? doc.split("/").slice(0, -1).join("/") : "";

      it("names only manifests that exist", () => {
        const ghosts = matchAll(text, /`([A-Za-z0-9._-]+\.ya?ml)`/g).filter(
          (name) => !BASENAMES.has(name) && !isPlaceholder(name),
        );

        assert.deepEqual(ghosts, []);
      });

      it("gives manifest paths that resolve", () => {
        const bad = matchAll(text, /`(k8s\/[A-Za-z0-9._/-]+\.ya?ml)`/g).filter(
          (named) => !MANIFESTS.has(named),
        );

        assert.deepEqual(bad, []);
      });

      it("gives embed:// examples that resolve", () => {
        const bad = matchAll(text, /embed:\/\/([A-Za-z0-9._/-]+)/g).filter(
          (embed) => !MANIFESTS.has(`k8s/${embed}`),
        );

        assert.deepEqual(bad, []);
      });

      it("links to files that are there", () => {
        const links = [...text.matchAll(/\]\((\.[^)#]*)(#[^)]*)?\)/g)].map((match) => match[1]!);
        const bad = links.filter(
          (link) => !existsSync(join(REPO_ROOT, directory, link)),
        );

        assert.deepEqual(bad, []);
      });
    });
  }
});

describe("what the docs claim about the installer", () => {
  const allDocs = DOCS.map((doc) => readFileSync(join(REPO_ROOT, doc), "utf8")).join("\n");
  const index = readFileSync(join(REPO_ROOT, "docs", "index.md"), "utf8");

  it("only names bundles that exist in run-bundle examples", () => {
    const named = matchAll(allDocs, /run-bundle (\w+)/g);
    const missing = named.filter((name) => !getBundleNames().includes(name));

    assert.deepEqual(missing, []);
  });

  it("lists every bundle in the index", () => {
    const undocumented = getBundleNames().filter((name) => !index.includes(`\`${name}\``));

    assert.deepEqual(undocumented, []);
  });

  it("lists every command purpose in the index", () => {
    const missing = Object.values(CommandPurpose)
      .map((purpose) => purpose.charAt(0).toUpperCase() + purpose.slice(1))
      .filter((purpose) => !index.includes(`\`${purpose}\``));

    assert.deepEqual(missing, []);
  });

  it("names only directories that exist", () => {
    const bad = matchAll(allDocs, /`(k8s\/[a-zA-Z]+\/)`/g).filter(
      (directory) => !existsSync(join(REPO_ROOT, directory)),
    );

    assert.deepEqual(bad, []);
  });
});

describe("the repository's own shape", () => {
  it("keeps the manifests where the docs say they are", () => {
    assert.ok(MANIFESTS.size > 20, `only found ${MANIFESTS.size} manifests under k8s/`);
    assert.ok(statSync(join(REPO_ROOT, "k8s")).isDirectory());
  });
});
