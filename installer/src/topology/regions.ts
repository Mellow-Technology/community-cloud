

/**
 * Community Cloud separates all topology
 * into world regions.
 */
export enum Regions  {
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
}
