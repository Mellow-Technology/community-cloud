/**
 * @file
 * The lvmd configurations a cluster's storage shapes produce.
 *
 * The property that matters is the one the TopoLVM chart insists on
 * and never checks: the nodeSelectors have to be non-overlapping, or
 * two lvmd DaemonSets land on one node and fight over a single socket.
 * Everything else here is about not offering a node a volume group it
 * hasn't got, which is the thing that crashes it.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import CloudConfig from "../util/CloudConfig.ts";
import { renderInstallerFile } from "../util/template.ts";
import {
  CLASSES_LABEL,
  buildShape,
  isUsableShape,
  readShape,
} from "../util/storage.ts";
import { REPO_ROOT, loadFixtureConfig } from "./helpers.ts";

const VALUES_FILE = "embed://storage/TopoLVM/TopoLVM.values.yaml";
const VALUES_SOURCE = join(REPO_ROOT, "k8s", "storage", "TopoLVM", "TopoLVM.values.yaml");

let config: CloudConfig;

before(async () => {
  config = await loadFixtureConfig();
});

/**
 * Every lvmd configuration the chart would be given, for a cluster
 * whose nodes have these shapes.
 *
 * @param shapes node name to shape
 * @returns the base configuration first, then the additional ones
 */
function render(shapes: Record<string, string>): any[] {
  const values = parse(renderInstallerFile(config, VALUES_FILE, { storageShapes: shapes }));
  const { lvmd } = values;

  return [
    { nodeSelector: lvmd.nodeSelector, deviceClasses: lvmd.deviceClasses },
    ...(lvmd.additionalConfigs ?? []),
  ];
}

/**
 * The device classes the values file declares.
 */
function catalogue(): string[] {
  return render({})[0]!.deviceClasses.map((entry: any) => String(entry.name));
}

describe("a cluster nothing has looked at yet", () => {
  it("gets one lvmd offering every class", () => {
    const configurations = render({});

    assert.equal(configurations.length, 1);
    assert.equal(configurations[0]!.deviceClasses.length, catalogue().length);
  });

  it("selects every storage node", () => {
    // Which is the behaviour from before any of this existed, and what
    // a first install does
    assert.equal(render({})[0]!.nodeSelector[CLASSES_LABEL], undefined);
  });
});

describe("a cluster of identical machines", () => {
  it("needs no extra configurations", () => {
    const complete = buildShape(catalogue());
    const configurations = render({ a: complete, b: complete, c: complete });

    assert.equal(configurations.length, 1);
  });
});

describe("a cluster of unlike machines", () => {
  const shapes: Record<string, string> = {
    a: "hdd.ssd.ssd-cache.ssd-sata",
    b: "hdd.ssd",
    c: "hdd.ssd",
    d: "ssd-sata",
    e: "hdd",
  };

  it("gets one lvmd per distinct shape, not per node", () => {
    assert.equal(render(shapes).length, new Set(Object.values(shapes)).size);
  });

  it("gives no two configurations the same nodeSelector", () => {
    const selectors = render(shapes).map((entry) => JSON.stringify(entry.nodeSelector));

    assert.equal(
      new Set(selectors).size,
      selectors.length,
      "the chart requires non-overlapping selectors and does not check",
    );
  });

  it("offers each lvmd only the classes those nodes have", () => {
    for (const entry of render(shapes)) {
      const shape = entry.nodeSelector[CLASSES_LABEL];
      const offered = entry.deviceClasses.map((one: any) => String(one.name)).sort();
      const has = shape !== undefined ? readShape(shape).sort() : catalogue().sort();

      assert.deepEqual(offered, has, `the ${shape ?? "(every node)"} lvmd`);
    }
  });

  it("serves every node with exactly one configuration", () => {
    for (const [node, shape] of Object.entries(shapes)) {
      const matching = render(shapes).filter(
        (entry) =>
          entry.nodeSelector[CLASSES_LABEL] === undefined ||
          entry.nodeSelector[CLASSES_LABEL] === shape,
      );

      assert.equal(matching.length, 1, `node ${node} matched ${matching.length}`);
    }
  });

  it("gives each configuration at most one default class", () => {
    for (const entry of render(shapes)) {
      const defaults = entry.deviceClasses.filter((one: any) => one.default === true);

      // None is fine: every StorageClass in k8s/ names the device class
      // it wants, so nothing relies on there being a default
      assert.ok(defaults.length <= 1, `${entry.nodeSelector[CLASSES_LABEL]}`);
    }
  });

  it("names no volume group outside the catalogue", () => {
    const groups = new Set(
      render({})[0]!.deviceClasses.map((entry: any) => String(entry["volume-group"])),
    );

    for (const entry of render(shapes)) {
      for (const one of entry.deviceClasses) {
        assert.ok(groups.has(String(one["volume-group"])), String(one["volume-group"]));
      }
    }
  });
});

describe("a shape as a label value", () => {
  it("fits in the sixty-three characters Kubernetes allows", () => {
    assert.ok(isUsableShape(buildShape(catalogue())));
  });

  it("round trips", () => {
    const complete = buildShape(catalogue());
    assert.equal(buildShape(readShape(complete)), complete);
  });

  it("doesn't depend on the order the classes were found in", () => {
    assert.equal(buildShape(["hdd", "ssd"]), buildShape(["ssd", "hdd"]));
  });
});

describe("the values file", () => {
  it("points at the upstream code this works around", () => {
    const source = readFileSync(VALUES_SOURCE, "utf8");

    assert.ok(source.includes("cmd/lvmd/app/root.go"), "the check that is fatal");
    assert.ok(source.includes("vgservice.go"), "the runtime that already tolerates it");
  });
});
