/**
 * @file
 * Twenty's keys.
 *
 * Twenty signs sessions with APP_SECRET and encrypts stored credentials
 * with ENCRYPTION_KEY, falling back to APP_SECRET when that's missing.
 * A server and worker given different keys can't read each other's
 * writes, and one given no key falls back to the default in Twenty's
 * own image, which is public. So both get both, from the same Secrets.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";

import { getPackage } from "../cli/commands/packages.ts";
import { renderInstallerFile } from "../util/template.ts";
import { configFrom } from "./helpers.ts";

const TWENTY = getPackage("twenty")!;

/**
 * Each Twenty Deployment's environment, by name.
 *
 * @returns
 */
function environments(): Map<string, Map<string, any>> {
  const config = configFrom({ values: { domain: { main: "example.test", crm: "crm.example.test" } } });
  const deployments = parseAllDocuments(renderInstallerFile(config, "embed://apps/twenty/Twenty.yaml"))
    .map((document) => document.toJS())
    .filter((document) => document?.kind === "Deployment");

  return new Map(
    deployments.map((deployment: any) => [
      deployment.metadata.name,
      new Map(deployment.spec.template.spec.containers[0].env.map((each: any) => [each.name, each.valueFrom ?? each.value])),
    ]),
  );
}

describe("Twenty's keys", () => {
  const deployments = environments();

  it("are the same for the server and the worker", () => {
    const [server, worker] = [deployments.get("twenty-crm")!, deployments.get("twenty-crm-worker")!];
    for (const key of ["APP_SECRET", "ENCRYPTION_KEY", "FALLBACK_ENCRYPTION_KEY"]) {
      assert.ok(server.get(key) !== undefined, `the server has no ${key}`);
      assert.deepEqual(worker.get(key), server.get(key), key);
    }
  });

  it("keep signing and encrypting apart, so a new session key loses nothing", () => {
    const server = deployments.get("twenty-crm")!;
    assert.notEqual(server.get("APP_SECRET").secretKeyRef.name, server.get("ENCRYPTION_KEY").secretKeyRef.name);
  });

  it("are both made by the installer, and the fallback only ever by hand", () => {
    const made = TWENTY.secrets!.map((secret) => secret.name);
    assert.deepEqual(made.sort(), ["twenty-crm-app-secret", "twenty-crm-encryption-key"]);
    assert.equal(deployments.get("twenty-crm")!.get("FALLBACK_ENCRYPTION_KEY").secretKeyRef.optional, true);
  });
});
