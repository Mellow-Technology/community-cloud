/**
 * @file
 * The sections the interactive installer walks through, in the order a
 * new configuration wants them.
 *
 * The order matters for a first run: nodes ask which region they're in,
 * so regions come first; packages ask about Authentik's secret, which
 * belongs with the other values.
 */
import { ConfigSection } from "./section.ts";
import { clusterSection, topologySection } from "./sections/cluster.ts";
import { nodesSection } from "./sections/nodes.ts";
import { networkingSection, storageSection } from "./sections/networking.ts";
import { k3sSection, packagesSection, registriesSection } from "./sections/packages.ts";

export const configSections: ConfigSection[] = [
  clusterSection,
  topologySection,
  nodesSection,
  networkingSection,
  storageSection,
  k3sSection,
  registriesSection,
  packagesSection,
];

/**
 * Find a section by name.
 *
 * @param name
 * @returns
 */
export function getSection(name: string): ConfigSection | undefined {
  return configSections.find((section) => section.name === name);
}
