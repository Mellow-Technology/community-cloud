/**
 * @file
 * Tell the cluster what it is.
 *
 * A cluster knows a great deal about itself and nothing at all about
 * why it was built that way. Every command in here works from a
 * configuration file on somebody's laptop, and nothing in the cluster
 * says which file that was, or whether the cluster still matches it.
 *
 * So the configuration goes into the cluster, as a ConfigMap in
 * kube-system called "community-cloud". That does two jobs. Finding it
 * is how anything can tell this is a Community Cloud cluster rather
 * than some other K3s. Reading it is how a command can tell whether
 * the file it was handed describes the cluster it's pointed at — which
 * is the difference between installing and reinstalling, and between a
 * cluster that has drifted and one that hasn't.
 *
 * What goes in is the configuration with the secrets taken out. A
 * ConfigMap is readable by anything that can read ConfigMaps, which is
 * a great deal of the cluster, so the cluster token and the registry
 * passwords stay in the file they came from. What's left is still the
 * useful part: the nodes, their roles, the packages, the networking.
 *
 * Requires:
 * - a running cluster with a readable kubeconfig
 */
import { parse, stringify } from "yaml";

import {
  CommandOutput,
  CommandPurpose,
  CommandSpec,
  CommandTarget,
  OutputType,
} from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { REDACTED, findSecrets, redact } from "../../util/redact.ts";

// Where it lives. kube-system because this is about the cluster
// itself, and because it exists before anything else does.
export const CLUSTER_CONFIG_NAME = "community-cloud";
export const CLUSTER_CONFIG_NAMESPACE = "kube-system";

// The keys inside it. The configuration is one document rather than a
// key per setting, so that reading it back gives you the same shape
// the file has.
const CONFIG_KEY = "config.yaml";
const UPDATED_KEY = "updated";
const INSTALLER_KEY = "installer";

// What wrote it, so a cluster built by an older installer can say so
const INSTALLER_VERSION = "1.0.0";

/**
 * What the cluster has stored about itself.
 */
export interface StoredClusterConfig {
  found: boolean;
  config?: any;
  updated?: string;
  installer?: string;
}

/**
 * The configuration as it should be stored: no secrets.
 *
 * @param config
 * @returns
 */
export function buildStoredConfig(config: CloudConfig): any {
  return redact(config.getConfig());
}

/**
 * The ConfigMap that marks this as a Community Cloud cluster.
 *
 * @param config
 * @returns
 */
export function buildClusterConfigMap(config: CloudConfig): string {
  const document = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: CLUSTER_CONFIG_NAME,
      namespace: CLUSTER_CONFIG_NAMESPACE,
      labels: {
        "app.kubernetes.io/managed-by": "community-cloud",
        "app.kubernetes.io/part-of": "community-cloud",
      },
    },
    data: {
      [CONFIG_KEY]: stringify(buildStoredConfig(config)),
      [UPDATED_KEY]: new Date().toISOString(),
      [INSTALLER_KEY]: INSTALLER_VERSION,
    },
  };

  return [
    "# Managed by Community Cloud",
    "# The configuration this cluster was built from, with the secrets",
    "# taken out. Edited here it will be overwritten; edit the file.",
    stringify(document),
  ].join("\n");
}

/**
 * Read what the cluster has stored, from a kubectl response.
 *
 * A cluster with nothing stored is the ordinary case rather than a
 * failure: it's either not a Community Cloud cluster, or it's one
 * from before this existed.
 *
 * @param output
 * @returns
 */
export function readStoredConfig(output: CommandOutput): StoredClusterConfig {
  const parsed: any = output.parsed;
  const data = parsed !== undefined && parsed !== null ? parsed.data : undefined;

  if (data === undefined || data === null || data[CONFIG_KEY] === undefined) {
    return { found: false };
  }

  try {
    return {
      found: true,
      config: parse(data[CONFIG_KEY]),
      updated: data[UPDATED_KEY],
      installer: data[INSTALLER_KEY],
    };
  } catch (error: any) {
    throw new Error(
      `This cluster has a "${CLUSTER_CONFIG_NAME}" ConfigMap, but the configuration in it isn't readable: ${error.message}`,
    );
  }
}

/**
 * One way in which the cluster and the file disagree.
 */
export interface Difference {
  path: string;
  stored: unknown;
  current: unknown;
}

/**
 * Compare what the cluster has against what the file says.
 *
 * Redacted values are skipped on both sides. A secret compares equal
 * to itself and to every other secret once it's been replaced, so the
 * only thing comparing them could produce is a false sense of having
 * checked.
 *
 * @param stored
 * @param current
 * @param path
 * @returns
 */
