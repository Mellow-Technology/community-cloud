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

import { checkConfiguration } from "../runners/preflight.ts";
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
