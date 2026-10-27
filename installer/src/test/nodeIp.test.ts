/**
 * @file
 * Which addresses a node registers on in the cluster.
 *
 * A cluster spread across sites only works if every node registers on
 * an address the others can reach, which on Nebula is its address on
 * the mesh rather than whatever its default route is. These cover where
 * that address comes from, that K3s is told it on both kinds of node,
 * and that a node registered elsewhere is noticed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { K3sCommands, getNodeIp } from "../cli/commands/K3s.ts";
import { API_KEY_ENV } from "../cli/commands/NebulaNetwork.ts";
import { checkConfiguration } from "../runners/preflight.ts";
import { configFrom } from "./helpers.ts";

const SERVER = { name: "server-1", address: "server-1.test", username: "someone", type: "server" };
const AGENT = { name: "agent-1", address: "agent-1.test", username: "someone", type: "agent" };

const ON_NEBULA = { k3s: { token: "t" }, nodes: [SERVER, AGENT], network: { nebula: { network: "home" } } };
const OFF_NEBULA = { k3s: { token: "t" }, nodes: [SERVER, AGENT] };

/**
 * A command in the k3s bundle, by name.
 *
 * @param name
 * @returns
 */
function command(name: string): any {
  const found = K3sCommands.find((spec) => spec.name === name);
  assert.ok(found, `no command called ${name}`);
  return found;
}

/**
 * What K3s is started with on a node.
 *
 * @param raw the configuration
 * @param context
 * @returns
 */
function installExec(raw: Record<string, unknown>, context: any): string {
  const spec = command(context.node.type === "server" ? "install-k3s-server" : "install-k3s-agent");
  return spec.env(configFrom(raw), context).INSTALL_K3S_EXEC;
}

/**
 * Run something with the Nebula API key's environment variable out of
 * the way, since a machine set up to use it would otherwise make every
 * configuration look like one on Nebula.
 *
 * @param work
 */
function withoutNebulaKey(work: () => void) {
  const saved = process.env[API_KEY_ENV];
  delete process.env[API_KEY_ENV];

  try {
    work();
  } finally {
    if (saved !== undefined) {
      process.env[API_KEY_ENV] = saved;
    }
  }
}

describe("the address a node registers on", () => {
  it("is left to K3s when nothing says otherwise", () => {
    const exec = installExec(OFF_NEBULA, { node: AGENT });
    assert.doesNotMatch(exec, /--node-ip/);
    assert.doesNotMatch(exec, /--node-external-ip/);
  });

  it("is the mesh address find-node-ip found", () => {
    assert.match(installExec(ON_NEBULA, { node: AGENT, nodeIp: "100.100.0.4" }), /^agent --node-ip=100\.100\.0\.4/);
  });

  it("is the configuration's nodeIp over anything found", () => {
    const node = { ...AGENT, nodeIp: "10.0.0.9" };
    assert.equal(getNodeIp({ node, nodeIp: "100.100.0.4" }), "10.0.0.9");
    assert.match(installExec(ON_NEBULA, { node, nodeIp: "100.100.0.4" }), /--node-ip=10\.0\.0\.9/);
  });

  it("is given to a server as well as an agent", () => {
    const exec = installExec(ON_NEBULA, { node: SERVER, nodeIp: "100.100.0.3" });
    assert.match(exec, /^server --node-ip=100\.100\.0\.3 /);

    // Alongside the networking only a server is given
    assert.match(exec, /--flannel-backend=none/);
  });

  it("comes with the external address when there is one", () => {
    const node = { ...AGENT, nodeExternalIp: "203.0.113.7" };
    const exec = installExec(ON_NEBULA, { node, nodeIp: "100.100.0.1" });
    assert.match(exec, /--node-ip=100\.100\.0\.1 --node-external-ip=203\.0\.113\.7/);
  });
});

describe("finding the address before installing", () => {
  const find = command("find-node-ip");

  it("doesn't look off Nebula with nothing configured", () => {
    withoutNebulaKey(() => {
      assert.equal(find.skipWhen(configFrom(OFF_NEBULA), { node: AGENT }), true);
    });
  });

  it("looks on the mesh interface on Nebula, and stops without one", () => {
    assert.equal(find.skipWhen(configFrom(ON_NEBULA), { node: AGENT }), false);

    const shell = find.command(configFrom(ON_NEBULA), { node: AGENT }).join("\n");
    assert.match(shell, /\^defined/);
    assert.match(shell, /exit 1/);
  });

  it("checks a configured address is one the node has", () => {
    const node = { ...AGENT, nodeIp: "10.0.0.9" };
    withoutNebulaKey(() => {
      assert.equal(find.skipWhen(configFrom(OFF_NEBULA), { node }), false);
    });

    const shell = find.command(configFrom(OFF_NEBULA), { node }).join("\n");
    assert.match(shell, /grep -qxF '10\.0\.0\.9'/);
    assert.doesNotMatch(shell, /defined/);
  });

  it("hands on what it found", () => {
    assert.deepEqual(find.saveToContext({ parsed: "100.100.0.4\n" }), { nodeIp: "100.100.0.4" });
  });

  it("changes nothing, so the doctor can ask it", () => {
    assert.equal(find.purpose, "require");
  });
});

describe("checking the node registered where it should", () => {
  const verify = command("verify-node-ip");

  it("has nothing to check when nothing was asked for", () => {
    assert.equal(verify.skipWhen(configFrom(OFF_NEBULA), { node: AGENT }), true);
  });

  it("asks the cluster for each address it was given", () => {
    const node = { ...AGENT, nodeExternalIp: "203.0.113.7" };
    const shell = verify.command(configFrom(ON_NEBULA), { node, nodeIp: "100.100.0.1" }).join("\n");

    assert.match(shell, /@\.type=="InternalIP"/);
    assert.match(shell, /' 100\.100\.0\.1 '/);
    assert.match(shell, /@\.type=="ExternalIP"/);
    assert.match(shell, /' 203\.0\.113\.7 '/);
  });

  it("runs kubectl on a server, once per node", () => {
    assert.equal(verify.runOn, "control-plane");
    assert.equal(verify.scope, "each-node");
  });
});

describe("what preflight says about node addresses", () => {
  /**
   * The configuration problems, as sentences.
   *
   * @param nodes
   * @returns
   */
  function problemsWith(nodes: unknown[]): string[] {
    return checkConfiguration(configFrom({ k3s: { token: "t" }, nodes })).map((problem) => problem.what);
  }

  it("accepts IPv4 and IPv6 addresses", () => {
    const nodes = [{ ...SERVER, nodeIp: "100.100.0.3" }, { ...AGENT, nodeIp: "fd00::4", nodeExternalIp: "203.0.113.7" }];
    assert.deepEqual(problemsWith(nodes), []);
  });

  it("refuses a name where an address goes", () => {
    const problems = problemsWith([SERVER, { ...AGENT, nodeExternalIp: "community-cloud.technology" }]);
    assert.ok(problems.some((problem) => problem.includes('"nodeExternalIp"') && problem.includes("isn't an IP address")));
  });

  it("refuses two nodes on one address", () => {
    const problems = problemsWith([{ ...SERVER, nodeIp: "100.100.0.3" }, { ...AGENT, nodeIp: "100.100.0.3" }]);
    assert.ok(problems.some((problem) => problem.includes("both register on 100.100.0.3")));
  });
});
