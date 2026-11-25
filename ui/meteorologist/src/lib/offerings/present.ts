/**
 * @file
 * ServiceOfferings as the application form and pages show them: which
 * an application may connect to, what a connection gives it, and how
 * an offering's doing. Mirrors what Cirrus does
 * (operators/cirrus/src/offerings and reconcile/connections.rs).
 */
import { envPrefix } from "../webapp/form";
import type { ServiceOffering } from "./types";

/**
 * An offering as the form offers it, with only what the browser needs.
 */
export interface OfferingChoice {
  namespace: string;
  name: string;
  title: string;
  description: string;
  protocol: string;
  shareWith: string[];
  uri?: string;
  ready: boolean;
  // Whether it hands out credentials, which only its own namespace gets
  hasSecret: boolean;
  // Extra values every connection gets, by name
  values: string[];
}

/**
 * @param offering
 * @returns
 */
export function offeringChoice(offering: ServiceOffering): OfferingChoice {
  return {
    namespace: offering.metadata.namespace ?? "",
    name: offering.metadata.name,
    title: offering.spec.title,
    description: offering.spec.description ?? "",
    protocol: offering.spec.protocol ?? "http",
    shareWith: offering.spec.shareWith ?? [],
    uri: offering.status?.uri,
    ready: offering.status?.conditions?.find((condition) => condition.type === "Ready")?.status === "True",
    hasSecret: offering.spec.secret !== undefined,
    values: Object.keys(offering.spec.values ?? {}),
  };
}

/**
 * Whether an application in a namespace may connect to an offering:
 * its own namespace's, or one shared with it.
 *
 * @param choice
 * @param namespace
 * @returns
 */
export function mayConnect(choice: OfferingChoice, namespace: string): boolean {
  return choice.namespace === namespace || choice.shareWith.includes(namespace);
}

/**
 * The offerings an application in a namespace may connect to: its own
 * namespace's first, then those shared with it, by title.
 *
 * @param choices
 * @param namespace
 * @returns
 */
export function usableOfferings(choices: OfferingChoice[], namespace: string): OfferingChoice[] {
  return choices
    .filter((choice) => mayConnect(choice, namespace))
    .toSorted(
      (a, b) =>
        Number(b.namespace === namespace) - Number(a.namespace === namespace) ||
        a.namespace.localeCompare(b.namespace) ||
        a.title.localeCompare(b.title),
    );
}

/**
 * What a connection will set, as Cirrus sets it, and what it won't:
 * credentials don't go to another namespace.
 *
 * @param choice
 * @param name the connection's, or blank for the offering's
 * @param namespace the application's
 * @returns
 */
export function connectionEnv(
  choice: OfferingChoice,
  name: string,
  namespace: string,
): { variables: string[]; credentials: "given" | "withheld" | "none" } {
  const prefix = envPrefix(name.trim() || choice.name);
  const variables = [
    ...["HOST", "PORT", "URL", "TYPE"].map((part) => `${prefix}_${part}`),
    ...choice.values.map((value) => `${prefix}_${envPrefix(value)}`),
  ];
  const credentials = !choice.hasSecret ? "none" : choice.namespace === namespace ? "given" : "withheld";
  return { variables, credentials };
}

/**
 * An offering's key, as the form's picker uses it.
 *
 * @param choice
 * @returns
 */
export function offeringKey(choice: { namespace: string; name: string }): string {
  return `${choice.namespace}/${choice.name}`;
}