export function compareConfigurations(
  stored: any,
  current: any,
  path: string[] = [],
): Difference[] {
  if (stored === REDACTED || current === REDACTED) {
    return [];
  }

  const bothObjects =
    stored !== null &&
    current !== null &&
    typeof stored === "object" &&
    typeof current === "object" &&
    Array.isArray(stored) === Array.isArray(current);

  if (!bothObjects) {
    return sameValue(stored, current)
      ? []
      : [{ path: path.join(".") || "(whole configuration)", stored, current }];
  }

  const keys = [...new Set([...Object.keys(stored), ...Object.keys(current)])];

  return keys.flatMap((key) =>
    compareConfigurations(stored[key], current[key], [...path, key]),
  );
}

/**
 * Whether two plain values are the same, treating the several ways of
 * saying "nothing" as one thing.
 *
 * @param one
 * @param other
 * @returns
 */
function sameValue(one: unknown, other: unknown): boolean {
  const missing = (value: unknown) => value === undefined || value === null;

  if (missing(one) && missing(other)) {
    return true;
  }

  return one === other;
}

/**
 * Describe a value briefly enough to sit on one line.
 *
 * @param value
 * @returns
 */
function describe(value: unknown): string {
  if (value === undefined) {
    return "not set";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "object") {
    return Array.isArray(value) ? `${value.length} entries` : "a section";
  }

  return JSON.stringify(value);
}

/**
 * Read the ConfigMap, whether or not there is one.
 */
const readClusterConfig = [
  `kubectl -n ${CLUSTER_CONFIG_NAMESPACE} get configmap ${CLUSTER_CONFIG_NAME} -o json 2>/dev/null || echo '{}'`,
];

export const ClusterConfigCommands: CommandSpec[] = [
  /**
   * Is this a Community Cloud cluster, and which one?
   */
  {
    name: "check-cluster-identity",
    description: "Find out whether this cluster is a Community Cloud cluster",
    purpose: CommandPurpose.Inspect,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: readClusterConfig,
    output: OutputType.Json,
    postProcessHooks: [readStoredConfig],
    saveToContext: (output: any) => {
      const stored: StoredClusterConfig = output.processed;

      if (!stored.found) {
        console.log(
          `  No "${CLUSTER_CONFIG_NAME}" ConfigMap in ${CLUSTER_CONFIG_NAMESPACE}. Either this isn't a Community Cloud cluster, or it was built before the cluster kept a record of itself.`,
        );
        return { clusterIsCommunityCloud: false };
      }

      const nodes = Array.isArray(stored.config?.nodes) ? stored.config.nodes.length : 0;
      console.log(
        `  A Community Cloud cluster of ${nodes} node${nodes === 1 ? "" : "s"}, last configured ${stored.updated ?? "at an unknown time"} by installer ${stored.installer ?? "unknown"}`,
      );

      return {
        clusterIsCommunityCloud: true,
        clusterConfig: stored.config,
        clusterConfigUpdated: stored.updated,
      };
    },
  },

  /**
   * Put the configuration in the cluster.
   *
   * Over standard input, like every other manifest, so that nothing is
   * written to the control plane and the whole document doesn't have
   * to survive being quoted into a command line.
   */
  {
    name: "write-cluster-config",
    description: "Record this cluster's configuration in the cluster itself",
    purpose: CommandPurpose.Apply,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: "kubectl apply -f -",
    stdin: (config: CloudConfig) => buildClusterConfigMap(config),
    output: OutputType.Raw,
    saveToContext: (_output: any, _context: any, config: CloudConfig) => {
      const secrets = findSecrets(config.getConfig());

      console.log(
        secrets.length > 0
          ? `  Kept out of the cluster: ${secrets.join(", ")}`
          : "  Nothing in this configuration needed keeping out",
      );

      return { clusterConfigWritten: true };
    },
  },

  /**
   * Does the cluster still match the file?
   *
   * The interesting answer is usually neither yes nor no but "in these
   * three places", which is why this lists them rather than stopping
   * at the first.
   */
  {
    name: "verify-cluster-config",
    description: "Check the cluster's record matches the configuration file",
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: readClusterConfig,
    output: OutputType.Json,
    postProcessHooks: [readStoredConfig],
    saveToContext: (output: any, _context: any, config: CloudConfig) => {
      const stored: StoredClusterConfig = output.processed;

      if (!stored.found) {
        throw new Error(
          `This cluster has no "${CLUSTER_CONFIG_NAME}" ConfigMap, so there's nothing to compare the configuration against. Run the "cluster" bundle to record it.`,
        );
      }

      const differences = compareConfigurations(stored.config, buildStoredConfig(config));

      if (differences.length === 0) {
        console.log("  The cluster matches the configuration file");
        return { clusterConfigMatches: true, clusterConfigDifferences: [] };
      }

      for (const { path, stored: was, current: now } of differences) {
        console.log(`  ${path}: cluster has ${describe(was)}, file says ${describe(now)}`);
      }

      throw new Error(
        `The cluster's record differs from this configuration file in ${differences.length} place${differences.length === 1 ? "" : "s"}. Either the file has moved on and the cluster needs reconfiguring, or this is the wrong file for this cluster.`,
      );
    },
  },
];
