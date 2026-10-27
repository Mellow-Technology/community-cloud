/**
 * @file
 * Keeping a namespace's pods in one region.
 *
 * Three parts have to agree for it to work at all: the node labels the
 * selector asks for, the API server plugin that applies the selector,
 * and the annotation on the namespace. Missing any one fails quietly,
 * with pods scheduled anywhere, so each is held here, and the check
 * that finds pods outside their region is run for real against a
 * stand-in kubectl.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { K3sCommands } from "../cli/commands/K3s.ts";
import { buildDesiredLabels } from "../cli/commands/NodeLabels.ts";
import { PlacementCommands } from "../cli/commands/Placement.ts";
import { checkConfiguration } from "../runners/preflight.ts";
import { buildPlacementServerArgs, getPlacement } from "../util/placement.ts";
import { configFrom } from "./helpers.ts";

const SERVER = { name: "cleverswing", address: "cleverswing", type: "server", region: "sea", zone: "sea-th-1" };
const FAR = { name: "brahma", address: "brahma", type: "agent", region: "eur", zone: "eur-de-1" };
const PLACED = { k3s: { token: "t" }, nodes: [SERVER, FAR], placement: { "cc-office": "sea" } };
const UNPLACED = { k3s: { token: "t" }, nodes: [SERVER, FAR] };

/**
 * A placement command, by name.
 *
 * @param name
 * @returns
 */
function command(name: string): any {
  return PlacementCommands.find((spec) => spec.name === name)!;
}

/**
 * What K3s is started with on the server.
 *
 * @param raw
 * @returns
 */
function serverExec(raw: Record<string, unknown>): string {
  const install: any = K3sCommands.find((spec) => spec.name === "install-k3s-server");
  return install.env(configFrom(raw), { node: SERVER, nodeName: SERVER.name }).INSTALL_K3S_EXEC;
}

/**
 * Run the check against a cluster described by what kubectl answers.
 *
 * @param annotation the namespace's node selector annotation
 * @param pods "pod node" lines
 * @returns
 */
function verifyAgainst(annotation: string, pods: string) {
  const bin = mkdtempSync(join(tmpdir(), "placement-"));

  try {
    const kubectl = join(bin, "kubectl");
    writeFileSync(
      kubectl,
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *"get nodes"*) printf 'cleverswing sea\\nguandi sea\\nbrahma eur\\n' ;;`,
        `  *"get namespace"*jsonpath*) printf '%s' '${annotation}' ;;`,
        '  *"get namespace"*) exit 0 ;;',
        `  *"get pods"*) printf '${pods}' ;;`,
        "esac",
      ].join("\n"),
    );
    chmodSync(kubectl, 0o755);

    const shell = command("verify-namespace-placement").command(configFrom(PLACED)).join("\n");
    const run = spawnSync("/bin/sh", ["-c", shell], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });

    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe("where a node says it is", () => {
  it("is labelled from its region and zone, as Kubernetes names them", () => {
    const labels = buildDesiredLabels({ node: FAR });

    assert.equal(labels["topology.kubernetes.io/region"], "eur");
    assert.equal(labels["topology.kubernetes.io/zone"], "eur-de-1");
  });

  it("isn't labelled with a place it didn't give", () => {
    const labels = buildDesiredLabels({ node: { name: "n", type: "agent" } });

    assert.equal(labels["topology.kubernetes.io/region"], undefined);
  });
});

describe("the API server enforcing placement", () => {
  it("turns on PodNodeSelector, keeping NodeRestriction, when anything is placed", () => {
    assert.match(serverExec(PLACED), /--kube-apiserver-arg=enable-admission-plugins=NodeRestriction,PodNodeSelector/);
  });

  it("leaves K3s's own admission plugins alone otherwise", () => {
    assert.doesNotMatch(serverExec(UNPLACED), /enable-admission-plugins/);
    assert.deepEqual(buildPlacementServerArgs(configFrom(UNPLACED)), []);
  });
});

describe("placing a namespace", () => {
  it("reads the namespaces and their regions", () => {
    assert.deepEqual(getPlacement(configFrom(PLACED)), { "cc-office": "sea" });
    assert.deepEqual(getPlacement(configFrom(UNPLACED)), {});
  });

  it("makes the namespace if it isn't there, then annotates it", () => {
    const shell = command("apply-namespace-placement").command(configFrom(PLACED)).join("\n");

    assert.match(shell, /kubectl create namespace 'cc-office'/);
    assert.match(shell, /'scheduler\.alpha\.kubernetes\.io\/node-selector=topology\.kubernetes\.io\/region=sea'/);
  });

  it("has nothing to do when nothing is placed", () => {
    assert.equal(command("apply-namespace-placement").skipWhen(configFrom(UNPLACED)), true);
    assert.equal(command("verify-namespace-placement").skipWhen(configFrom(UNPLACED)), true);
  });
});

describe("checking placement", () => {
  const SELECTOR = "topology.kubernetes.io/region=sea";

  it("passes a namespace annotated and running where it should be", () => {
    const run = verifyAgainst(SELECTOR, "plane-api guandi\\nplane-web cleverswing\\n");

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /cc-office: placed in sea/);
  });

  it("names the pods running outside the region", () => {
    const run = verifyAgainst(SELECTOR, "plane-api brahma\\nplane-web cleverswing\\n");

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /plane-api \(on brahma, in eur\)/);
    assert.doesNotMatch(run.stderr, /plane-web/);
  });

  it("fails a namespace without the annotation", () => {
    const run = verifyAgainst("", "plane-web cleverswing\\n");

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /annotated with "nothing"/);
  });
});

describe("what preflight says about placement", () => {
  it("refuses a region no node is in", () => {
    const problems = checkConfiguration(configFrom({ ...PLACED, placement: { "cc-office": "eas" } })).map((problem) => problem.what);

    assert.ok(problems.some((what) => what.includes("no node has \"region\": \"eas\"")), problems.join("\n"));
  });

  it("refuses a name that can't be a namespace", () => {
    const problems = checkConfiguration(configFrom({ ...PLACED, placement: { CC_Office: "sea" } })).map((problem) => problem.what);

    assert.ok(problems.some((what) => what.includes("isn't a namespace name")), problems.join("\n"));
  });

  it("accepts a namespace placed where a node is", () => {
    const problems = checkConfiguration(configFrom(PLACED)).map((problem) => problem.what);

    assert.ok(!problems.some((what) => what.includes("placement")), problems.join("\n"));
  });
});
