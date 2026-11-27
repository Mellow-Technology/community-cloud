import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { REGIONS, regionName, sortRegions } from "./regions";

// The installer's own list, which puts the codes on the nodes. It's
// loaded when the test runs, from a path TypeScript doesn't follow:
// Meteorologist's image is built from this directory alone, and its
// build type checks every file, tests included, so a static import of
// something outside would fail there. The tests run where the whole
// repository is checked out.
const INSTALLER_REGIONS = join(import.meta.dir, "../../../../installer/src/topology/regions.ts");

test.if(existsSync(INSTALLER_REGIONS))("the regions are the installer's, in its order", async () => {
  const { regions } = (await import(INSTALLER_REGIONS)) as { regions: Array<{ code: string; name: string }> };
  expect(REGIONS).toEqual(regions.map(({ code, name }) => ({ code, name })));
});

describe("a region's name", () => {
  test("is the installer's for a code it knows", () => {
    expect(regionName("nam")).toBe("North America");
  });

  test("is the code itself for one it doesn't", () => {
    expect(regionName("lab")).toBe("lab");
  });
});

test("regions are listed in the installer's order, unknown ones last", () => {
  expect(sortRegions(["sea", "lab", "nam", "eur"])).toEqual(["nam", "eur", "sea", "lab"]);
});
