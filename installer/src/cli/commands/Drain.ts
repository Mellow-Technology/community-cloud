/**
 * @file
 * Take a node out of service before taking it apart.
 *
 * Stopping K3s on a node kills whatever was running there. The pods
 * come back somewhere else a minute or two later, once the cluster
 * notices the node is gone, which is fine for something stateless and
 * is not fine for a database being SIGKILLed mid-write. Draining is
 * the difference between a workload being moved and a workload being
 * dropped: the node is marked unschedulable, every pod on it is
 * evicted through the eviction API, and the eviction API is the one
 * that honours a PodDisruptionBudget.
 *
 * All of this is cluster-facing, so it runs on the control plane. The
 * node being drained is still the subject — it's in the context and
 * kubectl names it — which is the same split between "where the shell
 * runs" and "who the step is for" that the scopes exist to express.
 *
 * Two things are deliberately not passed to kubectl:
 *
 * - "--force", which deletes pods belonging to no controller. Nothing
 *   recreates those, so passing it turns "move this workload" into
 *   "delete this workload" without saying so. Without it, drain stops
 *   and names the pods, which is a decision worth making on purpose.
 * - "--disable-eviction", which deletes pods directly and ignores
 *   every disruption budget in the cluster. That is the whole thing
 *   draining exists to respect.
 *
 * Empty directories are the one exception: "--delete-emptydir-data" is
 * passed, because an emptyDir is by definition scratch space that dies
 * with the pod, and without it a drain stops on any pod that has one.
 */
import {
  CommandPurpose,
  CommandScope,
  CommandSpec,
  CommandTarget,
  OutputType,
} from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { getClusterNodeName } from "./K3s.ts";
import { quoteForShell } from "../../util/shell.ts";

/**
 * How long to give the eviction API before giving up.
 *
 * A pod with a disruption budget that can't be satisfied will never
 * be evicted, and without a bound the drain simply never returns.
 * Five minutes is long enough for an ordinary rolling move and short
 * enough that a stuck budget is reported rather than waited out.
 */
const DRAIN_TIMEOUT_SECONDS = 300;

/**
 * The pod owners whose pods a drain is right to leave alone.
 *
 * A DaemonSet pod is on the node because it is that node's copy —
 * evicting it only makes the DaemonSet put it back — and the CNI and
 * the CSI driver are both DaemonSets, so evicting them would take away
 * the networking and storage the eviction of everything else needs. A
 * mirror pod is owned by the Node object itself: it comes from a file
 * on disk, the API server only has a copy of it, and deleting the copy
 * changes nothing.
 */
const LEFT_IN_PLACE = ["DaemonSet", "Node"];

/**
 * How long the drain should wait, which a runner can shorten.
 *
 * Never zero, and that is not a stylistic preference: "kubectl drain
 * --timeout=0s" means wait forever rather than don't wait, so a
 * caller with no patience would get the opposite of what it asked
 * for.
 *
 * @param context
 * @returns
 */
function getDrainTimeout(context: any): number {
  const given = Number(context?.drainTimeout);

  return Number.isFinite(given) && given > 0
    ? Math.floor(given)
    : DRAIN_TIMEOUT_SECONDS;
}

/**
 * Whether the cluster has a node to drain at all.
 *
 * @param context
 * @returns
 */
function isInCluster(context: any): boolean {
  return context?.nodeInCluster === true;
}

/**
 * The pods still on a node that a drain was supposed to move.
 *
 * Printed one per line as "namespace/name|owner" so that the check
 * reading it can say which pods stayed and what they belong to.
 *
 * @param name the node, quoted for the shell
 * @returns
 */
function remainingPodsCommand(name: string): string {
  const template =
    "{range .items[*]}{.metadata.namespace}{\"/\"}{.metadata.name}{\"|\"}{.metadata.ownerReferences[0].kind}{\"\\n\"}{end}";

  const filters = LEFT_IN_PLACE.map(
    (kind) => ` | grep -v '|${kind}$'`,
  ).join("");

  return (
    `kubectl get pods --all-namespaces --field-selector spec.nodeName=${name}` +
    ` -o jsonpath=${quoteForShell(template)} 2>/dev/null${filters} | grep . || true`
  );
}

