/**
 * @file
 * Adding a node to a cluster that already exists.
 *
 * The two things worth holding onto are what the pipeline leaves out
 * and what it refuses. Leaves out: everything that builds the cluster
 * rather than the node, because running those again against a live
 * cluster is at best wasted time and at worst a re-apply of a
 * configuration that has moved on. Refuses: a server, because growing
 * the control plane is a different operation and half-doing it is
 * worse than not starting.
 *
 * Nothing here connects to anything. The pipeline is planned on paper,
 * which is exactly what --dry-run does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ADD_NODE_PIPELINE, addNode } from "../runners/addNode.ts";
import { CommandTarget } from "../cli/commands/Command.ts";
import { INSTALL_PIPELINE } from "../runners/install.ts";
import { buildPlan } from "../pipeline/plan.ts";
import { getBundleNames } from "../cli/commands/bundles.ts";
import { paperFleet } from "../pipeline/fleet.ts";
import { FIXTURE_CONFIG, configFrom, withoutConsole } from "./helpers.ts";

// A cluster with a server already in it and an agent waiting to join
const CONFIG = configFrom({
  k3s: { token: "t" },
  nodes: [
    { name: "one", address: "one", type: "server" },
    { name: "two", address: "two", type: "agent", roles: ["worker"] },
  ],
});

// What the install does to build the cluster itself, as opposed to
// what it does to a machine
const CLUSTER_WIDE = ["cilium", "gateway", "helm", "helm-charts", "cluster"];

describe("the bundles adding a node runs", () => {
  it("names only bundles that exist", () => {
    const missing = ADD_NODE_PIPELINE.filter((name) => !getBundleNames().includes(name));

    assert.deepEqual(missing, []);
  });

  it("leaves out everything that builds the cluster", () => {
    const rebuilding = ADD_NODE_PIPELINE.filter((name) => CLUSTER_WIDE.includes(name));

    assert.deepEqual(rebuilding, [], "these have already happened and shouldn't happen again");
  });

  it("keeps everything that makes a machine a member", () => {
    const perNode = INSTALL_PIPELINE.filter((name) => !CLUSTER_WIDE.includes(name));
    const dropped = perNode.filter((name) => !ADD_NODE_PIPELINE.includes(name));

    assert.deepEqual(dropped, []);
  });

  it("checks the cluster is up first, and that the node joined last", () => {
    assert.equal(ADD_NODE_PIPELINE[0], "cluster-online");
    assert.equal(ADD_NODE_PIPELINE[ADD_NODE_PIPELINE.length - 1], "node-joined");
  });
});

describe("the plan for adding one agent", () => {
  const plan = buildPlan(CONFIG, ADD_NODE_PIPELINE.join(","), paperFleet(CONFIG, ["two"]));

  it("installs an agent and not a server", () => {
    const names = plan.steps.map((step) => step.command.name);

    assert.ok(names.includes("install-k3s-agent"));
    assert.ok(
      !names.includes("install-k3s-server"),
      "there is already a server, and this isn't it",
    );
  });

  it("does everything to the new node and nothing to the old one", () => {
    // Apart from the cluster-wide checks, which have to run from a
    // server because that is where kubectl is
    const elsewhere = plan.steps.filter(
      (step) => step.nodes.includes("one") && step.runOn !== CommandTarget.ControlPlane,
    );

    assert.deepEqual(elsewhere, []);
  });

  it("asks the cluster whether it is up, from the server", () => {
    const check = plan.steps.find((step) => step.command.name === "check-cluster-online");

    assert.deepEqual(check?.nodes, ["one"]);
  });

  it("labels the new node, from the server", () => {
    const labelling = plan.steps.find((step) => step.command.name === "apply-node-labels");

    assert.deepEqual(labelling?.nodes, ["two"], "the labels are about the node being added");
    assert.equal(labelling?.runOn, CommandTarget.ControlPlane, "kubectl lives on a server");
  });
});

describe("what add-node refuses", () => {
  /**
   * What adding this node says, when it says no.
   */
  async function refusal(nodeName: string): Promise<string> {
    try {
      await withoutConsole(() =>
        addNode(nodeName, FIXTURE_CONFIG, { dryRun: true }),
      );
    } catch (error: any) {
      return error.message;
    }

    return "";
  }

  it("won't add a server, and says why", async () => {
    // Growing the control plane means moving the datastore from one
    // member to several, which is not this
    assert.match(await refusal("server-1"), /can only add agents/);
  });

  it("won't add a node the configuration has never heard of", async () => {
    const message = await refusal("nowhere");

    assert.match(message, /no node called "nowhere"/);
    assert.match(message, /server-1/, "it should say what there is");
  });
});
