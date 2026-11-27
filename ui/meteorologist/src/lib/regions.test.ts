import { describe, expect, test } from "bun:test";

// The installer's own list, which puts the codes on the nodes. Read
// from the repository, which CI checks out whole; Meteorologist's
// image is built without it, so it keeps the copy this checks.
import { regions as installerRegions } from "../../../../installer/src/topology/regions";
import { REGIONS, regionName, sortRegions } from "./regions";

test("the regions are the installer's, in its order", () => {
  expect(REGIONS).toEqual(installerRegions.map(({ code, name }) => ({ code, name })));
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
