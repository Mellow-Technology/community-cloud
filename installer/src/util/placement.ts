/**
 * @file
 * Keeping a namespace's workloads in one region.
 *
 * A cluster can span regions, and should stay one cluster across them,
 * but related workloads belong together. An application talking to its
 * database across the world pays the distance on every query: Plane's
 * API on a node in Germany, with cc-postgres in Thailand, took six
 * seconds to answer a simple request. So a configuration can say which
 * region a namespace runs in:
 *
 *   "placement": { "cc-office": "sea" }
 *
 * It's enforced by Kubernetes' PodNodeSelector admission plugin, which
 * gives every pod created in an annotated namespace a node selector on
 * the region label. Every pod, which is the point: the ones operators
 * make — CloudNativePG's Postgres, the Redis, the RabbitMQ — are placed
 * the same as the applications' own, and nothing in any manifest has to
 * know. The rule is strict rather than a preference: with no node in
 * the region up, a pod waits rather than starting elsewhere. Kubernetes
 * has no namespace-wide way of preferring a region short of running a
 * webhook of our own.
 *
 * The region a node is in comes from its "region" in the
 * configuration, which the nodeLabels bundle puts on it.
 */
import CloudConfig from "./CloudConfig.ts";

// Kubernetes' own labels for where a node is
export const REGION_LABEL = "topology.kubernetes.io/region";
export const ZONE_LABEL = "topology.kubernetes.io/zone";

// What the PodNodeSelector admission plugin reads off a namespace
export const PLACEMENT_ANNOTATION = "scheduler.alpha.kubernetes.io/node-selector";

// K3s turns on NodeRestriction itself, and naming the plugins replaces
// its list rather than adding to it, so it has to be named again
const ADMISSION_PLUGINS = ["NodeRestriction", "PodNodeSelector"];

/**
 * The region each namespace is placed in.
 *
 * @param config
 * @returns namespace to region code, empty when nothing is placed
 */
export function getPlacement(config: CloudConfig): Record<string, string> {
  const placement = config.getConfig().placement;

  if (placement === undefined || placement === null || typeof placement !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(placement).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * The node selector a namespace in a region is annotated with.
 *
 * @param region
 * @returns
 */
export function buildPlacementSelector(region: string): string {
  return `${REGION_LABEL}=${region}`;
}

/**
 * The API server setting placement needs, when anything is placed.
 *
 * Without the plugin the annotation is read by nothing, and the
 * namespace looks placed while its pods go anywhere. Only when there's
 * placement, so a cluster that doesn't use it keeps K3s's defaults.
 *
 * @param config
 * @returns
 */
export function buildPlacementServerArgs(config: CloudConfig): string[] {
  return Object.keys(getPlacement(config)).length > 0
    ? [`--kube-apiserver-arg=enable-admission-plugins=${ADMISSION_PLUGINS.join(",")}`]
    : [];
}
