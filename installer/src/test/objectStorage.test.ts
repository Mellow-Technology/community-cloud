/**
 * @file
 * The shape of the cluster's SeaweedFS, from "storage.objectStorage".
 *
 * More copies only help if they're on different machines, so these
 * check the copies become SeaweedFS's replication setting, the volume
 * servers are kept a node apart, and a shape the nodes can't hold is
 * refused before an install waits on it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";

import { getObjectStorageShape, replicationFor } from "../util/objectStorage.ts";
import { renderInstallerFile } from "../util/template.ts";
import { checkConfiguration } from "../runners/preflight.ts";
import { configFrom } from "./helpers.ts";

const MANIFEST = "embed://storage/SeaweedFS/SeaweedFS.yaml";

/**
 * The Seaweed resource a configuration renders.
 *
 * @param raw
 * @returns
 */
function seaweedFor(raw: any): any {
  return parseAllDocuments(renderInstallerFile(configFrom(raw), MANIFEST))
    .map((document) => document.toJS())
    .find((document) => document?.kind === "Seaweed");
}

/**
 * A node with the given roles.
 *
 * @param name
 * @param roles
 * @returns
 */
function node(name: string, roles: string[]) {
  return { name, address: `${name}.test`, username: "someone", type: name === "one" ? "server" : "agent", roles };
}

const STORAGE_NODES = ["one", "two", "three"].map((name) => node(name, ["worker", "storage-local"]));

describe("the shape of SeaweedFS", () => {
  it("is one of everything, and one copy, unless asked otherwise", () => {
    const seaweed = seaweedFor({ values: { domain: { storage: "s3.example.test" } } });
    assert.equal(seaweed.spec.master.replicas, 1);
    assert.equal(seaweed.spec.volume.replicas, 1);
    assert.equal(seaweed.spec.master.defaultReplication, "000");
  });

  it("keeps the copies asked for, on other servers", () => {
    const seaweed = seaweedFor({
      storage: { objectStorage: { masters: 3, volumeServers: 3, copies: 2 } },
      values: { domain: { storage: "s3.example.test" } },
    });
    assert.equal(seaweed.spec.master.replicas, 3);
    assert.equal(seaweed.spec.volume.replicas, 3);
    assert.equal(seaweed.spec.master.defaultReplication, "001");
    assert.equal(replicationFor(3), "002");
  });

  it("keeps volume servers a node apart, always", () => {
    const [term] = seaweedFor({ values: { domain: { storage: "s3.example.test" } } }).spec.volume.affinity.podAntiAffinity
      .requiredDuringSchedulingIgnoredDuringExecution;
    assert.equal(term.topologyKey, "kubernetes.io/hostname");
    assert.equal(term.labelSelector.matchLabels["app.kubernetes.io/component"], "volume");
  });

  it("refuses more copies than servers, and an even number of masters", () => {
    assert.throws(() => getObjectStorageShape({ storage: { objectStorage: { volumeServers: 1, copies: 2 } } }), /copies/);
    assert.throws(() => getObjectStorageShape({ storage: { objectStorage: { masters: 2 } } }), /odd/);
    assert.throws(() => getObjectStorageShape({ storage: { objectStorage: { volumeServers: 0 } } }), /above zero/);
  });

  it("is refused by preflight when the storage nodes can't hold it", () => {
    const problems = (objectStorage: any) =>
      checkConfiguration(configFrom({ k3s: { token: "t" }, nodes: STORAGE_NODES, storage: { objectStorage } })).map(
        (problem) => problem.what,
      );

    assert.deepEqual(problems({ masters: 3, volumeServers: 3, copies: 2 }).filter((what) => what.includes("objectStorage")), []);
    assert.ok(problems({ volumeServers: 4 }).some((what) => what.includes("3 storage-local node(s)")));
    assert.ok(problems({ masters: 2 }).some((what) => what.includes("odd")));
  });
});
