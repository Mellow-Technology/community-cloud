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

describe("the addresses a host gets on a dual-stack mesh", () => {
  const config = configFrom(ON_NEBULA);
  const step = (name: string) => NebulaCommands.find((command) => command.name === name) as any;
  const dualStack = {
    node: NODES[2],
    nebulaNetworkID: "network-1",
    nebulaNetworkCidrs: ["100.100.0.0/20", "fdef:c0:c0:6fc6:8f18::/80"],
    nebulaRoleIDs: { "Cluster Access": "role-1" },
  };

  it("asks for an IPv4 address when creating a host, since the API only gives IPv6 otherwise", () => {
    const body = step("create-nebula-host").body(config, dualStack);
    assert.deepEqual(body.ipAddresses, ["100.100.0.0/20"]);
  });

  it("asks for nothing in particular on an IPv6-only network", () => {
    const body = step("create-nebula-host").body(config, {
      ...dualStack,
      nebulaNetworkCidrs: ["fdef:c0:c0:93a0:a309::/80"],
    });
    assert.equal(body.ipAddresses, undefined);
  });

  it("gives an existing host with only IPv6 an IPv4 address, enrolled or not", () => {
    const add = step("add-nebula-ipv4-address");
    const ipv6Only = { ...dualStack, nebulaHostID: "host-1", nebulaIPAddresses: ["fdef:c0:c0:6fc6:8f18::1"] };

    assert.equal(add.skipWhen(config, ipv6Only, {}), false);
    assert.equal(add.skipWhen(config, { ...ipv6Only, dnclientEnrolled: true }, {}), false);
    assert.deepEqual(add.body(config, ipv6Only), { ipAddress: "100.100.0.0/20" });
    assert.equal(add.url(config, ipv6Only), "https://api.defined.net/v2/hosts/host-1/ip-addresses");
  });

  it("leaves a host that already has IPv4 alone, and one that doesn't exist yet", () => {
    const add = step("add-nebula-ipv4-address");
    assert.equal(add.skipWhen(config, { ...dualStack, nebulaHostID: "host-1", nebulaIPAddresses: ["100.100.0.4", "fdef::4"] }, {}), true);
    assert.equal(add.skipWhen(config, dualStack, {}), true);
  });

  it("restarts dnclient only on an enrolled node that was just given an address", () => {
    const refresh = step("refresh-nebula-config");
    assert.equal(refresh.skipWhen(config, { nebulaIPv4Added: true, dnclientEnrolled: true }, {}), false);
    assert.equal(refresh.skipWhen(config, { nebulaIPv4Added: true, dnclientEnrolled: false }, {}), true);
    assert.equal(refresh.skipWhen(config, { dnclientEnrolled: true }, {}), true);
  });

  it("finds an enrolled node's host whatever case its name is in", () => {
    const find = step("find-nebula-host");
    assert.notEqual(find.skipWhen(config, { ...dualStack, dnclientEnrolled: true }, {}), true);

    const found = find.saveToContext(
      { parsed: { data: [{ id: "host-3", name: "Three", ipAddresses: ["fdef::3"] }] } },
      { ...dualStack, dnclientEnrolled: true },
      config,
    );
    assert.equal(found.nebulaHostID, "host-3");
  });

  it("waits for the IPv4 address, the one K3s registers on", () => {
    const command = step("verify-nebula-host").command(config, { ...dualStack, nebulaIPAddresses: ["fdef::3", "100.100.0.9"] });
    const script = Array.isArray(command) ? command.join("\n") : command;
    assert.match(script, /on the mesh at 100\.100\.0\.9/);
  });
});
