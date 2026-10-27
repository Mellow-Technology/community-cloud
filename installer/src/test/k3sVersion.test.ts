/**
 * @file
 * Whether a node runs the K3s release the configuration pins.
 *
 * The check is shell asking kubectl, so it's run here for real against
 * a kubectl that answers with whatever version the test says the
 * kubelet reported.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { K3sCommands } from "../cli/commands/K3s.ts";
import { configFrom } from "./helpers.ts";

const NODE = { name: "agent-1", address: "agent-1.test", username: "someone", type: "agent" };
const PINNED = { k3s: { token: "t", version: "v1.36.5+k3s1" }, nodes: [NODE] };

const verify: any = K3sCommands.find((spec) => spec.name === "verify-k3s-version");

/**
 * Run the check against a cluster whose kubelet reports a version.
 *
 * @param reported
 * @returns
 */
function runAgainst(reported: string): { status: number | null; stdout: string; stderr: string } {
  const bin = mkdtempSync(join(tmpdir(), "k3s-version-"));

  try {
    const kubectl = join(bin, "kubectl");
    writeFileSync(kubectl, `#!/bin/sh\nprintf '%s' '${reported}'\n`);
    chmodSync(kubectl, 0o755);

    const shell = verify.command(configFrom(PINNED), { node: NODE, nodeName: NODE.name }).join("\n");
    const run = spawnSync("/bin/sh", ["-c", shell], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
    });

    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe("checking the K3s release", () => {
  it("is there to be asked", () => {
    assert.ok(verify);
    assert.equal(verify.purpose, "verify");
    assert.equal(verify.runOn, "control-plane");
    assert.equal(verify.scope, "each-node");
  });

  it("has nothing to compare when no version is pinned", () => {
    assert.equal(verify.skipWhen(configFrom({ k3s: { token: "t" }, nodes: [NODE] })), true);
    assert.equal(verify.skipWhen(configFrom({ k3s: { token: "t", channel: "stable" }, nodes: [NODE] })), true);
    assert.equal(verify.skipWhen(configFrom(PINNED)), false);
  });

  it("passes a node on the pinned release", () => {
    const run = runAgainst("v1.36.5+k3s1");

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /K3s v1\.36\.5\+k3s1/);
  });

  it("fails one left behind, and says what it is and what it should be", () => {
    const run = runAgainst("v1.35.4+k3s1");

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /agent-1 is running K3s v1\.35\.4\+k3s1, not v1\.36\.5\+k3s1/);
    assert.match(run.stderr, /"k3s\.version"/);
  });
});
