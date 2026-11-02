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
 *   "placement": { "cc-office": { "region": "sea", "affinity": "preferred" } }
 *
 * The namespace is labelled with its region, and a
 * MutatingAdmissionPolicy gives every pod made in a labelled namespace
 * a node affinity for that region. Every pod, which is the point: the
 * ones operators make — CloudNativePG's Postgres, the Redis, the
 * RabbitMQ — are placed the same as the applications' own, and nothing
 * in any manifest has to know.
 *
 * The affinity is required unless the namespace says otherwise. Then,
 * with no node in the region up, a pod waits rather than starting
 * elsewhere. Preferred puts pods in the region when there's room and
 * anywhere when there isn't.
 *
 * A pod can step out of its namespace's region, which the
 * PodNodeSelector admission plugin this replaced had no way to allow:
 * one labelled exempt is left alone, and so is one whose node selector
 * already names a region. The label has to be on the pod itself, so
 * for a pod an operator makes it goes wherever that operator takes pod
 * labels from.
 *
 * The region a node is in comes from its "region" in the
 * configuration, which the nodeLabels bundle puts on it.
 */
import { stringify } from "yaml";

import CloudConfig from "./CloudConfig.ts";

// Kubernetes' own labels for where a node is
export const REGION_LABEL = "topology.kubernetes.io/region";
export const ZONE_LABEL = "topology.kubernetes.io/zone";

// A namespace's region, and whether its pods must be there or only
// should be. Labels rather than annotations, since the policy's
// binding selects namespaces by label.
const PLACEMENT_PREFIX = "placement.community-cloud.technology";
export const NAMESPACE_REGION_LABEL = `${PLACEMENT_PREFIX}/region`;
export const NAMESPACE_AFFINITY_LABEL = `${PLACEMENT_PREFIX}/affinity`;

// A pod labelled with this set to "true" is left out of its
// namespace's region
export const EXEMPT_LABEL = `${PLACEMENT_PREFIX}/exempt`;

// What PodNodeSelector read off a namespace, before the policy. Taken
// off placed namespaces, so a cluster where the plugin is still turned
// on doesn't hold exempt pods to the region regardless.
export const LEGACY_PLACEMENT_ANNOTATION = "scheduler.alpha.kubernetes.io/node-selector";

// The policy and its binding share a name
export const PLACEMENT_POLICY = "community-cloud-placement";

export const AFFINITIES = ["required", "preferred"] as const;
export type Affinity = (typeof AFFINITIES)[number];

// What placement was before it could be anything but strict
const DEFAULT_AFFINITY: Affinity = "required";

export interface Placement {
  region: string;
  affinity: Affinity;
}

/**
 * Where each namespace is placed.
 *
 * A namespace's entry is its region, or an object with the region and
 * the affinity. An entry with no region is left out, and an affinity
 * that isn't one there is is passed through for preflight to refuse.
 *
 * @param config
 * @returns namespace to placement, empty when nothing is placed
 */
export function getPlacement(config: CloudConfig): Record<string, Placement> {
  const placement = config.getConfig().placement;

  if (placement === undefined || placement === null || typeof placement !== "object") {
    return {};
  }

  const placed: Record<string, Placement> = {};

  for (const [namespace, entry] of Object.entries(placement)) {
    if (typeof entry === "string") {
      placed[namespace] = { region: entry, affinity: DEFAULT_AFFINITY };
    } else if (entry !== null && typeof entry === "object" && typeof (entry as any).region === "string") {
      const affinity = (entry as any).affinity;
      placed[namespace] = { region: (entry as any).region, affinity: affinity === undefined ? DEFAULT_AFFINITY : affinity };
    }
  }

  return placed;
}

/**
 * The labels a placed namespace carries.
 *
 * @param placement
 * @returns
 */
export function buildNamespaceLabels(placement: Placement): Record<string, string> {
  return {
    [NAMESPACE_REGION_LABEL]: placement.region,
    [NAMESPACE_AFFINITY_LABEL]: placement.affinity,
  };
}

// The types CEL builds a pod's node affinity from. The policy's
// environment has neither cel.bind nor typed values in its variables,
// so each piece is spelled out wherever it's used.
const NODE_AFFINITY = "Object.spec.affinity.nodeAffinity";
const PREFERRED = `${NODE_AFFINITY}.preferredDuringSchedulingIgnoredDuringExecution`;
const REQUIRED = `${NODE_AFFINITY}.requiredDuringSchedulingIgnoredDuringExecution`;
const TERM = `${REQUIRED}.nodeSelectorTerms`;

// Paths in the pod the patch adds to
const AFFINITY_PATH = "/spec/affinity";
const NODE_AFFINITY_PATH = `${AFFINITY_PATH}/nodeAffinity`;
const PREFERRED_PATH = `${NODE_AFFINITY_PATH}/preferredDuringSchedulingIgnoredDuringExecution`;
const REQUIRED_PATH = `${NODE_AFFINITY_PATH}/requiredDuringSchedulingIgnoredDuringExecution`;

// How much a preferred region counts against a pod's own preferences:
// all it can, so it's outweighed only by several of them together
const PREFERRED_WEIGHT = 100;

/**
 * A JSON patch in CEL.
 *
 * @param op
 * @param path
 * @param value CEL
 * @returns
 */
