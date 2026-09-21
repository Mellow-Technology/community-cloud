/**
 * @file
 * The installer README describes the installer that exists.
 *
 * Two things are checked. The example configuration has to be one the
 * installer would actually accept — it is the first thing anybody
 * copies, so it being subtly wrong is expensive. And every default the
 * README states has to be the default the code uses, read out of the
 * source rather than from a list kept here, because a list kept here
 * would go stale in exactly the same way the README does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { StorageClass } from "../cli/commands/LVM.ts";
import { GatewayMode, K3SInstallationType, NodeRole } from "../util/types.ts";
import { checkConfiguration } from "../runners/preflight.ts";
import { getBundleNames } from "../cli/commands/bundles.ts";
import { packageCatalogue } from "../cli/commands/packages.ts";
import { regions } from "../topology/regions.ts";
import { INSTALLER_ROOT, configFrom } from "./helpers.ts";

const README = readFileSync(join(INSTALLER_ROOT, "README.md"), "utf8");
const SOURCE = join(INSTALLER_ROOT, "src");

// What the README states, and the constant in the source that decides
// it. Read from the source so this can't drift the way a copy would.
const DEFAULTS: [string, RegExp, string][] = [
  ["Cilium version", /DEFAULT_CILIUM_VERSION = "([^"]+)"/, "cli/commands/Cilium.ts"],
  ["Cilium CLI version", /DEFAULT_CLI_VERSION = "([^"]+)"/, "cli/commands/Cilium.ts"],
  ["Gateway API version", /DEFAULT_GATEWAY_API_VERSION = "([^"]+)"/, "cli/commands/Cilium.ts"],
  ["cluster CIDR", /DEFAULT_CLUSTER_CIDR = "([^"]+)"/, "cli/commands/K3s.ts"],
  ["kubeconfig path", /DEFAULT_KUBECONFIG = "([^"]+)"/, "util/kube.ts"],
  ["congestion control", /DEFAULT_CONGESTION_CONTROL = "([^"]+)"/, "cli/commands/Networking.ts"],
  ["qdisc", /DEFAULT_QDISC = "([^"]+)"/, "cli/commands/Networking.ts"],
  ["gateway pool name", /DEFAULT_NAME = "([^"]+)"/, "cli/commands/GatewayNodes.ts"],
  ["LVM owner tag", /OWNER_TAG = "([^"]+)"/, "cli/commands/LVM.ts"],
  ["cluster ConfigMap name", /CLUSTER_CONFIG_NAME = "([^"]+)"/, "cli/commands/ClusterConfig.ts"],
];

function readSource(path: string): string {
  return readFileSync(join(SOURCE, path), "utf8");
}

/**
 * The example configuration, with its comments stripped.
 */
function readExample(): any {
  const block = README.split("```jsonc")[1]!.split("```")[0]!;

  return JSON.parse(
    block
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n"),
  );
}

describe("the example configuration", () => {
  it("is valid JSON once the comments are stripped", () => {
    assert.doesNotThrow(readExample);
  });

  const example = readExample();

  it("is one preflight accepts", () => {
    const problems = checkConfiguration(configFrom(example)).map((one) => one.what);

    assert.deepEqual(problems, []);
  });

  it("names a real gateway mode", () => {
    assert.ok(Object.values(GatewayMode).includes(example.network.gateway.mode));
  });

  it("names a real node type", () => {
    assert.ok(Object.values(K3SInstallationType).includes(example.nodes[0].type));
  });

  it("names real roles", () => {
    for (const role of example.nodes[0].roles) {
      assert.ok(Object.values(NodeRole).includes(role), role);
    }
  });

  it("names a real region", () => {
    assert.ok(regions.some((region) => region.code === example.nodes[0].region));
  });

  it("names packages that are in the catalogue", () => {
    for (const name of Object.keys(example.packages)) {
      assert.ok(
        packageCatalogue.some((entry) => entry.name === name),
        name,
      );
    }
  });
});

describe("what the README lists", () => {
  it("lists every package in the catalogue", () => {
    const missing = packageCatalogue
      .filter((entry) => !README.includes(`\`${entry.name}\``))
      .map((entry) => entry.name);

    assert.deepEqual(missing, []);
  });

  it("lists every storage class the code defines", () => {
    // ssd-cache is declared and not implemented, and the README says
    // so elsewhere rather than in the class list
    const missing = Object.values(StorageClass)
      .filter((one) => one !== StorageClass.SsdCache)
      .filter((one) => !README.includes(`\`${one}\``));

    assert.deepEqual(missing, []);
  });

  it("names every K3s component that is always disabled", () => {
    const declared = readSource("cli/commands/K3s.ts").match(/ALWAYS_DISABLED = \[([^\]]+)\]/);
    const disabled = [...(declared?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]!);

    assert.ok(disabled.length > 0, "the constant wasn't found in K3s.ts");

    for (const name of disabled) {
      assert.ok(README.includes(name), name);
    }
  });

  it("only names bundles that exist", () => {
    const shown = [...README.matchAll(/run-bundle (\w+)/g)].map((match) => match[1]!);
    const missing = shown.filter((name) => !getBundleNames().includes(name));

    assert.deepEqual(missing, []);
  });

  it("shows a pipeline of real bundles", () => {
    const missing = ["base", "network", "gpu", "k3s", "nodeLabels"].filter(
      (name) => !getBundleNames().includes(name),
    );

    assert.deepEqual(missing, []);
  });
});

describe("the defaults the README states", () => {
  for (const [what, pattern, file] of DEFAULTS) {
    it(`matches the ${what} in ${file}`, () => {
      const found = readSource(file).match(pattern);

      assert.ok(found !== null, `the constant isn't in ${file} any more`);
      assert.ok(README.includes(found![1]!), `the code says ${found![1]}`);
    });
  }
});
