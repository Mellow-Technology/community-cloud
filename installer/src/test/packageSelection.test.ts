/**
 * @file
 * Running only some of the configured packages, with --packages.
 *
 * For upgrading a few at a time: the chosen packages keep their place
 * in the install order, what they need is checked for rather than
 * installed with them, and the cluster-wide steps every package relies
 * on — finding Helm, reading the storage shapes — still come first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPlan } from "../pipeline/plan.ts";
import { paperFleet } from "../pipeline/fleet.ts";
import { readPackageList } from "../runners/runPipeline.ts";
import { configFrom } from "./helpers.ts";

const config = configFrom({
  k3s: { token: "t" },
  nodes: [{ name: "one", address: "one", type: "server" }],
  packages: { "cert-manager": true, "cloudnative-pg": true },
});

/**
 * The steps helm-charts would take, with or without a selection.
 *
 * @param packages
 * @returns
 */
const steps = (packages?: string[]) =>
  buildPlan(config, "helm-charts", paperFleet(config, ["one"]), packages !== undefined ? { packages } : {})
    .steps.map((step) => step.command.name);

describe("choosing packages for helm-charts", () => {
  it("installs everything configured when none are chosen", () => {
    const all = steps();
    for (const name of ["cert-manager", "topolvm", "cloudnative-pg"]) {
      assert.ok(all.includes(`helm-install-${name}`), name);
    }
  });

  it("installs only the chosen ones", () => {
    const chosen = steps(["topolvm"]);
    assert.ok(chosen.includes("helm-install-topolvm"));
    assert.ok(!chosen.includes("helm-install-cert-manager"));
    assert.ok(!chosen.includes("helm-install-cloudnative-pg"));
  });

  it("still finds Helm and reads the storage shapes first", () => {
    const chosen = steps(["topolvm"]);
    assert.deepEqual(chosen.slice(0, 2), ["check-helm-available", "read-storage-shapes"]);
  });

  it("checks for what a chosen package needs instead of installing it", () => {
    const chosen = steps(["topolvm"]);
    assert.ok(chosen.indexOf("require-cluster-topolvm") < chosen.indexOf("helm-install-topolvm"));
  });

  it("doesn't check for a need that's being installed in the same run", () => {
    const chosen = steps(["topolvm", "cloudnative-pg"]);
    assert.ok(!chosen.includes("require-cluster-cloudnative-pg"));
  });

  it("keeps the install order, whatever order they were named in", () => {
    const chosen = steps(["cloudnative-pg", "topolvm"]);
    assert.ok(chosen.indexOf("helm-install-topolvm") < chosen.indexOf("helm-install-cloudnative-pg"));
  });

  it("refuses a package the configuration doesn't install, and says which it does", () => {
    assert.throws(() => steps(["topolvn"]), /"topolvn" isn't a package.*cert-manager, topolvm, cloudnative-pg/);
  });
});

describe("reading --packages", () => {
  it("splits on commas and drops spaces", () => {
    assert.deepEqual(readPackageList(" topolvm, authentik ,"), ["topolvm", "authentik"]);
  });

  it("is nothing when not given", () => {
    assert.equal(readPackageList(undefined), undefined);
  });

  it("refuses a list with nothing in it", () => {
    assert.throws(() => readPackageList(" , "), /no package names/);
  });
});
