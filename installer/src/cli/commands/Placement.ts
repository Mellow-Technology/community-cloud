/**
 * @file
 * Put each placed namespace in its region.
 *
 * Annotates the namespaces "placement" names with a node selector on
 * the region label, which the PodNodeSelector admission plugin adds to
 * every pod made in them. See util/placement.ts for why it's done this
 * way. The plugin itself is the k3s bundle's to turn on, since it's an
 * API server flag.
 *
 * Runs after nodeLabels, so the nodes carry the region label a
 * selector asks for, and before helm-charts, so a namespace is placed
 * before the first pod is made in it. A namespace that doesn't exist
 * yet is made here for that reason, rather than waiting for whatever
 * installs into it.
 *
 * A selector only applies to pods made after it, so the check also
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
  PLACEMENT_ANNOTATION,
  REGION_LABEL,
  buildPlacementSelector,
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

export const PlacementCommands: CommandSpec[] = [
  {
    name: "apply-namespace-placement",
    description: "Annotate each placed namespace with the region its pods run in",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.Cluster,
    skipWhen: nothingPlaced,
    env: buildKubeEnv,
    command: (config: CloudConfig) =>
      Object.entries(getPlacement(config)).flatMap(([namespace, region]) => {
        const name = quoteForShell(namespace);
        return [
          `kubectl get namespace ${name} > /dev/null 2>&1 || kubectl create namespace ${name}`,
          `kubectl annotate --overwrite namespace ${name} ${quoteForShell(`${PLACEMENT_ANNOTATION}=${buildPlacementSelector(region)}`)}`,
        ];
      }),
    output: OutputType.Raw,
  },

  {
    name: "verify-namespace-placement",
    description: "Verify each placed namespace, and its pods, are in their region",
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.Cluster,
    skipWhen: nothingPlaced,
    env: buildKubeEnv,
    command: (config: CloudConfig) => [
      // Everything wrong is said on one line, since a failure's
      // explanation is its first line
      "failed=''",
      "say() { failed=\"${failed:+$failed }$1\"; }",

      // Every node's region, once, as "node region" lines
      `regions=$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.labels.${REGION_LABEL.replace(/\./g, "\\.")}}{"\\n"}{end}')`,

      ...Object.entries(getPlacement(config)).flatMap(([namespace, region]) => {
        const name = quoteForShell(namespace);
        const selector = buildPlacementSelector(region);
        const annotation = PLACEMENT_ANNOTATION.replace(/\./g, "\\.");

        return [
          `if ! kubectl get namespace ${name} > /dev/null 2>&1; then say "There's no ${namespace} namespace to place in ${region}."; else`,
          `  found=$(kubectl get namespace ${name} -o jsonpath='{.metadata.annotations.${annotation}}')`,
          `  if [ "$found" != ${quoteForShell(selector)} ]; then say "${namespace} is annotated with \\"\${found:-nothing}\\", not \\"${selector}\\", so its pods can run outside ${region}: run the placement bundle."; fi`,

          // Running pods only: one that's finished or waiting to be
          // scheduled isn't anywhere yet
          `  elsewhere=$(kubectl get pods -n ${name} --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.nodeName}{"\\n"}{end}' | while read -r pod node; do`,
          `    in=$(printf '%s\\n' "$regions" | awk -v n="$node" '$1 == n { print $2 }')`,
          `    [ "$in" = ${quoteForShell(region)} ] || printf ' %s (on %s, in %s)' "$pod" "$node" "\${in:-no region}"`,
          "  done)",
          `  if [ -n "$elsewhere" ]; then say "Running outside ${region} in ${namespace}:$elsewhere. They were made before it was placed, or the API server isn't enforcing it: re-run the k3s bundle on the servers, then delete them to have them made again."; fi`,
          `  [ -n "$failed" ] || echo "${namespace}: placed in ${region}, every running pod there"`,
          "fi",
        ];
      }),

      '[ -z "$failed" ] || { echo "$failed" >&2; exit 1; }',
    ],
    output: OutputType.Raw,
  },
];
