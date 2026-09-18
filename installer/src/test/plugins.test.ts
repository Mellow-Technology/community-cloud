/**
 * @file
 * The plugin system, and in particular the parts of it that refuse
 * things.
 *
 * Most of what follows builds a deliberately wrong plugin in a
 * temporary directory and asserts that reading it fails with a message
 * saying what is wrong. A loader that accepts a hostile plugin is a
 * much worse bug than one that rejects a valid plugin, so the refusals
 * are what most of this is about.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import ArchiveSource from "../plugins/ArchiveSource.ts";
import DirectorySource from "../plugins/DirectorySource.ts";
import { describePlugin, fingerprint } from "../plugins/approval.ts";
import { readManifest } from "../plugins/manifest.ts";
import { readZip } from "../plugins/zip.ts";
import {
  loadPlugins,
  namespaced,
  parsePluginPath,
  resetPlugins,
} from "../plugins/registry.ts";
import {
  getBundle,
  registerBundle,
  resetBundles,
} from "../cli/commands/bundles.ts";
import {
  getPackage,
  registerPackage,
  resetPackages,
} from "../cli/commands/packages.ts";
import { configFrom, makeTempDirectory } from "./helpers.ts";

const VALID_MANIFEST = `apiVersion: community-cloud/v1
name: demo
description: A demo plugin
type: package
packages:
  - name: demo
    description: The demo chart
    chart: { repo: https://example.invalid/charts, name: demo }
    namespace: cc-demo
    valuesFile: plugin://demo/templates/Demo.values.yaml
`;

const workspace = makeTempDirectory("plugins");

after(() => {
  resetPlugins();
  resetBundles();
  resetPackages();
  workspace.remove();
});

/**
 * Build a plugin directory and return a source for it.
 *
 * @param name the directory name, which is deliberately not the
 *             plugin's name — those come from the manifest
 * @param manifest
 * @param files
 * @returns
 */
function makePlugin(
  name: string,
  manifest: string,
  files: Record<string, string> = {},
): DirectorySource {
  const path = join(workspace.path, name);

  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, "templates"), { recursive: true });
  writeFileSync(join(path, "plugin.yaml"), manifest);

  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(join(path, file), contents);
  }

  return new DirectorySource(path);
}

/**
 * Load from a directory holding only the named plugins.
 *
 * @param plugins the configuration's plugins section
 * @param directory
 * @returns
 */
function load(plugins: Record<string, unknown>, directory: string) {
  resetPlugins();
  resetBundles();
  resetPackages();

  return loadPlugins(configFrom({ plugins, nodes: [] }), directory);
}

describe("a plugin that is what it says", () => {
  let source: DirectorySource;

  before(() => {
    source = makePlugin("demo", VALID_MANIFEST, {
      "templates/Demo.values.yaml": "replicas: {{ .Values.demoReplicas }}\n",
    });
  });

  it("reads its manifest", () => {
    const manifest = readManifest(source);

    assert.equal(manifest.name, "demo");
    assert.equal(manifest.type, "package");
    assert.equal(manifest.packages.length, 1);
  });

  it("lists its files", () => {
    assert.ok(source.list().includes("templates/Demo.values.yaml"));
  });

  it("fingerprints", () => {
    assert.match(fingerprint(source), /^[0-9a-f]{64}$/);
  });

  it("keeps the same fingerprint once packaged", () => {
    // The fingerprint is of the contents rather than the file, so
    // zipping a plugin you already approved must not re-ask
    const archivePath = join(workspace.path, "demo.ccp");
    execFileSync("zip", ["-qr", archivePath, "."], { cwd: source.origin });

    const packaged = new ArchiveSource(archivePath);

    assert.equal(fingerprint(packaged), fingerprint(source));
    assert.deepEqual(packaged.list(), source.list());

    rmSync(archivePath);
  });
});

describe("what a declared type refuses", () => {
  it("won't let a package plugin carry commands", () => {
    assert.throws(
      () =>
        readManifest(
          makePlugin(
            "withcommands",
            `apiVersion: community-cloud/v1
name: withcommands
type: package
bundles:
  - name: sneaky
    commands:
      - name: oops
        command: ["rm -rf /"]
`,
          ),
        ),
      /package plugin is charts, manifests/,
    );
  });

  it("won't load a code plugin at all", () => {
    assert.throws(
      () =>
        readManifest(
          makePlugin(
            "codeplugin",
            "apiVersion: community-cloud/v1\nname: codeplugin\ntype: code\n",
          ),
        ),
      /runs inside the installer/,
    );
  });

  it("says the inspection type isn't ready rather than pretending", () => {
    assert.throws(
      () =>
        readManifest(
          makePlugin(
            "inspector",
            "apiVersion: community-cloud/v1\nname: inspector\ntype: inspection\n",
          ),
        ),
      /probe catalogue/,
    );
  });

  it("allows a node plugin its shell, because that is what it is for", () => {
    const manifest = readManifest(
      makePlugin(
        "nodey",
        `apiVersion: community-cloud/v1
name: nodey
type: node
bundles:
  - name: setup
    description: Do a thing
    commands:
      - name: do-it
        description: Does it
        purpose: apply
        command: ["echo doing it"]
`,
      ),
    );

    assert.equal(manifest.bundles[0]!.commands.length, 1);
  });
});

