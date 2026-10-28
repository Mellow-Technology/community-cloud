import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { cirrus } from "./cirrus";
import { installer } from "./installer";
import { meteorologist } from "./meteorologist";
import { ROOT, compareVersions, latestReleased, nextVersion, packageJsonPlace } from "./release";

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
