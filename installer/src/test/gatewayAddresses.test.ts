/**
 * @file
 * The addresses the cluster Gateway listens on, and keeping them in
 * step with the pool when a node is added.
 *
 * The pool and the Gateway are built from one reading of the
 * configuration, and the Gateway is only programmed when every address
 * it asks for is in the pool. So what matters is which addresses the
 * Gateway asks for: the single ones, never a whole range, and nothing
 * at all when there's no pool to take them from.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";

import { getListenAddresses } from "../util/gateway.ts";
import { renderInstallerFile } from "../util/template.ts";
import { GatewayAddressCommands, GatewayCommands, buildIPPool } from "../cli/commands/GatewayNodes.ts";
import { ADD_NODE_PIPELINE } from "../runners/addNode.ts";
import { INSTALL_PIPELINE } from "../runners/install.ts";
import { configFrom } from "./helpers.ts";

/**
 * A cluster with two gateway nodes and the given gateway section.
 *
 * @param network
 * @returns
 */
function clusterWith(network: Record<string, unknown>) {
  return configFrom({
    network,
    nodes: [
      { name: "one", address: "one", type: "server", gateway: true },
      { name: "two", address: "two", type: "agent", gateway: true },
    ],
  });
}

/**
 * The cluster Gateway, rendered for a configuration.
 *
 * @param config
 * @returns
 */
function renderGateway(config: ReturnType<typeof configFrom>) {
  return parseAllDocuments(renderInstallerFile(config, "embed://networking/cilium/gateway/Gateway.yaml"))
    .map((document) => document.toJS())
    .find((document) => document?.kind === "Gateway");
}

describe("the addresses the Gateway listens on", () => {
  it("is every single address, written any way", () => {
    const config = clusterWith({
      gateway: { addresses: ["203.0.113.10", "203.0.113.11/32", "203.0.113.12-203.0.113.12", "2001:db8::1/128"] },
    });

    assert.deepEqual(getListenAddresses(config), ["203.0.113.10", "203.0.113.11", "203.0.113.12", "2001:db8::1"]);
  });

  it("includes an address pinned to a gateway node, once", () => {
    const config = clusterWith({
      gateway: { addresses: ["203.0.113.10"] },
      externalIPs: { two: "198.51.100.7", one: "203.0.113.10" },
    });

    assert.deepEqual(getListenAddresses(config), ["203.0.113.10", "198.51.100.7"]);
  });

  it("leaves ranges and wider CIDRs to the pool", () => {
    const config = clusterWith({
      gateway: { addresses: ["192.168.1.240-192.168.1.250", "10.0.0.0/29", "203.0.113.10"] },
    });

    assert.deepEqual(getListenAddresses(config), ["203.0.113.10"]);
  });

  it("is nothing when there's no gateway node, since there's no pool either", () => {
    const config = configFrom({
      network: { gateway: { addresses: ["203.0.113.10"] } },
      nodes: [{ name: "one", address: "one", type: "server" }],
    });

    assert.deepEqual(getListenAddresses(config), []);
  });
});

describe("the cluster Gateway", () => {
  it("asks for each address, and every one of them is in the pool", () => {
    const config = clusterWith({ gateway: { addresses: ["203.0.113.10", "198.51.100.7"] } });
    const gateway = renderGateway(config);

    assert.deepEqual(gateway.spec.addresses, [
      { type: "IPAddress", value: "203.0.113.10" },
      { type: "IPAddress", value: "198.51.100.7" },
    ]);

    const pool = parseAllDocuments(buildIPPool(config))[0]!.toJS();
    const pooled = pool.spec.blocks.map((block: any) => block.cidr);
    for (const { value } of gateway.spec.addresses) {
      assert.ok(pooled.includes(`${value}/32`), `${value} is on the Gateway but not in the pool`);
    }
  });

  it("asks for nothing when there's no single address, and Cilium chooses", () => {
    const ranged = renderGateway(clusterWith({ gateway: { addresses: ["192.168.1.240-192.168.1.250"] } }));
    const bare = renderGateway(configFrom({ nodes: [{ name: "one", address: "one", type: "server" }] }));

    assert.equal(ranged.spec.addresses, undefined);
    assert.equal(bare.spec.addresses, undefined);
    assert.equal(bare.spec.gatewayClassName, "cilium");
  });
});

describe("adding a node", () => {
  it("brings the pool and the Gateway up to date, after the node is labelled", () => {
    assert.ok(ADD_NODE_PIPELINE.includes("gateway-addresses"));
    assert.ok(ADD_NODE_PIPELINE.indexOf("gateway-addresses") > ADD_NODE_PIPELINE.indexOf("nodeLabels"));
  });

  it("applies the addresses without touching the nodes", () => {
    const names = GatewayAddressCommands.map((command) => command.name);

    for (const step of ["apply-lb-ip-pool", "apply-cluster-gateway", "verify-gateway", "verify-cluster-gateway"]) {
      assert.ok(names.includes(step), step);
    }
    assert.ok(!names.includes("label-gateway-nodes"), "nodeLabels labels the new node; labelling every gateway fails on one not added yet");
    assert.ok(!names.includes("check-gateway-interfaces"), "preflight already checks the new node");
    assert.ok(GatewayAddressCommands.length < GatewayCommands.length);
  });

  it("is something an install doesn't need, since it runs the whole gateway bundle", () => {
    assert.ok(INSTALL_PIPELINE.includes("gateway"));
    assert.ok(!INSTALL_PIPELINE.includes("gateway-addresses"));
  });
});
