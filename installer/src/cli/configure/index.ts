/**
 * @file
 * The sections the interactive installer walks through, in the order a
 * new configuration wants them.
 *
 * The order matters for a first run: packages ask about Authentik's
 * secret, which belongs with the other values the cluster section
 * sets.
 */
import { ConfigSection } from "./section.ts";
import { clusterSection } from "./sections/cluster.ts";
import { nodesSection } from "./sections/nodes.ts";
import { networkingSection, storageSection } from "./sections/networking.ts";
import { k3sSection, packagesSection, registriesSection } from "./sections/packages.ts";
import { mailSection } from "./sections/mail.ts";

export const configSections: ConfigSection[] = [
  clusterSection,
  nodesSection,
  networkingSection,
  storageSection,
  k3sSection,
  registriesSection,
  packagesSection,
  // After packages, since it only matters once something that sends
  // mail is installed
  mailSection,
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
