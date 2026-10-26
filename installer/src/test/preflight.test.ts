/**
 * @file
 * What preflight says about a configuration before anything is run.
 *
 * Every case here is a configuration somebody could plausibly write,
 * and the assertion is that the problem is named rather than that it
 * is merely detected — "2 nodes are servers" is a thing you can act
 * on, and "invalid configuration" isn't.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkConfiguration, findConfigurationWarnings } from "../runners/preflight.ts";
import { explainSudo } from "../cli/commands/Preflight.ts";
import { configFrom, loadFixtureConfig } from "./helpers.ts";

const SERVER = { name: "srv", address: "srv", type: "server" };
const AGENT = { name: "agent1", address: "agent1", type: "agent" };

/**
 * What preflight would complain about.
 */
function problems(raw: Record<string, unknown>): string[] {
  return checkConfiguration(configFrom(raw)).map((problem) => problem.what);
}

describe("a configuration preflight is happy with", () => {
  it("reports nothing for a server and an agent", () => {
    assert.deepEqual(problems({ k3s: { token: "t" }, nodes: [SERVER, AGENT] }), []);
  });

  it("accepts a plain shared secret as a token", () => {
    assert.deepEqual(problems({ k3s: { token: "any-old-secret" }, nodes: [SERVER] }), []);
  });

  it("accepts a token K3s itself issued", () => {
    assert.deepEqual(
      problems({ k3s: { token: `K10${"a".repeat(64)}::server:abc` }, nodes: [SERVER] }),
      [],
    );
  });

  it("reports nothing for a complete gateway setup", () => {
    assert.deepEqual(
      problems({
        k3s: { token: "t" },
        network: { gateway: { addresses: ["192.0.2.240"] } },
        nodes: [{ ...SERVER, gateway: true }],
      }),
      [],
    );
  });

  it("reports nothing for the fixture", async () => {
    // The fixture is what the rest of the suite builds on, so it had
    // better describe a cluster that could be installed
    assert.deepEqual(checkConfiguration(await loadFixtureConfig()), []);
  });
});

describe("what preflight catches", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    [
      "a package nothing provides, as when its plugin isn't loaded",
      { k3s: { token: "t" }, nodes: [SERVER], packages: { mastodon: true } },
      'enable the plugin under "plugins"',
    ],
    [
      "a display name that isn't text",
      { k3s: { token: "t" }, nodes: [{ ...SERVER, displayName: 7 }] },
      '"nodes[srv].displayName" should be text',
    ],
    [
      "two nodes displayed the same",
      {
        k3s: { token: "t" },
        nodes: [
          { ...SERVER, displayName: "Bangkok" },
          { ...AGENT, displayName: "Bangkok" },
        ],
      },
      "both displayed as",
    ],
    ["no nodes at all", { k3s: { token: "t" } }, "No nodes"],
    ["no server", { k3s: { token: "t" }, nodes: [AGENT] }, "no control plane"],
    [
      "two servers",
      { k3s: { token: "t" }, nodes: [SERVER, { ...SERVER, name: "srv2", address: "srv2" }] },
      "2 nodes are servers",
    ],
    ["no K3s token", { nodes: [SERVER] }, "No K3s token"],
    [
      "a token that looks structured and isn't",
      { k3s: { token: "K10not-really-a-ca-hash::server:secret" }, nodes: [SERVER] },
      "structured form",
    ],
    [
      "a node with no address",
      { k3s: { token: "t" }, nodes: [SERVER, { name: "x", type: "agent" }] },
      "no address",
    ],
    [
      "two nodes that would register under one name",
      {
        k3s: { token: "t" },
        nodes: [
          SERVER,
          { name: "Agent One", address: "dup", type: "agent" },
          { name: "Agent Two", address: "dup", type: "agent" },
        ],
      },
      "take over",
    ],
    [
      "a name Kubernetes won't take",
      {
        k3s: { token: "t" },
        nodes: [SERVER, { name: "Mamoru BKK", address: "10.0.0.5", type: "agent" }],
      },
      "its own hostname",
    ],
    [
      "a gateway node with nowhere for traffic to land",
      { k3s: { token: "t" }, nodes: [{ ...SERVER, gateway: true }] },
      "no addresses are configured",
    ],
    [
      "addresses with no gateway node to hold them",
      {
        k3s: { token: "t" },
        network: { gateway: { addresses: ["10.0.0.1"] } },
        nodes: [SERVER],
      },
      "no node is marked as a gateway",
    ],
  ];

  for (const [label, raw, fragment] of cases) {
    it(`names it: ${label}`, () => {
      const found = problems(raw);

      assert.ok(
        found.some((problem) => problem.includes(fragment)),
        found.join(" | ") || "nothing was reported",
      );
    });
  }
});

describe("whether a node's sudo will do", () => {
  const ask = (status: string, said: string) => explainSudo("deploy", { status, said });

  it("is happy when a shell runs as root without a password", () => {
    assert.equal(ask("0", "0"), undefined);
  });

  it("says when sudo runs as someone other than root", () => {
    assert.match(ask("0", "1001") ?? "", /uid 1001 rather than root/);
  });

  it("says when sudo wants a password, and how to stop it", () => {
    const problem = ask("1", "sudo: a password is required") ?? "";
    assert.match(problem, /asks for a password/);
    assert.match(problem, /deploy ALL=\(ALL\) NOPASSWD: ALL/);
  });

  it("recognises newer sudo's way of saying it wants a password", () => {
    assert.match(ask("1", "sudo: interactive authentication is required") ?? "", /asks for a password/);
  });

  it("says when sudo insists on a terminal", () => {
    assert.match(ask("1", "sudo: sorry, you must have a tty to run sudo") ?? "", /requiretty/);
  });

  it("says when the user isn't in sudoers", () => {
    assert.match(
      ask("1", "deploy is not in the sudoers file.  This incident will be reported.") ?? "",
      /can't use sudo on this node at all/,
    );
  });

  it("says when passwordless sudo only covers some commands", () => {
    assert.match(
      ask("1", "Sorry, user deploy is not allowed to execute '/bin/sh -c id -u' as root on node1.") ?? "",
      /only use sudo for some commands/,
    );
  });

  it("says when there's no sudo at all", () => {
    assert.match(ask("missing", "") ?? "", /isn't installed/);
  });

  it("passes on what sudo said when it's something unrecognised", () => {
    assert.match(ask("1", "sudo: something new") ?? "", /something new/);
  });
});

describe("what preflight warns about without stopping", () => {
  const warnings = (nebula: Record<string, unknown>) =>
    findConfigurationWarnings(
      configFrom({ k3s: { token: "t" }, nodes: [SERVER], network: { nebula } }),
    );

  it("says a Nebula network \"id\" is ignored, and what's used instead", () => {
    const [warning] = warnings({ id: "network-abc", network: "home" });

    assert.match(warning ?? "", /"network.nebula.id" isn't a setting/);
    assert.match(warning ?? "", /by its name, "home"/);
  });

  it("says when nothing is left to find the network by", () => {
    assert.match(warnings({ id: "network-abc" })[0] ?? "", /no way to find the network/);
  });

  it("says nothing when the ID is where it belongs", () => {
    assert.deepEqual(warnings({ networkID: "network-abc" }), []);
  });

  it("doesn't stop an install over it", () => {
    assert.deepEqual(
      checkConfiguration(configFrom({ k3s: { token: "t" }, nodes: [SERVER], network: { nebula: { id: "x", network: "home" } } })),
      [],
    );
  });
});
