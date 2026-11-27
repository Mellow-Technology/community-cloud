/**
 * @file
 * Community Cloud's regions, by the code on the nodes and the name a
 * person reads.
 *
 * The list is the installer's, in installer/src/topology/regions.ts,
 * which is what puts the codes on the nodes. Meteorologist is built on
 * its own, without the rest of the repository, so it keeps a copy, and
 * regions.test.ts fails when the two differ. Change them together.
 */

export interface Region {
  code: string;
  name: string;
}

// In the installer's order: west to east, then north to south, so the
// list reads like a map rather than an alphabet
export const REGIONS: Region[] = [
  { code: "nam", name: "North America" },
  { code: "sam", name: "South America" },
  { code: "eur", name: "Europe" },
  { code: "naf", name: "Northern Africa" },
  { code: "waf", name: "Western Africa" },
  { code: "maf", name: "Middle Africa" },
  { code: "eaf", name: "Eastern Africa" },
  { code: "saf", name: "Southern Africa" },
  { code: "mea", name: "Middle East and Western Asia" },
  { code: "nas", name: "Northern Asia" },
  { code: "sas", name: "South Asia" },
  { code: "eas", name: "East Asia" },
  { code: "sea", name: "Southeast Asia" },
  { code: "anz", name: "Australia and New Zealand" },
  { code: "pac", name: "Pacific" },
  { code: "atl", name: "Atlantic" },
  { code: "ant", name: "Antarctica" },
  { code: "mob", name: "Mobile" },
];

/**
 * A region's name, or its code as it is when it isn't one of these,
 * such as one a cluster labelled by hand.
 *
 * @param code
 * @returns
 */
export function regionName(code: string): string {
  return REGIONS.find((region) => region.code === code)?.name ?? code;
}

/**
 * Regions in the installer's order, those it doesn't know last, in the
 * order given.
 *
 * @param codes
 * @returns
 */
export function sortRegions(codes: string[]): string[] {
  const order = (code: string) => {
    const at = REGIONS.findIndex((region) => region.code === code);
    return at === -1 ? REGIONS.length : at;
  };
  return codes.toSorted((a, b) => order(a) - order(b));
}
