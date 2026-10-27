/**
 * @file
 * Installing one package on its own.
 *
 * A single-package bundle installs nothing the package requires, so it
 * has to find out first whether those are there. It used to ask
 * whether the package's namespace was there instead, which refused an
 * operator whose own manifests make its namespace (RabbitMQ) and let
 * an application through without what it runs on (Plane without
 * RabbitMQ). These hold it to asking about the packages themselves.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getBundle, getBundleCommands } from "../cli/commands/bundles.ts";
import { buildPresenceProbe } from "../cli/commands/Helm.ts";
import { getPackage } from "../cli/commands/packages.ts";
import { CommandSpec } from "../cli/commands/Command.ts";
import { configFrom } from "./helpers.ts";

const CONFIG = configFrom({ k3s: {}, nodes: [{ name: "n", address: "n", type: "server" }] });

/**
 * A bundle's commands, by name.
 *
 * @param bundle
 * @returns
 */
function commandsOf(bundle: string): Map<string, CommandSpec> {
  return new Map(getBundleCommands(getBundle(bundle)!, CONFIG).map((command) => [command.name, command]));
}

/**
 * The shell a command runs, as one string.
 *
 * @param command
 * @returns
 */
function shellOf(command: CommandSpec): string {
  const built = typeof (command as any).command === "function" ? (command as any).command(CONFIG, {}) : (command as any).command;
  return Array.isArray(built) ? built.join("\n") : built;
}

describe("what a package needs, before it's installed on its own", () => {
  it("asks about each package Plane requires, RabbitMQ included", () => {
    const shell = shellOf(commandsOf("plane").get("require-cluster-plane")!);

    for (const required of ["cloudnative-pg", "redis-operator", "rabbitmq-operator", "seaweedfs"]) {
      assert.match(shell, new RegExp(`missing="\\$missing ${required}"`), required);
    }
  });

  it("doesn't ask whether an operator's namespace is there before it makes it", () => {
    const shell = shellOf(commandsOf("rabbitmq").get("require-cluster-rabbitmq-operator")!);

    assert.doesNotMatch(shell, /get namespace/);
    assert.match(shell, /cert-manager/);
  });

  it("checks Helm is there first, when anything it asks about is a chart", () => {
    const names = [...commandsOf("rabbitmq").keys()];

    assert.ok(names.indexOf("check-helm-available") < names.indexOf("require-cluster-rabbitmq-operator"));
  });

  it("doesn't suggest re-running the bundle when something it needs is missing", () => {
    assert.equal(commandsOf("plane").get("require-cluster-plane")!.remedy, false);
  });
});

describe("telling whether an application is installed", () => {
  it("looks for its own workload, not the shared Redis it waits on first", () => {
    assert.match(buildPresenceProbe(getPackage("plane")!)!.probe, /deployment\/plane-api/);
    assert.match(buildPresenceProbe(getPackage("twenty")!)!.probe, /deployment\/twenty-crm/);
    assert.match(buildPresenceProbe(getPackage("lago")!)!.probe, /deployment\/lago/);
  });

  it("falls back to the first workload when none is named after it", () => {
    assert.match(buildPresenceProbe(getPackage("rabbitmq-operator")!)!.probe, /deployment\/rabbitmq-cluster-operator/);
  });
});
