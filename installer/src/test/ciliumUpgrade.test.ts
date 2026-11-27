/**
 * @file
 * The cilium bundle run on a cluster that has Cilium already.
 *
 * "cilium install" refuses one, so changing a setting by running the
 * bundle again has to upgrade instead. These run the step's own shell
 * against a stand-in kubectl and cilium, so what's tested is the choice
 * a control plane would make.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CiliumCommands } from "../cli/commands/Cilium.ts";
import type { TerminalCommandSpec } from "../cli/commands/Command.ts";
import { configFrom, makeTempDirectory } from "./helpers.ts";

// The stand-ins, and apart from them the cluster's state and what the
// CLI was asked, so resetting one can't touch the other
let directory: { path: string; remove: () => void };
let cluster: { path: string; remove: () => void };

before(() => {
  directory = makeTempDirectory("cilium-upgrade");
  cluster = makeTempDirectory("cilium-cluster");
  const tools: Record<string, string> = {
    // Helm's record of the release, when there is one; fails when the
    // cluster can't be asked
    kubectl: [
      "#!/bin/sh",
      '[ -e "$CLUSTER/unreachable" ] && exit 1',
      '[ -e "$CLUSTER/installed" ] && echo "secret/sh.helm.release.v1.cilium.v1"',
      "exit 0",
      "",
    ].join("\n"),
    cilium: '#!/bin/sh\necho "$@" >> "$CLUSTER/cilium"\n',
  };
  for (const [name, script] of Object.entries(tools)) {
    const path = join(directory.path, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
});

after(() => {
  directory.remove();
  cluster.remove();
});

/**
 * Run the install step against a cluster that has Cilium or doesn't.
 *
 * @param state
 * @returns its exit status, and what the CLI was asked to do
 */
function run(state: "installed" | "absent" | "unreachable"): { status: number | null; asked: string } {
  for (const file of ["installed", "unreachable", "cilium"]) rmSync(join(cluster.path, file), { force: true });
  if (state !== "absent") writeFileSync(join(cluster.path, state), "");

  const step = CiliumCommands.find((command) => command.name === "install-cilium") as TerminalCommandSpec;
  const command = step.command as (config: unknown) => string[];
  const result = spawnSync("sh", ["-c", command(configFrom({})).join("\n")], {
    env: { PATH: `${directory.path}:/usr/bin:/bin`, CLUSTER: cluster.path },
    encoding: "utf8",
  });
  let asked = "";
  try {
    asked = readFileSync(join(cluster.path, "cilium"), "utf8").trim();
  } catch {}
  return { status: result.status, asked };
}

describe("installing Cilium", () => {
  it("installs where there's no release", () => {
    const { status, asked } = run("absent");
    assert.equal(status, 0);
    assert.match(asked, /^install --version 1\.20\.1 --values /);
  });

  it("upgrades where there is one, with the same version and values", () => {
    const { status, asked } = run("installed");
    assert.equal(status, 0);
    assert.match(asked, /^upgrade --version 1\.20\.1 --values /);
  });

  it("does neither when it can't tell", () => {
    const { status, asked } = run("unreachable");
    assert.notEqual(status, 0);
    assert.equal(asked, "");
  });
});

describe("waiting for Cilium", () => {
  it("waits for the agents and the operator to finish rolling", () => {
    const step = CiliumCommands.find((command) => command.name === "wait-for-cilium") as TerminalCommandSpec;
    const script = (step.command as string[]).join("\n");
    assert.match(script, /rollout status daemonset\/cilium /);
    assert.match(script, /rollout status deployment\/cilium-operator /);
  });
});