describe("a malformed manifest", () => {
  const cases: [string, string, RegExp][] = [
    [
      "an unknown type",
      "apiVersion: community-cloud/v1\nname: weird\ntype: superuser\n",
      /has to say what it is/,
    ],
    [
      "an unknown apiVersion",
      "apiVersion: community-cloud/v99\nname: future\ntype: package\n",
      /apiVersion/,
    ],
    [
      "a name that isn't a name",
      'apiVersion: community-cloud/v1\nname: "Not A Name"\ntype: package\n',
      /lower case letters/,
    ],
    [
      "a command with nothing to run",
      `apiVersion: community-cloud/v1
name: empty
type: node
bundles:
  - name: b
    commands:
      - name: nothing
`,
      /nothing to run/,
    ],
    [
      "a list that isn't a list",
      "apiVersion: community-cloud/v1\nname: listy\ntype: package\npackages: nope\n",
      /has to be a list/,
    ],
  ];

  for (const [label, manifest, expected] of cases) {
    it(`is refused: ${label}`, () => {
      assert.throws(() => readManifest(makePlugin("bad", manifest)), expected);
    });
  }

  it("says precisely when the manifest is one level down", () => {
    const path = join(workspace.path, "nested");
    rmSync(path, { recursive: true, force: true });
    mkdirSync(join(path, "inner"), { recursive: true });
    writeFileSync(join(path, "inner", "plugin.yaml"), VALID_MANIFEST);

    assert.throws(
      () => readManifest(new DirectorySource(path)),
      /top level/,
      "the mistake every plugin author makes once",
    );
  });
});

describe("the paths a plugin may name", () => {
  let source: DirectorySource;

  before(() => {
    source = makePlugin("paths", VALID_MANIFEST, {
      "templates/Demo.values.yaml": "replicas: 1\n",
    });
  });

  it("cannot reach outside the plugin", () => {
    assert.throws(() => source.read("../../../etc/passwd"), /outside the plugin/);
  });

  it("cannot do it with a leading slash either", () => {
    assert.throws(
      () => source.read("/templates/../../../etc/passwd"),
      /outside the plugin/,
    );
  });

  it("names what is there when a file is missing", () => {
    assert.throws(() => source.read("templates/Nope.yaml"), /Demo.values.yaml/);
  });

  it("splits a plugin path into the plugin and the file", () => {
    assert.deepEqual(parsePluginPath("plugin://demo/templates/x.yaml"), {
      plugin: "demo",
      file: "templates/x.yaml",
    });
  });

  it("refuses an incomplete plugin path", () => {
    assert.throws(() => parsePluginPath("plugin://demo"), /complete plugin path/);
  });
});

describe("loading, and the approval gate", () => {
  const directory = join(workspace.path, "installed");
  let print: string;

  before(() => {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(directory, "demo", "templates"), { recursive: true });
    writeFileSync(join(directory, "demo", "plugin.yaml"), VALID_MANIFEST);
    writeFileSync(
      join(directory, "demo", "templates", "Demo.values.yaml"),
      "replicas: 1\n",
    );

    print = fingerprint(new DirectorySource(join(directory, "demo")));
  });

  it("loads nothing the configuration didn't ask for", () => {
    assert.equal(load({}, directory).length, 0, "being in the directory is not consent");
  });

  it("refuses one nobody approved, and says what it would do", () => {
    assert.throws(
      () => load({ demo: true }, directory),
      /hasn't been approved/,
    );
  });

  it("names what is available when the one asked for isn't", () => {
    assert.throws(
      () => load({ missing: { enabled: true, sha256: print } }, directory),
      /isn't one in/,
    );
  });

  describe("once approved", () => {
    before(() => load({ demo: { enabled: true, sha256: print } }, directory));

    it("loads", () => {
      assert.equal(getPackage("demo") !== undefined, true);
    });

    it("registers its package under the plugin's own name", () => {
      // Not "demo:demo" — a plugin whose package is named after itself
      // shouldn't have to be written twice in every configuration
      assert.equal(getPackage("demo")?.name, "demo");
    });

    it("remembers which plugin brought it", () => {
      assert.equal(getPackage("demo")?.plugin, "demo");
    });

    it("leaves its template paths alone", () => {
      assert.equal(
        getPackage("demo")?.valuesFile,
        "plugin://demo/templates/Demo.values.yaml",
      );
    });
  });

  it("refuses a plugin that changed after it was approved", () => {
    assert.throws(
      () => load({ demo: { enabled: true, sha256: "0".repeat(64) } }, directory),
      /isn't what it was/,
    );
  });
});

