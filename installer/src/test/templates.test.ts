/**
 * @file
 * Every manifest the binary carries renders, and resolves.
 *
 * Rendering is not enough on its own: a YAML alias with no anchor
 * parses cleanly and blows up the moment anything asks for the value,
 * so each document is resolved as well as parsed.
 *
 * The other thing checked here is the quiet failure — a template tag
 * that renders to nothing because the configuration has no such value.
 * Go templates render a missing value as an empty string, so a typo in
 * a path produces a manifest that applies successfully and does the
 * wrong thing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";

import CloudConfig from "../util/CloudConfig.ts";
import { listEmbeddedFiles, readEmbeddedFile } from "../util/embedded.ts";
import { buildTemplateValues, renderInstallerFile } from "../util/template.ts";
import { loadFixtureConfig } from "./helpers.ts";

/**
 * Follow a dotted path into the values.
 */
function lookup(values: any, path: string): unknown {
  let current = values;

  for (const part of path.split(".")) {
    current = current?.[part];
  }

  return current;
}

/**
 * Render one manifest and say what went wrong, if anything.
 */
function check(config: CloudConfig, file: string, values: any) {
  let rendered: string;

  try {
    rendered = renderInstallerFile(config, `embed://${file}`);
  } catch (error: any) {
    return { broken: `won't render — ${error.message.split("\n")[0]}` };
  }

  try {
    for (const document of parseAllDocuments(rendered) as any[]) {
      if (document.errors.length > 0) {
        throw new Error(document.errors[0].message.split("\n")[0]);
      }

      // Resolving is what catches an alias with no anchor
      document.toJS();
    }
  } catch (error: any) {
    return { broken: error.message.split("\n")[0] };
  }

  const referenced = [
    ...new Set(
      [...readEmbeddedFile(file).matchAll(/\.Values\.([A-Za-z0-9_.]+)/g)].map(
        (match) => match[1]!,
      ),
    ),
  ];

  const blank = referenced.filter((path) => {
    const value = lookup(values, path);
    return value === undefined || value === null || value === "";
  });

  return { blank };
}

describe("the manifests the binary carries", async () => {
  const config = await loadFixtureConfig();
  const { Values } = buildTemplateValues(config) as any;
  const files = listEmbeddedFiles();

  const results = files.map((file) => ({ file, ...check(config, file, Values) }));

  it("carries some", () => {
    assert.ok(files.length > 20, `only ${files.length} embedded files`);
  });

  it("all render and resolve", () => {
    const broken = results
      .filter((result) => result.broken !== undefined)
      .map((result) => `${result.file}: ${result.broken}`);

    assert.deepEqual(broken, []);
  });

  it("reference no value the fixture doesn't set", () => {
    // A tag that renders to nothing is the quiet failure this is for:
    // the manifest applies and does the wrong thing. The fixture sets
    // every value the manifests reference, so anything blank here is
    // either a new tag or a typo in an existing one.
    const blank = results
      .filter((result) => (result.blank?.length ?? 0) > 0)
      .map((result) => `${result.file} → ${result.blank!.join(", ")}`);

    assert.deepEqual(blank, []);
  });
});
