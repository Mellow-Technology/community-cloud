/**
 * @file
 * What a namespace is allowed to do, as Community Cloud decides it.
 *
 * Several of the cluster's shared services only serve namespaces that
 * carry a particular label: the Gateway only takes listeners from some,
 * SeaweedFS only makes buckets for some. Nothing records those labels
 * as a list anywhere — each is a selector in some other manifest — so
 * someone wanting to know why their application has no way in has to
 * know which file to look in.
 *
 * This is that list, in one place, with what each label is for in
 * words a person can act on. The pages show and toggle what's here,
 * and the WebApplication form asks it which a choice depends on, so a
 * new capability is one more entry rather than a change to either.
 */

/**
 * A capability's name, as the rest of the app refers to it.
 */
export type CapabilityId = "gateway" | "buckets";

/**
 * One label that turns something on for a namespace.
 *
 * - label and value: what goes on the Namespace. The capability is on
 *   when the label has exactly this value, since that's what the
 *   selectors elsewhere match.
 * - title: a short name for it
 * - summary: one line, for a table
 * - explanation: why someone would turn it on, and what turning it
 *   off breaks
 * - source: the manifest whose selector reads the label, so the next
 *   person can find it
 */
export interface Capability {
  id: CapabilityId;
  label: string;
  value: string;
  title: string;
  summary: string;
  explanation: string;
  source: string;
}

/**
 * Every capability, in the order the pages list them.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: "gateway",
    label: "whereWereGoing",
    value: "weDontNeedRoads",
    title: "Ingress and egress",
    summary: "Applications here can be served on their own hostnames.",
    explanation:
      "The cluster Gateway only accepts ListenerSets from namespaces with this label, so without it nothing here " +
      "can be reached from outside the cluster. Turning it off detaches the listeners of every application in " +
      "the namespace.",
    source: "k8s/networking/cilium/gateway/Gateway.yaml",
  },
  {
    id: "buckets",
    label: "storage.community-cloud.technology/buckets",
    value: "true",
    title: "Buckets",
    summary: "Applications here can have S3 buckets in SeaweedFS.",
    explanation:
      "SeaweedFS only accepts Bucket, S3Identity and S3Credentials requests from namespaces with this label. " +
      "Turning it off stops new buckets and keys being made here; buckets that already exist keep their data.",
    source: "k8s/storage/SeaweedFS/SeaweedFS.yaml",
  },
];

/**
 * A capability by its name.
 *
 * @param id
 * @returns
 */
export function getCapability(id: CapabilityId): Capability {
  const capability = CAPABILITIES.find((candidate) => candidate.id === id);
  if (capability === undefined) {
    throw new Error(`No capability called ${id}`);
  }
  return capability;
}

/**
 * Whether a namespace's labels turn a capability on.
 *
 * @param labels the namespace's labels, which may be missing entirely
 * @param capability
 * @returns
 */
export function hasCapability(labels: Record<string, string> | undefined, capability: Capability): boolean {
  return labels?.[capability.label] === capability.value;
}

/**
 * The capabilities a namespace's labels turn on.
 *
 * @param labels
 * @returns
 */
export function enabledCapabilities(labels: Record<string, string> | undefined): Capability[] {
  return CAPABILITIES.filter((capability) => hasCapability(labels, capability));
}

/**
 * The labels part of a JSON merge patch that turns a capability on or
 * off. Off removes the label rather than setting another value, since
 * a label left behind with some other value only confuses the next
 * person to read it.
 *
 * @param capability
 * @param enabled
 * @returns
 */
export function capabilityLabelPatch(capability: Capability, enabled: boolean): Record<string, string | null> {
  return { [capability.label]: enabled ? capability.value : null };
}

/**
 * The whole merge patch for a Namespace.
 *
 * @param capability
 * @param enabled
 * @returns
 */
export function capabilityPatch(
  capability: Capability,
  enabled: boolean,
): { metadata: { labels: Record<string, string | null> } } {
  return { metadata: { labels: capabilityLabelPatch(capability, enabled) } };
}
