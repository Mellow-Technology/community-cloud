/**
 * @file
 * The storage each service claims, from the configuration to the
 * manifest.
 *
 * What matters is the path the number takes: set once under
 * "storage.allocations", landing in the database cluster and the
 * object store's claim as a size Kubernetes will accept. A value that
 * can't be a size has to be refused before it gets that far, since a
 * manifest with a nonsense size either fails to apply or, worse,
 * applies.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

import { ALLOCATIONS, buildAllocationValues, getAllocations } from "../util/allocations.ts";
import { renderInstallerFile } from "../util/template.ts";
import { loadFixtureConfig } from "./helpers.ts";

const DATABASE = "embed://apps/office/Office.database.yaml";
const OBJECT_STORAGE = "embed://storage/SeaweedFS/SeaweedFS.values.yaml";

describe("with nothing configured", () => {
  it("gives every service its default", () => {
    const sizes = getAllocations({});

    for (const allocation of ALLOCATIONS) {
      assert.equal(sizes[allocation.key], allocation.defaultGb);
    }
  });

  it("keeps the database at the size it had before this existed", () => {
    assert.equal(getAllocations({})["databaseGb"], 30);
  });

  it("tolerates a storage section that is only about disks", () => {
    assert.deepEqual(getAllocations({ storage: { minimumSizeGb: 1 } }), getAllocations({}));
  });
});

describe("with sizes configured", () => {
  it("uses them, as GiB", () => {
    const values = buildAllocationValues({
      storage: { allocations: { databaseGb: 80, objectStorageGb: 500 } },
    });

    assert.equal(values["databaseVolumeSize"], "80Gi");
    assert.equal(values["objectStorageVolumeSize"], "500Gi");
  });

  it("defaults the ones left out", () => {
    const values = buildAllocationValues({ storage: { allocations: { objectStorageGb: 10 } } });

    assert.equal(values["databaseVolumeSize"], "30Gi");
    assert.equal(values["objectStorageVolumeSize"], "10Gi");
  });

  for (const bad of [0, -5, 1.5, "20", "20Gi"]) {
    it(`refuses ${JSON.stringify(bad)}, naming the key`, () => {
      assert.throws(
        () => getAllocations({ storage: { allocations: { objectStorageGb: bad } } }),
        /storage\.allocations\.objectStorageGb/,
      );
    });
  }
});

describe("the manifests", () => {
  it("size the database from the configuration", async () => {
    const config = await loadFixtureConfig({
      storage: { allocations: { databaseGb: 75 } },
    });

    const cluster = parse(renderInstallerFile(config, DATABASE));
    assert.equal(cluster.spec.storage.size, "75Gi");
  });

  it("size the object store from the configuration", async () => {
    const config = await loadFixtureConfig({
      storage: { allocations: { objectStorageGb: 200 } },
    });

    const values = parse(renderInstallerFile(config, OBJECT_STORAGE));
    assert.equal(values.allInOne.data.size, "200Gi");
  });

  it("leave an explicit template value alone", async () => {
    const config = await loadFixtureConfig({
      values: { ...(await loadFixtureConfig()).getConfig().values, objectStorageVolumeSize: "1Ti" },
    });

    const values = parse(renderInstallerFile(config, OBJECT_STORAGE));
    assert.equal(values.allInOne.data.size, "1Ti");
  });
});
