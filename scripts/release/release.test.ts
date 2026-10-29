import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cirrus } from "./cirrus";
import { installer } from "./installer";
import { meteorologist } from "./meteorologist";
import {
  EMBEDDED_DATABASE,
  ROOT,
  compareVersions,
  latestReleased,
  nextVersion,
  packageJsonPlace,
  updateEmbedded,
} from "./release";

describe("versions", () => {
  test("are ordered as semver orders them", () => {
    const ordered = ["0.1.0", "0.2.0-alpha", "0.2.0-rc.1", "0.2.0-rc.2", "0.2.0-rc.10", "0.2.0", "0.10.0", "1.0.0"];
    expect(ordered.toReversed().toSorted(compareVersions)).toEqual(ordered);
  });

  test("count on from the current one", () => {
    expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(nextVersion("0.1.3", "minor")).toBe("0.2.0");
    expect(nextVersion("0.4.1", "major")).toBe("1.0.0");
    // A prerelease's patch is the release it was leading up to
    expect(nextVersion("0.2.0-rc.1", "patch")).toBe("0.2.0");
    expect(nextVersion("0.1.0", "0.3.0-rc.1")).toBe("0.3.0-rc.1");
    expect(() => nextVersion("0.1.0", "v0.2")).toThrow();
  });

  test("the newest released is found among every tag", () => {
    const tags = ["cirrus-v0.1.0", "cirrus-v0.10.0", "cirrus-v0.9.0", "installer-v2.0.0", "cirrus-vnope"];
    expect(latestReleased(cirrus, tags)).toBe("0.10.0");
    expect(latestReleased(meteorologist, tags)).toBeUndefined();
  });
});

describe("places", () => {
  test("a package.json's own version is replaced, and nothing else", () => {
    const text = `{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": { "y": "0.1.0" }\n}\n`;
    const place = packageJsonPlace("package.json");
    expect(place.read(text)).toBe("0.1.0");
    expect(place.write(text, "0.2.0")).toBe(text.replace(`"version": "0.1.0"`, `"version": "0.2.0"`));
  });

  test("Cargo.lock's cirrus entry is the one changed", () => {
    const lock = `[[package]]\nname = "cfg-if"\nversion = "0.1.0"\n\n[[package]]\nname = "cirrus"\nversion = "0.1.0"\n`;
    const place = cirrus.places[1]!;
    expect(place.write(lock, "0.2.0")).toBe(lock.replace(`"cirrus"\nversion = "0.1.0"`, `"cirrus"\nversion = "0.2.0"`));
  });

  // Each place is found in the repository as it is, so a moved file
  // or a reworded line fails here rather than at release time
  test.each([cirrus, installer, meteorologist])("are all found for $name", async (component) => {
    for (const place of component.places) {
      const text = await readFile(join(ROOT, place.file), "utf8");
      expect(place.read(text)).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

describe("the installer's embedded copy", () => {
  // A copy of the real database, so the test changes nothing it shouldn't
  test("gets a manifest's new version, and refuses one it doesn't have", async () => {
    const directory = await mkdtemp(join(tmpdir(), "release-"));
    const database = join(directory, "embedded.sqlite");
    try {
      await copyFile(join(ROOT, EMBEDDED_DATABASE), database);
      updateEmbedded(database, { "k8s/operators/cirrus/Cirrus.yaml": "image: cirrus:9.9.9\n" });
      const read = new Database(database, { readonly: true });
      const row = read.query("select contents from files where path = ?").get("operators/cirrus/Cirrus.yaml");
      read.close();
      expect(row).toEqual({ contents: "image: cirrus:9.9.9\n" });
      expect(() => updateEmbedded(database, { "k8s/nowhere.yaml": "" })).toThrow(/build:embedded/);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("covers every place a release writes under k8s/", () => {
    const manifests = [cirrus, installer, meteorologist].flatMap((component) =>
      component.places.filter((place) => place.file.startsWith("k8s/")).map((place) => place.file),
    );
    expect(manifests).toEqual(["k8s/operators/cirrus/Cirrus.yaml", "k8s/apps/meteorologist/Meteorologist.yaml"]);
  });
});
