/**
 * @file
 * The two questions adding a node to a running cluster has to answer.
 *
 * Before: is there a cluster to join? Adding a machine to something
 * that isn't up is the one failure worth catching early, because every
 * step after it will fail in a way that blames the new node for a
 * problem the cluster already had.
 *
 * After: did it join, and is it working? An agent finishing its
 * install means systemd started something. Whether the cluster has
 * accepted it, scheduled to it, and got a network onto it is a
 * different question, and it can only be asked from a server.
 *
 * Both are cluster-facing, so every command here runs on the control
 * plane. The node being added is still the subject — it's named in the
 * context and kubectl acts on it by name — which is exactly the split
 * between "where the shell runs" and "who the step is for" that the
 * scopes exist to express.
 *
 * These are their own bundles rather than part of k3s because they say
 * nothing about installing K3s. They are about a cluster that already
 * exists, which is why the doctor runs them too: "is the API up" and
 * "is every node Ready" are the first two things anybody asks.
 */
import {
  CommandOutput,
  CommandPurpose,
  CommandScope,
  CommandSpec,
  CommandTarget,
  OutputType,
} from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { getClusterNodeName } from "./K3s.ts";
import { getWaitSeconds, quoteForShell } from "../../util/shell.ts";

// How long to give a new node to go Ready. An agent registers with the
// API server well before its network is up, and Cilium has to schedule
// an agent pod onto it and program the datapath before the kubelet
// stops reporting NotReady.
const READY_TIMEOUT_SECONDS = 180;

/**
 * Whether a node the API server described is Ready.
 *
 * Ready is a stronger claim than it looks: the kubelet reports
 * NotReady until the network plugin has set the node up, so a node
 * that says Ready has a working CNI on it as well as a running
 * kubelet.
 *
 * @param node
 * @returns
 */
function isReady(node: any): boolean {
  const conditions = node?.status?.conditions;

  return (
    Array.isArray(conditions) &&
    conditions.some(
      (condition: any) => condition.type === "Ready" && condition.status === "True",
    )
  );
}

/**
 * The nodes in a cluster, as the API server sees them.
 *
 * @param output
 * @returns
 */
function readNodes(output: CommandOutput): any[] {
  const items = output.parsed?.items;

  return Array.isArray(items) ? items : [];
}

export const ClusterOnlineCommands: CommandSpec[] = [
  /**
   * Is there a cluster here at all?
   */
  {
    name: "check-cluster-online",
    purpose: CommandPurpose.Require,
    description: "Check the cluster is up and answering",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.Cluster,
    env: buildKubeEnv,
    command: [
      'command -v kubectl > /dev/null 2>&1 || { echo "kubectl isn\'t on the control plane, so there\'s nothing here to join. Check K3s is installed and running on it." >&2; exit 1; }',
      'kubectl get --raw=/readyz > /dev/null 2>&1 || { echo "The Kubernetes API server isn\'t answering on the control plane. A node can\'t join a cluster that isn\'t up — check K3s there first." >&2; exit 1; }',
      "kubectl get nodes -o json",
    ],
    output: OutputType.Json,
    postProcessHooks: [readNodes],
    saveToContext: (output: any) => {
      const nodes: any[] = output.processed;
      const ready = nodes.filter(isReady);

      console.log(
        `The cluster has ${nodes.length} node${nodes.length === 1 ? "" : "s"}, ${ready.length} of them Ready`,
      );

      return { clusterNodeNames: nodes.map((node: any) => node?.metadata?.name) };
    },
  },

  /**
   * And does it already know the node being added?
   *
   * Not a failure either way. Re-running an agent install over a node
   * that's already in the cluster is a legitimate thing to do — it's
   * how a broken node gets repaired — and it is worth knowing that's
   * what is about to happen.
   */
  {
    name: "check-node-known",
    purpose: CommandPurpose.Inspect,
    description: "Say whether the cluster already knows this node",
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
      const known = output.parsed?.metadata?.name !== undefined;

      console.log(
        known
          ? `${name} is already in the cluster${isReady(output.parsed) ? " and Ready" : " and not Ready"}, so this will be run over the top of it`
          : `${name} isn't in the cluster yet`,
      );

      return { alreadyInCluster: known };
    },
  },
];

export const NodeJoinedCommands: CommandSpec[] = [
  /**
   * Give it a moment.
   */
  {
    name: "wait-for-node-ready",
    purpose: CommandPurpose.Settle,
    description: "Wait for the node to go Ready in the cluster",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.EachNode,
    env: buildKubeEnv,
    command: (_config: CloudConfig, context: any) => {
      const seconds = getWaitSeconds(context, READY_TIMEOUT_SECONDS);

      if (seconds === 0) {
        return "true";
      }

      const name = quoteForShell(getClusterNodeName(context));

      // Waiting is this command's whole job and complaining isn't:
      // the check after it says what went wrong, with the node's own
      // conditions in the message
      return `kubectl wait --for=condition=Ready node/${name} --timeout=${seconds}s > /dev/null 2>&1 || true`;
    },
    output: OutputType.Raw,
  },

  /**
   * And then say whether it worked.
   */
  {
    name: "verify-node-ready",
    purpose: CommandPurpose.Verify,
    description: "Verify the node has joined the cluster and is Ready",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.EachNode,
    env: buildKubeEnv,
    command: (_config: CloudConfig, context: any) => {
      const name = quoteForShell(getClusterNodeName(context));

      return [
        `kubectl get node ${name} > /dev/null 2>&1 || { echo "The cluster has no node called ${getClusterNodeName(context)}. It never registered, so it hasn't joined." >&2; exit 1; }`,

        // A node is NotReady until its network plugin has set it up,
        // so this covers rather more than the kubelet being alive
        `ready=$(kubectl get node ${name} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')`,
        `[ "$ready" = "True" ] || { echo "${getClusterNodeName(context)} is in the cluster and isn't Ready. Its conditions are below — a node that registered and stays NotReady is usually waiting on the CNI." >&2; kubectl get node ${name} -o wide >&2; kubectl describe node ${name} 2>/dev/null | sed -n '/Conditions:/,/Addresses:/p' >&2; exit 1; }`,

        `kubectl get node ${name} -o wide`,
      ];
    },
    output: OutputType.Raw,
  },
];
