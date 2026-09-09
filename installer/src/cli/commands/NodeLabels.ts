/**
 * @file
 * Label a node so workloads can be scheduled onto it.
 *
 * Labels come from three places, and the point of this file is to
 * bring them together into one set that can be applied and then
 * checked:
 *
 * - roles, from "roles" on the node, applied as
 *   node-role.kubernetes.io/<role>=<role>, which is what the
 *   nodeSelectors in k8s/ are written against
 * - free-form labels, from "labels" on the node, written as given
 * - automatic labels, worked out from what earlier bundles found. A
 *   node with a GPU gets the worker-gpu role without anyone having to
 *   remember to write it down, which is the whole reason the gpu
 *   bundle puts its findings in the shared context.
 *
 * Every command here talks to the cluster, so every one of them runs
 * on the control plane rather than on the node being labelled. The
 * node is still the subject: it's named in the context, and kubectl
 * acts on it by name. That's what lets a pipeline read the hardware on
 * an agent and then label it, which is impossible from the agent
 * itself because it has no kubeconfig.
 *
 * Requires:
 * - a node with a type of "server" in the configuration
 */
import { CommandOutput, CommandSpec, CommandTarget, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { GpuVendor, NodeRole, VideoDevice } from "../../util/types.ts";
import { getNodeName } from "./K3s.ts";
import { quoteForShell } from "../../util/shell.ts";

// The prefix Kubernetes reads roles from
const ROLE_PREFIX = "node-role.kubernetes.io";

// Where automatic hardware labels live. Namespaced, so it's obvious
// which labels this installer owns and which came from elsewhere.
const GPU_PREFIX = "gpu.community-cloud.technology";

// K3s writes the cluster's kubeconfig here
const DEFAULT_KUBECONFIG = "/etc/rancher/k3s/k3s.yaml";

// How long to wait for a node to show up in the cluster. An agent
// that has just enrolled has its certificate before the API server
// has a Node object for it, so labelling straight after installing
// K3s would otherwise lose a race it can simply wait out.
const REGISTRATION_TIMEOUT_SECONDS = 120;

// What Kubernetes accepts. A label that doesn't match is rejected by
// the API server with a message about regular expressions, which is a
// poor way to find out a configuration has a typo in it.
const LABEL_NAME = /^[a-zA-Z0-9]([-_.a-zA-Z0-9]{0,61}[a-zA-Z0-9])?$/;
const LABEL_PREFIX = /^[a-z0-9]([-.a-z0-9]{0,251}[a-z0-9])?$/;

/**
 * The kubeconfig to use, which is K3s's own unless told otherwise.
 *
 * @param config
 * @returns
 */
function buildKubeEnv(config: CloudConfig): Record<string, string> {
  const { k3s } = config.getConfig();
  const kubeconfig =
    k3s !== undefined && k3s !== null && k3s.kubeconfig !== undefined
      ? k3s.kubeconfig
      : DEFAULT_KUBECONFIG;

  return { KUBECONFIG: kubeconfig };
}

/**
 * The name this node is registered under in the cluster.
 *
 * Taken from the same place the K3s install takes it, so the two
 * always agree about what the node is called.
 *
 * @param context
 * @returns
 */
function getClusterNodeName(context: any): string {
  const name = getNodeName(context);

  if (name === undefined) {
    throw new Error(
      `Couldn't work out what "${context.nodeName}" is called in the cluster. Give the node a name or address that can be a DNS label, or set "nodeName" on it.`,
    );
  }

  return name;
}

/**
 * The roles configured for this node.
 *
 * @param context
 * @returns
 */
function getConfiguredRoles(context: any): string[] {
  const node = context.node !== undefined && context.node !== null ? context.node : {};

  if (Array.isArray(node.roles)) {
    return node.roles;
  }

  // The old shape, where "labels" was a list of roles. Read as roles
  // so an unmigrated configuration labels its nodes correctly instead
  // of quietly stripping every role off them.
  if (Array.isArray(node.labels)) {
    return node.labels;
  }

  return [];
}

/**
 * The free-form labels configured for this node.
 *
 * @param context
 * @returns
 */
function getConfiguredLabels(context: any): Record<string, string> {
  const node = context.node !== undefined && context.node !== null ? context.node : {};

  // A node still using the old shape, where "labels" held roles
  if (Array.isArray(node.labels)) {
    console.warn(
      `⚠️  Node "${context.nodeName}" still lists its roles under "labels". Move them to "roles": free-form labels now live under "labels" as key and value pairs.`,
    );
    return {};
  }

  return node.labels !== undefined && node.labels !== null ? node.labels : {};
}

/**
 * Roles a node has earned rather than been given.
 *
 * Only what an earlier bundle actually found counts. When the gpu
 * bundle hasn't run there's nothing in the context to go on, and
 * guessing at hardware is worse than saying nothing.
 *
 * @param context
 * @returns
 */
function getAutomaticRoles(context: any): string[] {
  const roles: string[] = [];

  if (getComputeGpus(context).length > 0) {
    roles.push(NodeRole.WorkerGPU);
  }

  return roles;
}

/**
 * Labels describing the hardware an earlier bundle found.
 *
 * @param context
 * @returns
 */
function getAutomaticLabels(context: any): Record<string, string> {
  const gpus = getComputeGpus(context);

  if (gpus.length === 0) {
    return {};
  }

  const labels: Record<string, string> = {
    [`${GPU_PREFIX}/count`]: String(gpus.length),
  };

  // One vendor is the common case and the useful one to select on. A
  // node with cards from two vendors gets neither, rather than an
  // arbitrary winner.
  const vendors = [...new Set(gpus.map((gpu) => gpu.vendor))];
  if (vendors.length === 1 && vendors[0] !== GpuVendor.Unknown) {
    labels[`${GPU_PREFIX}/vendor`] = String(vendors[0]);
  }

  return labels;
}

/**
 * The GPUs on this node that a workload could actually use.
 *
 * @param context
 * @returns
 */
function getComputeGpus(context: any): VideoDevice[] {
  const devices = context.videoDevices;

  return Array.isArray(devices)
    ? devices.filter((device: VideoDevice) => device.compute)
    : [];
}

/**
 * Every label this node should end up with.
 *
 * Built in one place because two commands need to agree on it: one
 * applies it and the other checks it took.
 *
 * @param context
 * @returns
 */
export function buildDesiredLabels(context: any): Record<string, string> {
  const roles = [
    ...new Set([...getConfiguredRoles(context), ...getAutomaticRoles(context)]),
  ];

  const labels: Record<string, string> = {};

  // The manifests in k8s/ select on the role name as the value, e.g.
  // "node-role.kubernetes.io/storage-local: storage-local", so that's
  // what goes in rather than the empty value kubeadm uses
  for (const role of roles) {
    labels[`${ROLE_PREFIX}/${role}`] = role;
  }

  // Free-form labels last, so a node can correct something the rules
  // above worked out
  for (const [key, value] of Object.entries({
    ...getAutomaticLabels(context),
    ...getConfiguredLabels(context),
  })) {
    labels[key] = String(value);
  }

  for (const [key, value] of Object.entries(labels)) {
    checkLabel(key, value);
  }

  return labels;
}

/**
 * Role labels that should no longer be on this node.
 *
 * Reclassifying a node is only half done if the old role stays put, so
 * the roles this installer knows about are removed when they aren't
 * configured. Only those: a label we didn't put there isn't ours to
 * take away, which is what keeps K3s's own control-plane role safe.
 *
 * @param config
 * @param context
 * @returns
 */
export function buildStaleRoleLabels(config: CloudConfig, context: any): string[] {
  const desired = buildDesiredLabels(context);

  // Only what's actually on the node. Without having read it we know
  // of nothing to take away, which is the safe answer.
  const current = context.currentNodeLabels;
  const present = current !== undefined && current !== null ? current : {};

  // Everything this installer understands as a role: the roles it
  // defines, plus any role named by any node in the configuration
  const known = new Set<string>(Object.values(NodeRole));
  for (const node of getConfiguredNodes(config)) {
    for (const role of Array.isArray(node.roles) ? node.roles : []) {
      known.add(role);
    }
  }

  return [...known]
    .map((role) => `${ROLE_PREFIX}/${role}`)
    .filter((key) => desired[key] === undefined && present[key] !== undefined);
}

/**
 * The nodes a configuration describes.
 *
 * @param config
 * @returns
 */
function getConfiguredNodes(config: CloudConfig): any[] {
  const { nodes } = config.getConfig();
  return Array.isArray(nodes) ? nodes : [];
}

/**
 * Check a label is one Kubernetes will accept.
 *
 * @param key
 * @param value
 */
function checkLabel(key: string, value: string) {
  const parts = key.split("/");

  if (parts.length > 2) {
    throw new Error(
      `The label "${key}" has more than one "/". A label is an optional prefix, a slash, and a name.`,
    );
  }

  const name = parts.length === 2 ? parts[1] : parts[0];
  const prefix = parts.length === 2 ? parts[0] : undefined;

  if (name === undefined || !LABEL_NAME.test(name)) {
    throw new Error(
      `The label "${key}" isn't a valid name. Expected up to 63 letters, digits, dashes, underscores or dots, starting and ending with a letter or digit.`,
    );
  }

  if (prefix !== undefined && !LABEL_PREFIX.test(prefix)) {
    throw new Error(
      `The label "${key}" has a prefix that isn't a DNS subdomain. Expected something like "gpu.community-cloud.technology".`,
    );
  }

  if (value !== "" && !LABEL_NAME.test(value)) {
    throw new Error(
      `The label "${key}" has the value "${value}", which Kubernetes won't accept. Expected up to 63 letters, digits, dashes, underscores or dots, starting and ending with a letter or digit.`,
    );
  }
}

/**
 * Pull the labels out of a node as the API server reports it.
 *
 * @param output
 * @returns
 */
function readNodeLabels(output: CommandOutput): Record<string, string> {
  const node = output.parsed;
  const metadata = node !== undefined && node !== null ? node.metadata : undefined;

  return metadata !== undefined && metadata !== null && metadata.labels !== undefined
    ? metadata.labels
    : {};
}

export const NodeLabelCommands: CommandSpec[] = [
  /**
   * Check we can talk to the cluster, and that it knows this node.
   *
   * Labelling needs a kubeconfig, which a K3s agent doesn't have. That
   * shows up here with something worth reading rather than as a
   * connection refused three commands later.
   */
  {
    name: "check-cluster-access",
    description: "Check the cluster is reachable and knows this node",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: (_config: CloudConfig, context: any) => {
      const name = quoteForShell(getClusterNodeName(context));

      return [
        'command -v kubectl > /dev/null 2>&1 || { echo "kubectl isn\'t on the control plane, so nothing can be labelled. Check K3s is installed there." >&2; exit 1; }',
        `for attempt in $(seq ${REGISTRATION_TIMEOUT_SECONDS}); do kubectl get node ${name} > /dev/null 2>&1 && break; sleep 1; done`,
        `kubectl get node ${name} -o json 2>/dev/null || { echo "The cluster still has no node called ${name} after ${REGISTRATION_TIMEOUT_SECONDS}s. Check K3s is installed on it and that it has joined." >&2; exit 1; }`,
      ].join("\n");
    },
    output: OutputType.Json,
    postProcessHooks: [readNodeLabels],
    saveToContext: (output: any, context: any) => {
      const labels: Record<string, string> = output.processed;
      const roles = Object.keys(labels).filter((key) => key.startsWith(`${ROLE_PREFIX}/`));

      console.log(
        `${getClusterNodeName(context)} currently has ${Object.keys(labels).length} labels, ${roles.length} of them roles`,
      );

      return { currentNodeLabels: labels };
    },
  },

  /**
   * Apply them.
   */
  {
    name: "apply-node-labels",
    description: "Label the node with its roles and configured labels",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: (config: CloudConfig, context: any) => {
      const name = quoteForShell(getClusterNodeName(context));
      const desired = buildDesiredLabels(context);
      const stale = buildStaleRoleLabels(config, context);

      if (Object.keys(desired).length === 0 && stale.length === 0) {
        return `echo "Nothing configured to label ${name} with"`;
      }

      const commands = [];

      if (Object.keys(desired).length > 0) {
        const pairs = Object.entries(desired)
          .map(([key, value]) => quoteForShell(`${key}=${value}`))
          .join(" ");

        // --overwrite so running this twice is the same as running it
        // once, and so a role whose value changed is corrected
        commands.push(`kubectl label node ${name} --overwrite ${pairs}`);
      }

      // A trailing "-" takes a label off. These are only ever labels
      // the node was found to have, so a failure here is a real one.
      if (stale.length > 0) {
        const removals = stale.map((key) => quoteForShell(`${key}-`)).join(" ");
        commands.push(`kubectl label node ${name} ${removals}`);
      }

      return commands.join("\n");
    },
    output: OutputType.Raw,
  },

  /**
   * Read them back.
   *
   * Applying a label and having the node carry it are not the same
   * claim, so this asks the cluster what the node actually has and
   * compares it with what was asked for.
   */
  {
    name: "verify-node-labels",
    description: "Check the node ended up with the labels it was meant to",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: (_config: CloudConfig, context: any) =>
      `kubectl get node ${quoteForShell(getClusterNodeName(context))} -o json`,
    output: OutputType.Json,
    postProcessHooks: [readNodeLabels],
    saveToContext: (output: any, context: any, config: CloudConfig) => {
      const actual: Record<string, string> = output.processed;
      const desired = buildDesiredLabels(context);
      const stale = buildStaleRoleLabels(config, context);

      const wrong: string[] = [];

      for (const [key, value] of Object.entries(desired)) {
        if (actual[key] === undefined) {
          wrong.push(`${key} is missing`);
          continue;
        }

        if (actual[key] !== value) {
          wrong.push(`${key} is "${actual[key]}", expected "${value}"`);
          continue;
        }

        console.log(`  ✅ ${key}=${value}`);
      }

      for (const key of stale) {
        if (actual[key] !== undefined) {
          wrong.push(`${key} should have been removed but is still "${actual[key]}"`);
        }
      }

      if (wrong.length > 0) {
        throw new Error(
          `The node's labels don't match what was configured: ${wrong.join("; ")}.`,
        );
      }

      console.log(
        `${Object.keys(desired).length} label${Object.keys(desired).length === 1 ? "" : "s"} applied and verified on ${getClusterNodeName(context)}`,
      );

      return { nodeLabels: actual };
    },
  },
];
