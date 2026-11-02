/**
 * @file
 * Put each placed namespace in its region.
 *
 * Applies the MutatingAdmissionPolicy that gives a pod its namespace's
 * region, then labels the namespaces "placement" names with theirs.
 * See util/placement.ts for why it's done this way.
 *
 * The policy is applied whether or not the configuration places
 * anything, since a namespace can be placed from Meteorologist too,
 * and it does nothing for a namespace without the label.
 *
 * Runs after nodeLabels, so the nodes carry the region label an
 * affinity asks for, and before helm-charts, so a namespace is placed
 * before the first pod is made in it. A namespace that doesn't exist
 * yet is made here for that reason, rather than waiting for whatever
 * installs into it.
 *
 * An affinity is only given to pods as they're made, so the check also
 * looks at where the namespace's pods actually are: placing a namespace
 * that already has workloads leaves them where they were until they're
 * restarted, and the check says which.
 *
 * Requires:
 * - a node with a type of "server" in the configuration
 */
import { CommandPurpose, CommandScope, CommandSpec, CommandTarget, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { quoteForShell } from "../../util/shell.ts";
import {
  EXEMPT_LABEL,
  LEGACY_PLACEMENT_ANNOTATION,
  NAMESPACE_AFFINITY_LABEL,
  NAMESPACE_REGION_LABEL,
  PLACEMENT_POLICY,
  REGION_LABEL,
  buildNamespaceLabels,
  buildPlacementPolicy,
  getPlacement,
} from "../../util/placement.ts";

/**
 * Whether there's nothing to place.
 *
 * @param config
 * @returns
 */
function nothingPlaced(config: CloudConfig): boolean {
  return Object.keys(getPlacement(config)).length === 0;
}

/**
 * A label or annotation key as kubectl's JSONPath wants it.
 *
 * @param key
 * @returns
 */
function jsonPathKey(key: string): string {
  return key.replace(/\./g, "\\.");
}

export const PlacementCommands: CommandSpec[] = [
  {
    name: "apply-placement-policy",
    description: "Apply the admission policy that gives pods their namespace's region",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.Cluster,
    env: buildKubeEnv,
    command: `kubectl apply -f - || { echo "Couldn't apply the placement policy" >&2; exit 1; }`,
    stdin: () => buildPlacementPolicy(),
    output: OutputType.Raw,
  },

  {
    name: "apply-namespace-placement",
    description: "Label each placed namespace with the region its pods run in",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.Cluster,
    skipWhen: nothingPlaced,
    env: buildKubeEnv,
    command: (config: CloudConfig) =>
      Object.entries(getPlacement(config)).flatMap(([namespace, placement]) => {
        const name = quoteForShell(namespace);
        const labels = Object.entries(buildNamespaceLabels(placement)).map(([key, value]) => quoteForShell(`${key}=${value}`));

        return [
          `kubectl get namespace ${name} > /dev/null 2>&1 || kubectl create namespace ${name}`,
          `kubectl label --overwrite namespace ${name} ${labels.join(" ")}`,

          // PodNodeSelector's annotation, from before the policy. Where
          // the plugin's still on it would hold every pod to the
          // region, exempt or not.
          `kubectl annotate namespace ${name} ${quoteForShell(`${LEGACY_PLACEMENT_ANNOTATION}-`)} > /dev/null`,
        ];
      }),
    output: OutputType.Raw,
  },

  {
    name: "verify-namespace-placement",
    description: "Verify the placement policy is there, and each placed namespace and its pods are in their region",
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.Cluster,
    env: buildKubeEnv,
    command: (config: CloudConfig) => [
      // Everything wrong is said on one line, since a failure's
      // explanation is its first line
      "failed=''",
      "say() { failed=\"${failed:+$failed }$1\"; }",

      `kubectl get mutatingadmissionpolicy,mutatingadmissionpolicybinding ${PLACEMENT_POLICY} > /dev/null 2>&1 || say "The ${PLACEMENT_POLICY} admission policy or its binding is missing, so placed namespaces' pods can run anywhere: run the placement bundle."`,

      // Every node's region, once, as "node region" lines
      `regions=$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.labels.${jsonPathKey(REGION_LABEL)}}{"\\n"}{end}')`,

      ...Object.entries(getPlacement(config)).flatMap(([namespace, { region, affinity }]) => {
        const name = quoteForShell(namespace);
        const required = affinity === "required";

        return [
          `if ! kubectl get namespace ${name} > /dev/null 2>&1; then say "There's no ${namespace} namespace to place in ${region}."; else`,
          `  found=$(kubectl get namespace ${name} -o jsonpath='{.metadata.labels.${jsonPathKey(NAMESPACE_REGION_LABEL)}} {.metadata.labels.${jsonPathKey(NAMESPACE_AFFINITY_LABEL)}}')`,
          `  if [ "$found" != ${quoteForShell(`${region} ${affinity}`)} ]; then say "${namespace} is labelled \\"\${found# }\\", not \\"${region} ${affinity}\\": run the placement bundle."; fi`,
          `  legacy=$(kubectl get namespace ${name} -o jsonpath='{.metadata.annotations.${jsonPathKey(LEGACY_PLACEMENT_ANNOTATION)}}')`,
          `  if [ -n "$legacy" ]; then say "${namespace} still has PodNodeSelector's annotation, which holds even exempt pods to \\"$legacy\\": run the placement bundle."; fi`,

          // Running pods only: one that's finished or waiting to be
          // scheduled isn't anywhere yet. Pods that are exempt, or
          // choose a region of their own, can be anywhere.
          `  elsewhere=$(kubectl get pods -n ${name} -l ${quoteForShell(`${EXEMPT_LABEL}!=true`)} --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.nodeName}{" "}{.spec.nodeSelector.${jsonPathKey(REGION_LABEL)}}{"\\n"}{end}' | while read -r pod node own; do`,
          '    [ -z "$own" ] || continue',
          `    in=$(printf '%s\\n' "$regions" | awk -v n="$node" '$1 == n { print $2 }')`,
          `    [ "$in" = ${quoteForShell(region)} ] || printf ' %s (on %s, in %s)' "$pod" "$node" "\${in:-no region}"`,
          "  done)",
          required
            ? `  if [ -n "$elsewhere" ]; then say "Running outside ${region} in ${namespace}:$elsewhere. They were made before it was placed, or the placement policy wasn't there: run the placement bundle, then delete them to have them made again."; fi`
            : `  if [ -n "$elsewhere" ]; then echo "${namespace}: prefers ${region}, but running outside it:$elsewhere"; fi`,
          `  [ -n "$failed" ] || [ -n "$elsewhere" ] || echo "${namespace}: placed in ${region} (${affinity}), every running pod there"`,
          "fi",
        ];
      }),

      '[ -z "$failed" ] || { echo "$failed" >&2; exit 1; }',
    ],
    output: OutputType.Raw,
  },
];
