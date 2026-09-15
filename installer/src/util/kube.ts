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
