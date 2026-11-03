/**
 * @file
 * Putting nodes on the Nebula mesh as part of install and add-node.
 *
 * Both run the enrolment bundle on every node, so most of what matters
 * is what happens on a cluster without a mesh: nothing at all, however
 * the person running the installer has their environment set up. On a
 * cluster with one, enrolment comes before K3s, so K3s finds each
 * node's mesh address (covered in nodeIp.test.ts), and the mesh's roles
 * are made once for the cluster rather than raced for by every node.
 *
 * Nothing here connects to anything; the pipelines are planned on
 * paper, as --dry-run does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CommandScope } from "../cli/commands/Command.ts";
import { NebulaCommands } from "../cli/commands/Nebula.ts";
import { API_KEY_ENV, NebulaNetworkCommands, usesNebula } from "../cli/commands/NebulaNetwork.ts";
import { ADD_NODE_PIPELINE } from "../runners/addNode.ts";
import { INSTALL_PIPELINE } from "../runners/install.ts";
import { checkConfiguration } from "../runners/preflight.ts";
import { buildPlan } from "../pipeline/plan.ts";
import { paperFleet } from "../pipeline/fleet.ts";
import { configFrom } from "./helpers.ts";

const NODES = [
  { name: "one", address: "one", type: "server" },
  { name: "two", address: "two", type: "agent", roles: ["worker"] },
  { name: "three", address: "three", type: "agent", roles: ["worker"] },
];
const MESH = { network: "home", apiKey: "k", roles: [{ name: "Cluster Access" }] };
const ON_NEBULA = { k3s: { token: "t" }, nodes: NODES, network: { nebula: MESH } };
const OFF_NEBULA = { k3s: { token: "t" }, nodes: NODES };

/**
 * Run some work with the Defined Networking key in the environment set
 * to this, or unset.
 *
 * @param key
 * @param work
 */
function withKeyInEnvironment(key: string | undefined, work: () => void) {
  const saved = process.env[API_KEY_ENV];
  if (key === undefined) {
    delete process.env[API_KEY_ENV];
  } else {
    process.env[API_KEY_ENV] = key;
  }

  try {
    work();
  } finally {
    if (saved === undefined) {
      delete process.env[API_KEY_ENV];
    } else {
      process.env[API_KEY_ENV] = saved;
    }
  }
}

/**
 * Where a step comes in a pipeline.
 *
 * @param pipeline
 * @param bundle
 * @returns
 */
const at = (pipeline: string[], bundle: string) => pipeline.indexOf(bundle);

describe("whether a cluster is on Nebula", () => {
  it("is the configuration naming a network, by name or ID", () => {
    assert.equal(usesNebula(configFrom(ON_NEBULA)), true);
    assert.equal(usesNebula(configFrom({ ...OFF_NEBULA, network: { nebula: { networkID: "network-1" } } })), true);
    assert.equal(usesNebula(configFrom(OFF_NEBULA)), false);
  });

  it("isn't turned on by a key in the environment of whoever runs the installer", () => {
    withKeyInEnvironment("from-my-shell", () => {
      assert.equal(usesNebula(configFrom(OFF_NEBULA)), false);
    });
  });

  it("isn't turned on by a key in the configuration without a network", () => {
    assert.equal(usesNebula(configFrom({ ...OFF_NEBULA, network: { nebula: { apiKey: "k" } } })), false);
  });
});

describe("enrolling a node on a cluster without a mesh", () => {
  it("skips every step: no API calls, and no dnclient", () => {
    const config = configFrom(OFF_NEBULA);
    withKeyInEnvironment("from-my-shell", () => {
      const running = NebulaCommands.filter((command) => command.skipWhen?.(config, { node: NODES[1] }, {}) !== true);
      assert.deepEqual(running.map((command) => command.name), []);
    });
  });

  it("isn't in the plan at all, so a dry run doesn't list it", () => {
    const config = configFrom({ ...OFF_NEBULA, network: { nebula: { roles: [{ name: "Cluster Access" }] } } });
    withKeyInEnvironment("from-my-shell", () => {
      const plan = buildPlan(config, INSTALL_PIPELINE.join(","), paperFleet(config, ["one", "two", "three"]));
      assert.deepEqual(plan.steps.filter((step) => step.bundle.startsWith("nebula")), []);
    });
  });

  it("skips the cluster's roles as well", () => {
    const config = configFrom({ ...OFF_NEBULA, network: { nebula: { roles: [{ name: "Cluster Access" }] } } });
    const running = NebulaNetworkCommands(config).filter((command) => command.skipWhen?.(config, {}, {}) !== true);
    assert.deepEqual(running.map((command) => command.name), []);
  });

  it("still skips what it would skip anyway on a cluster with one", () => {
    const config = configFrom(ON_NEBULA);
    const enrol = NebulaCommands.find((command) => command.name === "enroll-nebula-host");
    assert.equal(enrol?.skipWhen?.(config, { dnclientEnrolled: true }, {}), true);
    assert.equal(enrol?.skipWhen?.(config, { dnclientEnrolled: false }, {}), false);
  });
});

