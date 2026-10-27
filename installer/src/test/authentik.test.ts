/**
 * @file
 * Authentik as a package of the installer's own.
 *
 * It used to come from a plugin, and the applications that sign in
 * through it still accept one installed by hand. What matters here is
 * that everything its pods read as they start is there before the
 * chart is, and that nothing about it is left to change by accident:
 * the chart's version, and the key its sessions are signed with.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";

import { buildPackageCommands } from "../cli/commands/Helm.ts";
import { getPackage, resolveInstallOrder } from "../cli/commands/packages.ts";
import { AUTHENTIK_NAMESPACE } from "../cli/commands/Authentik.ts";
import { renderInstallerFile } from "../util/template.ts";
import { configFrom } from "./helpers.ts";

const AUTHENTIK = getPackage("authentik")!;

describe("the authentik package", () => {
  it("is where blueprints are applied, as the release they expect", () => {
    assert.equal(AUTHENTIK.namespace, AUTHENTIK_NAMESPACE);
    assert.equal(AUTHENTIK.releaseName ?? AUTHENTIK.name, "authentik");
  });

  it("pins its chart, since Authentik can't migrate back down", () => {
    assert.match(AUTHENTIK.version ?? "", /^\d+\.\d+\.\d+$/);
  });

  it("has its database and bucket before the chart that reads them", () => {
    const names = buildPackageCommands(AUTHENTIK).map((command) => command.name);
    const chart = names.findIndex((name) => name.startsWith("helm-install-authentik"));
    for (const manifest of ["authentik-database", "authentik-storage"]) {
      const at = names.findIndex((name) => name.includes(manifest));
      assert.ok(at >= 0 && at < chart, manifest);
    }
  });

  it("brings Postgres and SeaweedFS with it", () => {
    const order = resolveInstallOrder(configFrom({ packages: { authentik: true } })).map((each) => each.name);
    for (const dependency of ["cloudnative-pg", "seaweedfs"]) {
      assert.ok(order.indexOf(dependency) < order.indexOf("authentik"), dependency);
    }
  });

  it("lets browsers fetch its icons by URL, since Authentik doesn't sign them", async () => {
    const config = configFrom({ values: { domain: { storage: "s3.example.test" } } });
    const bucket = parseAllDocuments(renderInstallerFile(config, "embed://apps/authentik/Authentik.storage.yaml"))
      .map((document) => document.toJS())
      .find((document) => document?.kind === "Bucket");
    assert.equal(bucket.spec.anonymousRead, true);

    // Read by name only: nobody without keys lists what's there
    assert.ok(!bucket.spec.access.some((grant: any) => grant.user === "anonymous"));
  });

    it("needs its secret key from the configuration, so it's never replaced", () => {
    assert.ok(AUTHENTIK.values?.includes("authentik.secretKey"));
  });
});