function patch(op: string, path: string, value: string): string {
  return `[JSONPatch{op: '${op}', path: '${path}', value: ${value}}]`;
}

/**
 * The patch giving a pod its namespace's region, as CEL.
 *
 * A JSON patch can't make the fields on the way to what it adds, so
 * the patch adds at the first level the pod doesn't have, whole. A
 * preference is one more in the pod's list. A requirement is harder:
 * a pod's required terms are alternatives, any of which will do, so
 * the region goes into every one of them rather than alongside.
 *
 * @returns
 */
export function buildPlacementPatch(): string {
  const region = `key: '${REGION_LABEL}', operator: 'In', values: [variables.region]`;

  const preference = `${PREFERRED}{weight: ${PREFERRED_WEIGHT}, preference: ${PREFERRED}.preference{matchExpressions: [${PREFERRED}.preference.matchExpressions{${region}}]}}`;
  const requirement = `${TERM}.matchExpressions{${region}}`;
  const required = `${REQUIRED}{nodeSelectorTerms: [${TERM}{matchExpressions: [${requirement}]}]}`;

  const preferredPatch = [
    `!has(object.spec.affinity) ? ${patch("add", AFFINITY_PATH, `Object.spec.affinity{nodeAffinity: ${NODE_AFFINITY}{preferredDuringSchedulingIgnoredDuringExecution: [${preference}]}}`)}`,
    `: !has(object.spec.affinity.nodeAffinity) ? ${patch("add", NODE_AFFINITY_PATH, `${NODE_AFFINITY}{preferredDuringSchedulingIgnoredDuringExecution: [${preference}]}`)}`,
    `: !has(object.spec.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution) ? ${patch("add", PREFERRED_PATH, `[${preference}]`)}`,
    `: ${patch("add", `${PREFERRED_PATH}/-`, preference)}`,
  ].join("\n");

  const requiredPatch = [
    `!has(object.spec.affinity) ? ${patch("add", AFFINITY_PATH, `Object.spec.affinity{nodeAffinity: ${NODE_AFFINITY}{requiredDuringSchedulingIgnoredDuringExecution: ${required}}}`)}`,
    `: !has(object.spec.affinity.nodeAffinity) ? ${patch("add", NODE_AFFINITY_PATH, `${NODE_AFFINITY}{requiredDuringSchedulingIgnoredDuringExecution: ${required}}`)}`,
    `: !has(object.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution) ? ${patch("add", REQUIRED_PATH, required)}`,
    `: ${patch(
      "replace",
      `${REQUIRED_PATH}/nodeSelectorTerms`,
      `object.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms.map(term, ${TERM}{` +
        `matchExpressions: (has(term.matchExpressions) ? term.matchExpressions : []) + [${requirement}], ` +
        "matchFields: has(term.matchFields) ? term.matchFields : []})",
    )}`,
  ].join("\n");

  return `variables.preferred\n? (${preferredPatch})\n: (${requiredPatch})`;
}

/**
 * The policy placing pods, and the binding that applies it to placed
 * namespaces.
 *
 * Only pods being made: a pod's affinity can't change once it exists.
 * It fails closed, as PodNodeSelector did, so a pod that can't be
 * given its region isn't made at all rather than made anywhere.
 *
 * @returns the two as one YAML stream
 */
export function buildPlacementPolicy(): string {
  const labels = {
    "app.kubernetes.io/managed-by": "community-cloud",
    "app.kubernetes.io/part-of": "community-cloud",
  };

  const policy = {
    apiVersion: "admissionregistration.k8s.io/v1",
    kind: "MutatingAdmissionPolicy",
    metadata: { name: PLACEMENT_POLICY, labels },
    spec: {
      failurePolicy: "Fail",
      reinvocationPolicy: "Never",
      matchConstraints: {
        resourceRules: [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods"] }],
      },
      matchConditions: [
        {
          name: "not-exempt",
          expression: `!has(object.metadata.labels) || object.metadata.labels[?'${EXEMPT_LABEL}'].orValue('') != 'true'`,
        },
        {
          name: "no-region-of-its-own",
          expression: `!has(object.spec.nodeSelector) || !('${REGION_LABEL}' in object.spec.nodeSelector)`,
        },
      ],
      variables: [
        { name: "region", expression: `namespaceObject.metadata.labels['${NAMESPACE_REGION_LABEL}']` },
        {
          name: "preferred",
          expression: `namespaceObject.metadata.labels[?'${NAMESPACE_AFFINITY_LABEL}'].orValue('${DEFAULT_AFFINITY}') == 'preferred'`,
        },
      ],
      mutations: [{ patchType: "JSONPatch", jsonPatch: { expression: buildPlacementPatch() } }],
    },
  };

  const binding = {
    apiVersion: "admissionregistration.k8s.io/v1",
    kind: "MutatingAdmissionPolicyBinding",
    metadata: { name: PLACEMENT_POLICY, labels },
    spec: {
      policyName: PLACEMENT_POLICY,
      matchResources: {
        namespaceSelector: { matchExpressions: [{ key: NAMESPACE_REGION_LABEL, operator: "Exists" }] },
      },
    },
  };

  return [
    "# Managed by Community Cloud",
    "# Gives each pod in a placed namespace a node affinity for its",
    "# region. Edited here it will be overwritten.",
    stringify(policy),
    "---",
    stringify(binding),
  ].join("\n");
}