describe("the mesh in install and add-node", () => {
  it("is set up once, then every node is enrolled, before K3s, in an install", () => {
    assert.ok(at(INSTALL_PIPELINE, "nebula-network") > at(INSTALL_PIPELINE, "base"));
    assert.ok(at(INSTALL_PIPELINE, "nebula") > at(INSTALL_PIPELINE, "nebula-network"));
    assert.ok(at(INSTALL_PIPELINE, "nebula") < at(INSTALL_PIPELINE, "k3s"));
  });

  it("enrols the new node before K3s when adding one, and leaves the cluster's roles alone", () => {
    assert.ok(at(ADD_NODE_PIPELINE, "nebula") > at(ADD_NODE_PIPELINE, "base"));
    assert.ok(at(ADD_NODE_PIPELINE, "nebula") < at(ADD_NODE_PIPELINE, "k3s"));
    assert.equal(at(ADD_NODE_PIPELINE, "nebula-network"), -1);
  });

  it("makes each role once for the cluster, not once per node", () => {
    const config = configFrom(ON_NEBULA);
    const plan = buildPlan(config, INSTALL_PIPELINE.join(","), paperFleet(config, ["one", "two", "three"]));
    const roleSteps = plan.steps.filter((step) => step.bundle === "nebula-network");

    assert.ok(roleSteps.some((step) => step.command.name === "create-nebula-role-cluster-access"));
    for (const step of roleSteps) {
      assert.equal(step.scope, CommandScope.Cluster, `${step.command.name} runs for the cluster`);
      assert.equal(step.nodes.length, 1, `${step.command.name} runs once`);
    }
  });

  it("enrols every node in an install", () => {
    const config = configFrom(ON_NEBULA);
    const plan = buildPlan(config, INSTALL_PIPELINE.join(","), paperFleet(config, ["one", "two", "three"]));
    const enrol = plan.steps.find((step) => step.command.name === "enroll-nebula-host");

    assert.deepEqual([...(enrol?.nodes ?? [])].sort(), ["one", "three", "two"]);
  });

  it("enrols only the new node when adding one", () => {
    const config = configFrom(ON_NEBULA);
    // Planned for the new node alone, as add-node does; the server is
    // brought in for the checks that ask the cluster
    const plan = buildPlan(config, ADD_NODE_PIPELINE.join(","), paperFleet(config, ["two"]));
    const enrolling = plan.steps.filter((step) => step.bundle === "nebula");

    assert.ok(enrolling.length > 0);
    for (const step of enrolling) {
      assert.ok(!step.nodes.includes("one"), `${step.command.name} leaves the server alone`);
    }
  });
});

describe("what preflight says about the mesh", () => {
  const problems = (raw: Record<string, unknown>) => checkConfiguration(configFrom(raw)).map((problem) => problem.what);

  it("stops a network with no key to enrol nodes with", () => {
    withKeyInEnvironment(undefined, () => {
      const found = problems({ ...OFF_NEBULA, network: { nebula: { network: "home" } } });
      assert.ok(found.some((what) => what.includes("no Defined Networking API key")), found.join("\n"));
    });
  });

  it("takes the key from the environment", () => {
    withKeyInEnvironment("from-my-shell", () => {
      const found = problems({ ...OFF_NEBULA, network: { nebula: { network: "home" } } });
      assert.ok(!found.some((what) => what.includes("nebula")), found.join("\n"));
    });
  });

  it("says when settings name no network, so nothing is put on a mesh", () => {
    const found = problems({ ...OFF_NEBULA, network: { nebula: { apiKey: "k" } } });
    assert.ok(found.some((what) => what.includes('no "network" or "networkID"')), found.join("\n"));
  });

  it("says nothing about a cluster that doesn't use one", () => {
    const found = problems(OFF_NEBULA);
    assert.ok(!found.some((what) => what.includes("nebula")), found.join("\n"));
  });
});
