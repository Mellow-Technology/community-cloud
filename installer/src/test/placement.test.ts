/**
 * @file
 * Keeping a namespace's pods in one region.
 *
 * Three parts have to agree for it to work at all: the node labels the
 * affinity asks for, the admission policy that gives pods the affinity,
 * and the labels on the namespace. Missing any one fails quietly, with
 * pods scheduled anywhere, so each is held here, and the check that
 * finds pods outside their region is run for real against a stand-in
 * kubectl. What the policy does to a pod is CEL that only an API server
 * runs, so it was tried against K3s 1.36 rather than here; what's held
 * here is the shape around it.
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
import { parseAllDocuments } from "yaml";

import { buildPlacementPolicy, getPlacement } from "../util/placement.ts";
import { configFrom } from "./helpers.ts";

const SERVER = { name: "cleverswing", address: "cleverswing", type: "server", region: "sea", zone: "sea-th-1" };
const FAR = { name: "brahma", address: "brahma", type: "agent", region: "eur", zone: "eur-de-1" };
const PLACED = { k3s: { token: "t" }, nodes: [SERVER, FAR], placement: { "cc-office": "sea" } };
const PREFERRED = { ...PLACED, placement: { "cc-office": { region: "sea", affinity: "preferred" } } };
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
 * @param cluster
 * @param cluster.labels the namespace's region and affinity labels, as "region affinity"
 * @param cluster.pods "pod node own-region" lines
 * @param cluster.legacy PodNodeSelector's annotation, if it's still there
 * @param cluster.policy whether the policy and binding are there
 * @param raw the configuration
 * @returns
 */