export const DrainCommands: CommandSpec[] = [
  /**
   * Is there anything to drain?
   *
   * A node that was never in the cluster, or that was removed by an
   * earlier attempt, is not a failure: it is the ordinary state of
   * something half torn down, and the whole bundle should step over
   * it rather than stopping on it. Everything after this is skipped
   * when the answer is no.
   */
  {
    name: "check-node-in-cluster",
    purpose: CommandPurpose.Inspect,
    description: "Find out whether the cluster still knows this node",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.EachNode,
    env: buildKubeEnv,
    command: (_config: CloudConfig, context: any) => {
      const name = quoteForShell(getClusterNodeName(context));

      return `kubectl get node ${name} -o json 2>/dev/null || echo '{}'`;
    },
    output: OutputType.Json,
    saveToContext: (output: any, context: any) => {
      const name = getClusterNodeName(context);
      const node = output.parsed;
      const known = node?.metadata?.name !== undefined;

      console.log(
        known
          ? `${name} is in the cluster${node?.spec?.unschedulable === true ? " and already cordoned" : ""}`
          : `${name} isn't in the cluster, so there is nothing to drain`,
      );

      return { nodeInCluster: known };
    },
  },

  /**
   * Stop anything new landing on it.
   *
   * Drain cordons the node itself, so this looks redundant and isn't:
   * a drain that fails partway through has already evicted pods, and
   * without a cordon of its own the scheduler would be free to put
   * work back onto a node somebody is in the middle of taking away.
   * Cordoning first means a failed drain leaves the node emptier
   * rather than churning.
   */
  {
    name: "cordon-node",
    description: "Mark the node unschedulable so nothing new lands on it",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.EachNode,
    skipWhen: (_config: CloudConfig, context: any) => !isInCluster(context),
    env: buildKubeEnv,
    command: (_config: CloudConfig, context: any) => {
      const name = quoteForShell(getClusterNodeName(context));

      return `kubectl cordon ${name} || { echo "Couldn't cordon ${getClusterNodeName(context)}." >&2; exit 1; }`;
    },
    output: OutputType.Raw,
  },

  /**
   * Move the work off.
   */
  {
    name: "drain-node",
    description: "Evict the pods on the node, respecting disruption budgets",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.EachNode,
    skipWhen: (_config: CloudConfig, context: any) => !isInCluster(context),
    env: buildKubeEnv,
    command: (_config: CloudConfig, context: any) => {
      const readable = getClusterNodeName(context);
      const name = quoteForShell(readable);
      const seconds = getDrainTimeout(context);

      return [
        `kubectl drain ${name} --ignore-daemonsets --delete-emptydir-data --timeout=${seconds}s && exit 0`,

        // kubectl has already said what it couldn't move; this says
        // what the two likely reasons mean and what to do about each,
        // since they want opposite things done
        `echo "Couldn't drain ${readable} within ${seconds}s." >&2`,
        `echo "Pods belonging to no controller are not evicted, because nothing would put them back — delete them yourself if they are disposable." >&2`,
        `echo "A pod that stays put is usually held by a PodDisruptionBudget that can't be satisfied while this node is going away. Check with: kubectl get pdb --all-namespaces" >&2`,
        `echo "To take the node apart anyway, run the uninstall again with --skip-drain, which stops the workloads rather than moving them." >&2`,
        "exit 1",
      ];
    },
    output: OutputType.Raw,
  },

  /**
   * And say whether it actually emptied.
   *
   * Separate from the drain because "kubectl drain returned" and "the
   * node is empty" are different claims: an eviction is a request the
   * API server accepts and a kubelet then carries out, so a pod can be
   * accepted for eviction and still be terminating when the drain
   * comes back. It is also the check the doctor would run if asked
   * about this bundle by name, and a check that only holds when it is
   * run directly after the thing it checks is not much of a check.
   */
  {
    name: "verify-node-drained",
    purpose: CommandPurpose.Verify,
    description: "Verify nothing but DaemonSet pods is left on the node",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.EachNode,
    skipWhen: (_config: CloudConfig, context: any) => !isInCluster(context),
    env: buildKubeEnv,
    command: (_config: CloudConfig, context: any) => {
      const readable = getClusterNodeName(context);
      const name = quoteForShell(readable);

      return [
        `left=$(${remainingPodsCommand(name)})`,
        `[ -z "$left" ] || { echo "${readable} still has pods on it that a drain should have moved:" >&2; echo "$left" >&2; exit 1; }`,
        `echo "${readable} is drained — only its DaemonSet pods are left, which is as empty as a node gets"`,
      ];
    },
    output: OutputType.Raw,
  },
];
