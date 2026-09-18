/**
 * @file
 * What the cluster records about itself, and what it must not.
 *
 * The ConfigMap goes into kube-system, where a great deal of the
 * cluster can read it, so the load-bearing assertion is that no secret
 * in the configuration survives the trip. That is checked by walking a
 * fixture built to be full of them and looking for each value in the
 * rendered output, rather than by trusting the redaction rules to
 * agree with themselves.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import {
  buildClusterConfigMap,
  buildStoredConfig,
  compareConfigurations,
  readStoredConfig,
} from "../cli/commands/ClusterConfig.ts";
import { REDACTED, findSecrets, redact } from "../util/redact.ts";
import { TEST_DIR, configFrom } from "./helpers.ts";

const SECRETIVE = JSON.parse(
  readFileSync(join(TEST_DIR, "fixtures", "secretive.fixture.json"), "utf8"),
);

// Keys whose values are worth going looking for in the output
const SECRET_KEY = /token|password|secret|apikey|api_key|auth|credential|^key$/i;

/**
 * Every secret-looking value actually in a configuration, found by
 * walking it rather than by asking the code under test.
 */
function findSecretValues(value: any, path: string[] = []): { path: string; value: string }[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, nested]) =>
      findSecretValues(nested, [...path, key]),
    );
  }

  const key = path[path.length - 1] ?? "";

  return SECRET_KEY.test(key) && String(value).length > 8
    ? [{ path: path.join("."), value: String(value) }]
    : [];
}

/**
 * The ConfigMap, parsed back out of what would be applied.
 */
function renderConfigMap(raw: Record<string, unknown>): any {
  const rendered = buildClusterConfigMap(configFrom(raw));

  return parse(
    rendered
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n"),
  );
}

describe("what reaches the cluster", () => {
  const rendered = buildClusterConfigMap(configFrom(SECRETIVE));
  const secrets = findSecretValues(SECRETIVE);

  it("has secrets to leak in the first place", () => {
    assert.ok(secrets.length > 3, `only ${secrets.length} secret values in the fixture`);
  });

  it("leaks not one of them", () => {
    const leaked = secrets
      .filter(({ value }) => rendered.includes(value))
      .map(({ path }) => path);

    assert.deepEqual(leaked, []);
  });

  it("goes into kube-system as a ConfigMap", () => {
    const document = renderConfigMap(SECRETIVE);

    assert.equal(document.kind, "ConfigMap");
    assert.equal(document.metadata.namespace, "kube-system");
    assert.equal(document.metadata.name, "community-cloud");
  });
});

describe("what survives the trip", () => {
  const stored = parse(renderConfigMap(SECRETIVE).data["config.yaml"]);

  it("keeps the node list", () => {
    assert.equal(stored.nodes.length, SECRETIVE.nodes.length);
  });

  it("keeps node roles", () => {
    assert.deepEqual(stored.nodes[0].roles, SECRETIVE.nodes[0].roles);
  });

  it("keeps the packages", () => {
    assert.deepEqual(stored.packages, SECRETIVE.packages);
  });

  it("keeps the networking settings", () => {
    assert.equal(stored.network.congestionControl, SECRETIVE.network.congestionControl);
  });

  it("keeps registry names while dropping their credentials", () => {
    assert.deepEqual(Object.keys(stored.registries), Object.keys(SECRETIVE.registries));
    assert.equal(stored.registries["registry.gitlab.com"].auth, REDACTED);
  });

  it("keeps the mesh roles and their firewall rules", () => {
    assert.equal(stored.network.nebula.roles.length, SECRETIVE.network.nebula.roles.length);
  });
});

describe("secrets in awkward places", () => {
  const nasty = {
    values: { authentik: { secretKey: "aaaaaaaaaaaa", host: "auth.example.test" } },
    deep: [{ list: [{ password: "bbbbbbbbbbbb" }] }],
    packages: { authentik: true },
    misc: {
      apiToken: "cccccccccccc",
      api_key: "dddddddddddd",
      "private-key": "eeeeeeeeeeee",
    },
  };

  const rendered = buildClusterConfigMap(configFrom(nasty));

  it("catches them nested in objects, arrays and every casing", () => {
    const values = [
      "aaaaaaaaaaaa",
      "bbbbbbbbbbbb",
      "cccccccccccc",
      "dddddddddddd",
      "eeeeeeeeeeee",
    ];

    assert.deepEqual(values.filter((value) => rendered.includes(value)), []);
  });

  it("doesn't mistake a package called authentik for a secret", () => {
    assert.ok(rendered.includes("authentik: true"));
  });

  it("leaves a non-secret sibling alone", () => {
    assert.ok(rendered.includes("auth.example.test"));
  });
});

describe("redaction itself", () => {
  it("doesn't empty the configuration it was handed", () => {
    const original = { k3s: { token: "keep-me" } };
    redact(original);

    assert.equal(original.k3s.token, "keep-me");
  });

  it("leaves an unset secret unset rather than marking it redacted", () => {
    const stored = buildStoredConfig(configFrom({ k3s: { token: "" }, network: {} }));

    assert.equal(stored.k3s.token, "");
  });

  it("doesn't list an unset secret as something kept out", () => {
    assert.deepEqual(findSecrets({ k3s: { token: "" } }), []);
  });
});

describe("comparing a cluster against a file", () => {
  const base = { nodes: [{ name: "a", roles: ["worker"] }], packages: { authentik: true } };

  it("reports nothing when they match", () => {
    assert.deepEqual(compareConfigurations(redact(base), redact(base)), []);
  });

  it("reports drift per path", () => {
    const changed = {
      nodes: [{ name: "a", roles: ["worker", "storage"] }],
      packages: { authentik: false },
    };

    assert.equal(compareConfigurations(redact(base), redact(changed)).length, 2);
  });

  it("doesn't call two different secrets drift", () => {
    // Both sides are redacted, so comparing them could only produce a
    // false sense of having checked
    assert.deepEqual(
      compareConfigurations(redact({ k3s: { token: "one" }, a: 1 }), redact({ k3s: { token: "two" }, a: 1 })),
      [],
    );
  });

  it("reports a setting the file has and the cluster doesn't", () => {
    const added = compareConfigurations(redact({ a: 1 }), redact({ a: 1, b: 2 }));

    assert.equal(added.length, 1);
    assert.equal(added[0]!.path, "b");
  });
});

describe("reading it back", () => {
  const document = renderConfigMap(SECRETIVE);
  const roundTripped = readStoredConfig({ stdout: "", stderr: "", parsed: document });

  it("reads what was written", () => {
    assert.equal(roundTripped.found, true);
    assert.equal(roundTripped.config.nodes.length, SECRETIVE.nodes.length);
  });

  it("reads a cluster with no ConfigMap as not found", () => {
    assert.equal(readStoredConfig({ stdout: "", stderr: "", parsed: {} }).found, false);
  });

  it("introduces no drift going through YAML", () => {
    const drift = compareConfigurations(
      roundTripped.config,
      buildStoredConfig(configFrom(SECRETIVE)),
    );

    assert.deepEqual(drift.map((one) => one.path), []);
  });
});
