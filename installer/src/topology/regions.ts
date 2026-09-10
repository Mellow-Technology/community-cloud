/**
 * @file
 * Community Cloud separates all topology into world regions.
 *
 * A region is a country or broad geographic area; a zone is a single
 * physical location within one. Kubernetes reads both from node
 * labels, and spreads workloads across zones for resilience, so the
 * codes here are what ends up on the nodes.
 *
 * The list is deliberately fixed rather than free-form. Two people
 * setting up clusters in the same part of the world should end up with
 * the same region code, otherwise a cluster that later spans both has
 * two names for one place.
 */

/**
 * The region codes. Short, because they're used as label values and
 * as the first part of a zone name.
 */
export enum Regions {
  NorthernAsia = "nas",
  // Western Asia and the Middle East
  // are considered to be the same region
  WesternAsia = "mea",
  MiddleEast = "mea",
  EastAsia = "eas",
  SouthAsia = "sas",
  // Population-wise Southeast Asia is
  // quite large and generally considered
  // culturally and linguistically distinct
  // from other areas
  SoutheastAsia = "sea",
  // Each continent of the Americas is
  // treated as a large region
  NorthAmerica = "nam",
  SouthAmerica = "sam",
  // Highly populated but fairly geographically condensed
  Europe = "eur",
  // Africa is huge and highly populated
  // and thus split into several regions
  NorthernAfrica = "naf",
  EasternAfrica = "eaf",
  MiddleAfrica = "maf",
  SouthernAfrica = "saf",
  WesternAfrica = "waf",
  // A combined region even though
  // they're somewhat broad
  AustraliaNewZealand = "anz",
  // A massive region but fairly sparsely populated
  Pacific = "pac",
  // For any Atlantic ocean islands
  Atlantic = "atl",
  // For the possible (but very unlikely)
  // use of this software in Antartica
  Antartica = "ant",

  // A special region to indicate that
  // a computer is not statically located
  Mobile = "mob",
}

/**
 * A region, as something a person picks from a list.
 *
 * The code is what goes on the node; the name is what someone reads
 * while choosing; the note is why the region is drawn where it is,
 * which is the sort of thing worth saying once rather than leaving
 * people to wonder.
 */
export interface RegionDefinition {
  code: Regions;
  name: string;
  note?: string;
}

/**
 * Every region, in a rough west to east then north to south order so
 * the list reads like a map rather than an alphabet.
 */
export const regions: RegionDefinition[] = [
  {
    code: Regions.NorthAmerica,
    name: "North America",
    note: "Each continent of the Americas is treated as one large region",
  },
  {
    code: Regions.SouthAmerica,
    name: "South America",
    note: "Each continent of the Americas is treated as one large region",
  },
  {
    code: Regions.Europe,
    name: "Europe",
    note: "Highly populated but fairly geographically condensed",
  },
  {
    code: Regions.NorthernAfrica,
    name: "Northern Africa",
    note: "Africa is huge and highly populated, and so split into several regions",
  },
  {
    code: Regions.WesternAfrica,
    name: "Western Africa",
    note: "Africa is huge and highly populated, and so split into several regions",
  },
  {
    code: Regions.MiddleAfrica,
    name: "Middle Africa",
    note: "Africa is huge and highly populated, and so split into several regions",
  },
  {
    code: Regions.EasternAfrica,
    name: "Eastern Africa",
    note: "Africa is huge and highly populated, and so split into several regions",
  },
  {
    code: Regions.SouthernAfrica,
    name: "Southern Africa",
    note: "Africa is huge and highly populated, and so split into several regions",
  },
  {
    code: Regions.MiddleEast,
    name: "Middle East and Western Asia",
    note: "Western Asia and the Middle East are treated as the same region",
  },
  {
    code: Regions.NorthernAsia,
    name: "Northern Asia",
  },
  {
    code: Regions.SouthAsia,
    name: "South Asia",
  },
  {
    code: Regions.EastAsia,
    name: "East Asia",
  },
  {
    code: Regions.SoutheastAsia,
    name: "Southeast Asia",
    note: "Large by population, and culturally and linguistically distinct from its neighbours",
  },
  {
    code: Regions.AustraliaNewZealand,
    name: "Australia and New Zealand",
    note: "A combined region, even though the two are somewhat far apart",
  },
  {
    code: Regions.Pacific,
    name: "Pacific",
    note: "A massive region, but fairly sparsely populated",
  },
  {
    code: Regions.Atlantic,
    name: "Atlantic",
    note: "For Atlantic ocean islands",
  },
  {
    code: Regions.Antartica,
    name: "Antarctica",
    note: "For the possible, but very unlikely, use of this software in Antarctica",
  },
  {
    code: Regions.Mobile,
    name: "Mobile",
    note: "For a machine that isn't in one place: a laptop, a vehicle, a boat",
  },
];

/**
 * Find a region by its code.
 *
 * @param code
 * @returns
 */
export function getRegion(code: string): RegionDefinition | undefined {
  return regions.find((region) => region.code === code);
}

/**
 * Find a region by the name someone wrote for it.
 *
 * Configurations predate this list, so a region written out by hand as
 * "Southeast Asia" should still be recognised as the one with the code
 * "sea" rather than being offered again as though it were new.
 *
 * @param name
 * @returns
 */
export function findRegionByName(name: string): RegionDefinition | undefined {
  const wanted = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

  return regions.find(
    (region) => region.name.toLowerCase().replace(/[^a-z0-9]+/g, "") === wanted,
  );
}