describe("what a plugin may not do to the built-ins", () => {
  before(() => {
    resetBundles();
    resetPackages();
  });

  it("cannot replace a bundle the installer ships", () => {
    assert.throws(
      () => registerBundle({ name: "k3s", description: "mine now", commands: [] }, "evil"),
      /can add bundles and can't replace/,
    );
  });

  it("cannot replace a package the installer ships", () => {
    assert.throws(
      () =>
        registerPackage(
          {
            name: "cert-manager",
            description: "mine now",
            chart: { repo: "x", name: "y" },
            namespace: "z",
          },
          "evil",
        ),
      /can add packages and can't replace/,
    );
  });

  it("leaves the built-in intact", () => {
    assert.match(getBundle("k3s")!.description, /K3s/);
  });
});

describe("namespacing", () => {
  it("prefixes a plugin's things with its name", () => {
    assert.equal(namespaced("mastodon", "media"), "mastodon:media");
  });

  it("leaves a thing named after the plugin alone", () => {
    assert.equal(namespaced("authentik", "authentik"), "authentik");
  });

  it("doesn't apply the prefix twice", () => {
    assert.equal(namespaced("m", "m:thing"), "m:thing");
  });
});

describe("the zip reader", () => {
  let archivePath: string;
  let bytes: Uint8Array;

  before(() => {
    const source = makePlugin("zipme", VALID_MANIFEST, {
      "templates/Demo.values.yaml": "replicas: 1\n",
    });

    archivePath = join(workspace.path, "zipme.ccp");
    rmSync(archivePath, { force: true });
    execFileSync("zip", ["-qr", archivePath, "."], { cwd: source.origin });
    bytes = new Uint8Array(readFileSync(archivePath));
  });

  it("reads a deflated archive", () => {
    assert.ok(readZip(bytes, "test").some((entry) => entry.path === "plugin.yaml"));
  });

  it("reads a stored archive", () => {
    const storedPath = join(workspace.path, "stored.ccp");
    rmSync(storedPath, { force: true });
    execFileSync("zip", ["-q0r", storedPath, "."], {
      cwd: join(workspace.path, "zipme"),
    });

    const entries = readZip(new Uint8Array(readFileSync(storedPath)), "stored");
    assert.ok(entries.some((entry) => entry.path === "plugin.yaml"));
  });

  it("refuses something that isn't a zip", () => {
    assert.throws(
      () => readZip(new TextEncoder().encode("not a zip file, not even slightly"), "test"),
      /isn't a zip file/,
    );
  });

  it("refuses a file too small to be one", () => {
    assert.throws(() => readZip(new Uint8Array(4), "test"), /too small/);
  });

  it("refuses a truncated archive", () => {
    assert.throws(() => readZip(bytes.slice(0, bytes.length - 40), "test"), /zip/);
  });
});

describe("what an approval shows", () => {
  it("names the chart, where it comes from, and where it goes", () => {
    const source = makePlugin("describeme", VALID_MANIFEST);
    const described = describePlugin(readManifest(source), source).join("\n");

    assert.match(described, /https:\/\/example.invalid\/charts/);
    assert.match(described, /cc-demo/);
  });

  it("warns when a chart isn't pinned", () => {
    const source = makePlugin("unpinned", VALID_MANIFEST);
    const described = describePlugin(readManifest(source), source).join("\n");

    assert.match(described, /whatever version is newest/);
  });

  it("shows a node plugin's actual shell", () => {
    // Which is the whole argument for the declarative format: what a
    // plugin will run can be read before any of it runs
    const source = makePlugin(
      "shelly",
      `apiVersion: community-cloud/v1
name: shelly
type: node
bundles:
  - name: setup
    description: Do a thing
    commands:
      - name: do-it
        description: Does it
        purpose: apply
        command: ["echo doing it"]
`,
    );

    const described = describePlugin(readManifest(source), source).join("\n");
    assert.match(described, /echo doing it/);
  });
});
