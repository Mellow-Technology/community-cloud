/**
 * @file
 * Talking to the cluster from the control plane.
 */
import CloudConfig from "./CloudConfig.ts";

// K3s writes the cluster's kubeconfig here
export const DEFAULT_KUBECONFIG = "/etc/rancher/k3s/k3s.yaml";

// The prefix Kubernetes reads roles from
export const ROLE_PREFIX = "node-role.kubernetes.io";

/**
 * The environment a kubectl command needs.
 *
 * K3s puts the kubeconfig somewhere kubectl doesn't look by default,
 * so every command that talks to the cluster has to be told where it
 * is. A configuration can point somewhere else, for a cluster this
 * installer didn't build.
 *
 * @param config
 * @returns
 */
export function buildKubeEnv(config: CloudConfig): Record<string, string> {
  const { k3s } = config.getConfig();
  const kubeconfig =
    k3s !== undefined && k3s !== null && k3s.kubeconfig !== undefined
      ? k3s.kubeconfig
      : DEFAULT_KUBECONFIG;

  return { KUBECONFIG: kubeconfig };
}

// What reads the kubeconfig, and so has to be run as root to get at it
export const CLUSTER_TOOLS = ["kubectl", "helm", "cilium"];

/**
 * Lines that make the cluster's tools run as root, for a command that
 * talks to the cluster.
 *
 * K3s writes its kubeconfig readable by root alone, and it holds
 * cluster-admin: anyone who can read it owns the cluster. Rather than
 * loosen that so the connecting user can read it, every tool that
 * needs it goes through sudo. Done as shell functions put in front of
 * the command, not by writing sudo into every line that calls kubectl,
 * so a command can't forget, and so plugins get the same.
 *
 * - The binary is found before the function that shadows it exists,
 *   and called by path: sudo's secure_path may not reach where it was
 *   installed.
 * - sudo clears the environment, so whatever the command was given —
 *   KUBECONFIG above all — is passed through env by name.
 * - -n so a sudo that wants a password fails rather than waits.
 *   Preflight has already said whether it does.
 * - -H so Helm keeps its repositories and cache in root's home, the
 *   same one every time, rather than in whoever's HOME came through.
 *
 * Standard input goes straight through, which "kubectl apply -f -"
 * depends on.
 *
 * @param names the environment variables the command was given
 * @returns
 */
export function buildClusterToolPrelude(names: string[]): string[] {
  const passed = names.map((name) => `${name}="$${name}"`).join(" ");

  return CLUSTER_TOOLS.flatMap((tool) => [
    `cc_${tool}=$(command -v ${tool} 2>/dev/null)`,
    `${tool}() { sudo -n -H env ${passed} "\${cc_${tool}:-${tool}}" "$@"; }`,
  ]);
}