function verifyAgainst(
  { labels, pods, legacy = "", policy = true }: { labels: string; pods: string; legacy?: string; policy?: boolean },
  raw: Record<string, unknown> = PLACED,
) {
  const bin = mkdtempSync(join(tmpdir(), "placement-"));

  try {
    const kubectl = join(bin, "kubectl");
    writeFileSync(
      kubectl,
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *"get mutatingadmissionpolicy"*) exit ${policy ? 0 : 1} ;;`,
        `  *"get nodes"*) printf 'cleverswing sea\\nguandi sea\\nbrahma eur\\n' ;;`,
        `  *"get namespace"*annotations*) printf '%s' '${legacy}' ;;`,
        `  *"get namespace"*labels*) printf '%s' '${labels}' ;;`,
        '  *"get namespace"*) exit 0 ;;',
        `  *"get pods"*) printf '${pods}' ;;`,
        "esac",
      ].join("\n"),
    );
    chmodSync(kubectl, 0o755);

    const shell = command("verify-namespace-placement").command(configFrom(raw)).join("\n");
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

describe("the policy that places pods", () => {
  const [policy, binding] = parseAllDocuments(buildPlacementPolicy()).map((document) => document.toJS());

  it("leaves K3s's admission plugins alone, now nothing needs turning on", () => {
    assert.doesNotMatch(serverExec(PLACED), /enable-admission-plugins/);
  });

  it("acts on pods as they're made, and fails closed", () => {
    assert.equal(policy.kind, "MutatingAdmissionPolicy");
    assert.deepEqual(policy.spec.matchConstraints.resourceRules[0].resources, ["pods"]);
    assert.deepEqual(policy.spec.matchConstraints.resourceRules[0].operations, ["CREATE"]);
    assert.equal(policy.spec.failurePolicy, "Fail");
  });

  it("is bound to namespaces with a region, and no others", () => {
    assert.equal(binding.spec.policyName, policy.metadata.name);
    assert.deepEqual(binding.spec.matchResources.namespaceSelector.matchExpressions, [
      { key: "placement.community-cloud.technology/region", operator: "Exists" },
    ]);
  });

  it("leaves out exempt pods and pods with a region of their own", () => {
    const conditions = policy.spec.matchConditions.map((condition: any) => condition.expression).join("\n");

    assert.match(conditions, /placement\.community-cloud\.technology\/exempt'\]\.orValue\(''\) != 'true'/);
    assert.match(conditions, /'topology\.kubernetes\.io\/region' in object\.spec\.nodeSelector/);
  });

  it("reads the region and affinity off the namespace, required unless it says otherwise", () => {
    const variables: any = Object.fromEntries(policy.spec.variables.map((variable: any) => [variable.name, variable.expression]));

    assert.match(variables.region, /namespaceObject\.metadata\.labels\['placement\.community-cloud\.technology\/region'\]/);
    assert.match(variables.preferred, /affinity'\]\.orValue\('required'\) == 'preferred'/);
  });
});
describe("placing a namespace", () => {
  it("reads the namespaces, their regions and affinities", () => {
    assert.deepEqual(getPlacement(configFrom(PLACED)), { "cc-office": { region: "sea", affinity: "required" } });
    assert.deepEqual(getPlacement(configFrom(PREFERRED)), { "cc-office": { region: "sea", affinity: "preferred" } });
    assert.deepEqual(getPlacement(configFrom(UNPLACED)), {});
  });

  it("makes the namespace if it isn't there, labels it, and takes PodNodeSelector's annotation off", () => {
    const shell = command("apply-namespace-placement").command(configFrom(PREFERRED)).join("\n");

    assert.match(shell, /kubectl create namespace 'cc-office'/);
    assert.match(shell, /'placement\.community-cloud\.technology\/region=sea' 'placement\.community-cloud\.technology\/affinity=preferred'/);
    assert.match(shell, /annotate namespace 'cc-office' 'scheduler\.alpha\.kubernetes\.io\/node-selector-'/);
  });

  it("applies the policy even when nothing is placed, for namespaces placed from Meteorologist", () => {
    assert.equal(command("apply-placement-policy").skipWhen, undefined);
    assert.equal(command("verify-namespace-placement").skipWhen, undefined);
    assert.equal(command("apply-namespace-placement").skipWhen(configFrom(UNPLACED)), true);
  });
});

describe("checking placement", () => {
  const LABELS = "sea required";

  it("passes a namespace labelled and running where it should be", () => {
    const run = verifyAgainst({ labels: LABELS, pods: "plane-api guandi \\nplane-web cleverswing \\n" });

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /cc-office: placed in sea \(required\)/);
  });

  it("names the pods running outside the region", () => {
    const run = verifyAgainst({ labels: LABELS, pods: "plane-api brahma \\nplane-web cleverswing \\n" });

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /plane-api \(on brahma, in eur\)/);
    assert.doesNotMatch(run.stderr, /plane-web/);
  });

  it("lets a pod that chose its own region be elsewhere", () => {
    const run = verifyAgainst({ labels: LABELS, pods: "backup brahma eur\\n" });

    assert.equal(run.status, 0, run.stderr);
  });

  it("only mentions pods outside a region the namespace merely prefers", () => {
    const run = verifyAgainst({ labels: "sea preferred", pods: "plane-api brahma \\n" }, PREFERRED);

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /prefers sea, but running outside it: plane-api \(on brahma, in eur\)/);
  });

  it("fails a namespace without the labels", () => {
    const run = verifyAgainst({ labels: " ", pods: "plane-web cleverswing \\n" });

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /labelled "", not "sea required"/);
  });

  it("fails a namespace labelled with the wrong affinity", () => {
    const run = verifyAgainst({ labels: "sea preferred", pods: "" });

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /labelled "sea preferred", not "sea required"/);
  });

  it("fails a namespace that still has PodNodeSelector's annotation", () => {
    const run = verifyAgainst({ labels: LABELS, pods: "", legacy: "topology.kubernetes.io/region=sea" });

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /still has PodNodeSelector's annotation/);
  });

  it("fails when the policy isn't there", () => {
    const run = verifyAgainst({ labels: LABELS, pods: "", policy: false });

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /admission policy or its binding is missing/);
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

  it("refuses an affinity that isn't required or preferred", () => {
    const problems = checkConfiguration(configFrom({ ...PLACED, placement: { "cc-office": { region: "sea", affinity: "strict" } } })).map((problem) => problem.what);

    assert.ok(problems.some((what) => what.includes("isn't one of \"required\" or \"preferred\"")), problems.join("\n"));
  });

  it("accepts a namespace placed where a node is", () => {
    const problems = checkConfiguration(configFrom(PLACED)).map((problem) => problem.what);

    assert.ok(!problems.some((what) => what.includes("placement")), problems.join("\n"));
  });
});
