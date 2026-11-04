/**
 * @file
 * The record each package's install leaves behind.
 *
 * Meteorologist's Office page is made from nothing else, so what's
 * worth guarding is what it reads: that every install writes one, that
 * an application's address and way in come out right against a real
 * configuration, and that a credential named in one is a Secret the
 * package actually makes. A record naming a Secret that doesn't exist
 * is a "Show password" button that never shows one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

import { TerminalCommandSpec, joinCommand } from "../cli/commands/Command.ts";
import { buildPackageCommands } from "../cli/commands/Helm.ts";
import {
  PackageRecordCommands,
  RECORD_KEY,
  RECORD_LABEL,
  buildPackageRecord,
  buildPackageRecordManifest,
  buildRecordCommand,
} from "../cli/commands/PackageRecord.ts";
import { CLUSTER_NAMESPACE, PackageDefinition, getPackage, packageCatalogue } from "../cli/commands/packages.ts";
import { getGateName } from "../cli/commands/OAuth2Proxy.ts";
import { loadFixtureConfig, withoutConsole } from "./helpers.ts";

/**
 * A package from the catalogue, which the test needs to be there.
 *
 * @param name
 * @returns
 */
function definitionOf(name: string): PackageDefinition {
  const definition = getPackage(name);
  assert.ok(definition !== undefined, `${name} isn't in the catalogue`);
  return definition;
}

describe("a package's record", () => {
  it("is written by every package's install", () => {
    const missing = packageCatalogue
      .filter((definition) => !buildPackageCommands(definition).some((each) => each.name === `record-${definition.name}`))
      .map((definition) => definition.name);

    assert.deepEqual(missing, []);
  });

  it("is written after the package's manifests, and before it's waited for", () => {
    const names = buildPackageCommands(definitionOf("projectsend")).map((each) => each.name);
    const record = names.indexOf("record-projectsend");
    const lastManifest = names.findLastIndex((each) => each.startsWith("helm-manifest-after-"));

    assert.ok(record > lastManifest, names.join(", "));
    assert.ok(record < names.indexOf("rollout-projectsend"), names.join(", "));
  });

  it("is a ConfigMap in community-cloud that can be found by its label", async () => {
    const config = await loadFixtureConfig();
    const document = parse(buildPackageRecordManifest(definitionOf("plane"), config));

    assert.equal(document.kind, "ConfigMap");
    assert.equal(document.metadata.name, "cc-package-plane");
    assert.equal(document.metadata.namespace, CLUSTER_NAMESPACE);
    assert.equal(document.metadata.labels[RECORD_LABEL], "plane");
    assert.equal(JSON.parse(document.data[RECORD_KEY]).name, "plane");
  });

  it("says where an application is, and who its administrator is", async () => {
    const config = await loadFixtureConfig();
    const record = buildPackageRecord(definitionOf("projectsend"), config);

    assert.equal(record.namespace, "cc-office");
    assert.deepEqual(record.app?.admin, {
      secret: { namespace: "cc-office", name: "projectsend-admin", key: "password" },
      login: "someone@example.test",
    });
    assert.equal(record.app?.url, "https://files.example.test/");
    assert.equal(record.app?.signIn, "authentik");
    assert.ok(record.rollout.includes("deployment/projectsend"));
  });

  it("names a gated application's token, and its gate among what it waits for", async () => {
    const config = await loadFixtureConfig();
    const record = buildPackageRecord(definitionOf("picoclaw"), config);

    assert.equal(record.app?.signIn, "gate");
    assert.deepEqual(record.app?.admin, {
      secret: { namespace: "cc-office", name: "picoclaw-launcher", key: "password" },
    });
    assert.ok(record.rollout.includes(`deployment/${getGateName(definitionOf("picoclaw").gate!)}`), record.rollout.join(", "));
  });

  it("says how to become the administrator, when nobody was made one", async () => {
    const config = await loadFixtureConfig();
    const admin = buildPackageRecord(definitionOf("twenty"), config).app?.admin;

    assert.ok(admin !== undefined && "how" in admin, JSON.stringify(admin));
  });

  it("is still written for a package with nothing to sign in to", async () => {
    const config = await loadFixtureConfig();
    const record = buildPackageRecord(definitionOf("cert-manager"), config);

    assert.equal(record.app, undefined);
    assert.equal(record.chart?.name, "cert-manager");
  });

  it("only names credentials the package makes", () => {
    const wrong = packageCatalogue.flatMap((definition) => {
      const admin = definition.app?.admin;
      if (admin === undefined || "how" in admin) {
        return [];
      }

      const made = (definition.secrets ?? []).some(
        (secret) => secret.name === admin.secret && (secret.namespace ?? definition.namespace) === definition.namespace,
      );
      return made ? [] : [`${definition.name}: ${admin.secret}`];
    });

    assert.deepEqual(wrong, []);
  });

  it("can be rendered for every application against a whole configuration", async () => {
    const config = await loadFixtureConfig();
    for (const definition of packageCatalogue.filter((each) => each.app !== undefined)) {
      const record = buildPackageRecord(definition, config);
      assert.match(record.app!.url, /^https:\/\/[a-z0-9.-]+\/$/, definition.name);
    }
  });

  it("is written with shell", () => {
    const command = buildRecordCommand(definitionOf("plane")) as TerminalCommandSpec;
    execFileSync("/bin/sh", ["-n", "-c", joinCommand(command.command as string[])]);
    assert.equal(typeof command.stdin, "function");
  });
});

describe("the package-records bundle", () => {
  it("writes one record for each package the configuration enables, and does nothing else", async () => {
    const config = await loadFixtureConfig({ packages: { plane: true } });
    const names = (await withoutConsole(() => PackageRecordCommands(config))).map((each) => each.name);

    assert.ok(names.includes("record-plane"));
    assert.ok(names.includes("record-cloudnative-pg"));
    assert.ok(names.every((each) => each.startsWith("record-")), names.join(", "));
    assert.equal(new Set(names).size, names.length);
  });
});
