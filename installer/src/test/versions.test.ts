/**
 * @file
 * The pinned versions, and what it takes to get something else.
 *
 * Cilium, its CLI and the Gateway API are pinned deliberately: a
 * mismatched pair of them fails quietly, with the operator disabling
 * a feature rather than saying anything. So the assertions here are
 * that nothing reaches the network to decide what to install, and that
 * floating is something a configuration has to ask for by name.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import CloudConfig from "../util/CloudConfig.ts";
import TerminalCommand from "../cli/commands/TerminalCommand.ts";
import { CiliumCommands } from "../cli/commands/Cilium.ts";
import { configFrom } from "./helpers.ts";

/**
 * A configuration saying this much about Cilium.
 */
function makeConfig(cilium: Record<string, unknown>): CloudConfig {
  return configFrom({
    network: { cilium },
    nodes: [{ name: "server-1", address: "server-1.test", type: "server" }],
  });
}

/**
 * Build one Cilium command without running it.
 *
 * @param name
 * @param config
 * @returns the shell it would have run
 */
async function build(name: string, config: CloudConfig): Promise<string> {
  const spec: any = CiliumCommands.find((command: any) => command.name === name);

  assert.ok(spec !== undefined, `there is no command called "${name}"`);

  const command = new TerminalCommand(spec);
  let seen = "";

  command.setQuiet(true);
  command.setExecFunction(async (built: string) => {
    seen = built;
    return { stdout: "", stderr: "" };
  });

  await command.exec(
    config,
    { nodeName: "server-1" },
    { "get-cilium-cli-version": { stdout: "v0.20.0", stderr: "", parsed: "v0.20.0" } },
  );

  return seen;
}

describe("with nothing configured", () => {
  const config = makeConfig({});

  it("pins the CLI version", async () => {
    assert.equal((await build("get-cilium-cli-version", config)).trim(), "echo 'v0.20.0'");
  });

  it("fetches nothing to find it", async () => {
    assert.ok(!(await build("get-cilium-cli-version", config)).includes("curl"));
  });

  it("pins Cilium itself", async () => {
    assert.match(await build("install-cilium", config), /--version '1\.20\.1'/);
  });

  it("pins the Gateway API", async () => {
    assert.match(await build("install-gateway-api", config), /\/v1\.6\.1\//);
  });

  it("takes every Gateway API resource from that one release", async () => {
    const text = await build("install-gateway-api", config);
    const releases = new Set(text.match(/gateway-api\/v[0-9.]+\//g) ?? []);

    assert.deepEqual([...releases], ["gateway-api/v1.6.1/"]);
  });
});

describe("with versions configured", () => {
  const config = makeConfig({
    version: "1.19.6",
    cliVersion: "v0.19.7",
    gatewayApiVersion: "v1.4.1",
  });

  it("uses the configured CLI version", async () => {
    assert.match(await build("get-cilium-cli-version", config), /v0\.19\.7/);
  });

  it("uses the configured Cilium version", async () => {
    assert.match(await build("install-cilium", config), /--version '1\.19\.6'/);
  });

  it("uses the configured Gateway API version", async () => {
    assert.match(await build("install-gateway-api", config), /\/v1\.4\.1\//);
  });
});

describe("floating", () => {
  it("is opt-in, by name", async () => {
    const text = await build("get-cilium-cli-version", makeConfig({ cliVersion: "stable" }));

    assert.ok(text.includes("curl"), "only then does anything ask the network");
    assert.ok(text.includes("stable.txt"));
  });
});
