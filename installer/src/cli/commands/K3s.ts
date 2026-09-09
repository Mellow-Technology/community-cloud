/**
 * @file
 * Install K3s on a node, as either a server or an agent.
 *
 * Which one a node gets is its own business: the "type" on a node in
 * the configuration decides, so the same bundle can be pointed at any
 * node in the cluster.
 *
 * Both installs assume Cilium is the CNI. That means the server has to
 * be told not to bring up the things Cilium replaces, because K3s
 * bundles flannel, its own network policy controller and kube-proxy,
 * and starting those alongside Cilium leaves two implementations
 * fighting over the same datapath.
 *
 * Requires:
 * - curl
 * - sudo, which the K3s install script uses itself for the privileged
 *   parts, so these commands don't set the sudo flag
 */
import { CommandSpec, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { K3SInstallationType } from "../../util/types.ts";
import { quoteForShell } from "../../util/shell.ts";

// Where the install script comes from
const K3S_INSTALL_URL = "https://get.k3s.io";

// The pod CIDR. Cilium hands out pod IPs from its own pool, so this
// wants to agree with clusterPoolIPv4PodCIDRList in the Cilium values.
const DEFAULT_CLUSTER_CIDR = "10.42.0.0/16";

// How long to wait for a freshly installed node to come up before
// giving up on it
const READY_TIMEOUT_SECONDS = 180;

// A Kubernetes node name has to be a DNS label
const NODE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The k3s section of a Community Cloud configuration.
 *
 * - token: the cluster token, shared by the server and its agents
 * - version / channel: pin the K3s release, otherwise the install
 *   script takes the current stable one
 * - clusterCidr: the pod network CIDR
 * - disable: K3s packaged components to leave out, e.g. "traefik"
 * - extraServerArgs / extraAgentArgs: anything else to pass through
 */
interface K3sConfig {
  token?: string;
  version?: string;
  channel?: string;
  clusterCidr?: string;
  disable?: string[];
  extraServerArgs?: string[];
  extraAgentArgs?: string[];
}

/**
 * Read the k3s section of the configuration.
 *
 * @param config
 * @returns
 */
function getK3sConfig(config: CloudConfig): K3sConfig {
  const { k3s } = config.getConfig();
  return k3s !== undefined && k3s !== null ? k3s : {};
}

/**
 * Whether Cilium is taking over from kube-proxy. This mirrors
 * kubeProxyReplacement in the Cilium values, which is on by default,
 * and decides whether K3s should start kube-proxy at all.
 *
 * @param config
 * @returns
 */
function replacesKubeProxy(config: CloudConfig): boolean {
  const { network } = config.getConfig();
  const cilium = network !== undefined && network !== null ? network.cilium : undefined;

  return cilium === undefined || cilium.kubeProxyReplacement !== false;
}

/**
 * The cluster token. Agents use it to join, and the server is
 * installed with it so that they can.
 *
 * @param config
 * @returns
 */
function getToken(config: CloudConfig): string {
  const { token } = getK3sConfig(config);
  if (token === undefined || token === "") {
    throw new Error(
      'No K3s token is set in the configuration. Add one under "k3s.token".',
    );
  }

  return token;
}

/**
 * Whether the node being installed is a server or an agent.
 *
 * @param context
 * @returns
 */
function getInstallationType(context: any): K3SInstallationType {
  const type = context.node !== undefined && context.node !== null
    ? context.node.type
    : undefined;

  if (type !== K3SInstallationType.Server && type !== K3SInstallationType.Agent) {
    throw new Error(
      `Node "${context.nodeName}" doesn't say whether it's a server or an agent. Set "type" on it to "${K3SInstallationType.Server}" or "${K3SInstallationType.Agent}".`,
    );
  }

  return type;
}

/**
 * The systemd unit the install leaves behind, which differs between
 * the two installation types.
 *
 * @param context
 * @returns
 */
function getServiceName(context: any): string {
  return getInstallationType(context) === K3SInstallationType.Server
    ? "k3s"
    : "k3s-agent";
}

/**
 * The name the node should register under.
 *
 * Node names are DNS labels, while the names in a configuration are
 * written for people to read ("Mamoru BKK"), so we take the first of
 * the name and the address that can serve as one. Finding neither is
 * not a problem worth stopping for: K3s falls back to the hostname.
 *
 * @param context
 * @returns
 */
export function getNodeName(context: any): string | undefined {
  const node = context.node !== undefined && context.node !== null ? context.node : {};

  for (const candidate of [node.nodeName, node.name, node.address]) {
    if (typeof candidate === "string" && NODE_NAME.test(candidate.toLowerCase())) {
      return candidate.toLowerCase();
    }
  }

  return undefined;
}

/**
 * Build the arguments K3s is started with.
 *
 * Anything K3s reads from the environment is left out of here on
 * purpose and passed as a variable instead, so this only carries the
 * settings that have nowhere else to go.
 *
 * @param config
 * @param context
 * @returns
 */
function buildInstallExec(config: CloudConfig, context: any): string {
  const { clusterCidr, disable, extraServerArgs, extraAgentArgs } = getK3sConfig(config);
  const installationType = getInstallationType(context);

  // The agent takes no Cilium flags of its own. Agents are handed
  // their networking configuration by the server when they join, so
  // the server disabling kube-proxy covers them too, and K3s rejects
  // --disable-kube-proxy on an agent outright.
  if (installationType === K3SInstallationType.Agent) {
    const agentArgs = extraAgentArgs !== undefined ? extraAgentArgs : [];
    return [K3SInstallationType.Agent, ...agentArgs].join(" ");
  }

  const args = [
    K3SInstallationType.Server,

    // Cilium is the CNI, so K3s shouldn't bring up flannel
    "--flannel-backend=none",

    // Cilium enforces network policy
    "--disable-network-policy",

    // Pod IPs come from Cilium's pool, so both sides need to agree
    `--cluster-cidr=${clusterCidr !== undefined ? clusterCidr : DEFAULT_CLUSTER_CIDR}`,
  ];

  // Cilium's eBPF datapath does kube-proxy's job when it's set to
  if (replacesKubeProxy(config)) {
    args.push("--disable-kube-proxy");
  }

  // Packaged components the cluster doesn't want
  for (const component of disable !== undefined ? disable : []) {
    args.push(`--disable=${component}`);
  }

  return [...args, ...(extraServerArgs !== undefined ? extraServerArgs : [])].join(" ");
}

/**
 * Build the environment the install script runs with.
 *
 * K3s reads most of what it needs from the environment, so settings go
 * here rather than into flags wherever it offers the choice. That
 * keeps the token off the command line, where it would otherwise show
 * up in a process listing for anyone on the node.
 *
 * @param config
 * @param context
 * @returns
 */
function buildInstallEnv(config: CloudConfig, context: any): Record<string, string | undefined> {
  const { version, channel } = getK3sConfig(config);
  const installationType = getInstallationType(context);

  const env: Record<string, string | undefined> = {
    // The subcommand and everything with no environment variable
    INSTALL_K3S_EXEC: buildInstallExec(config, context),

    // Shared by the server and every agent that joins it
    K3S_TOKEN: getToken(config),

    // Otherwise K3s takes whatever the machine calls itself
    K3S_NODE_NAME: getNodeName(context),

    // Left unset unless the configuration pins a release
    INSTALL_K3S_VERSION: version,
    INSTALL_K3S_CHANNEL: channel,
  };

  if (installationType === K3SInstallationType.Agent) {
    // Where to find the cluster to join
    env.K3S_URL = config.getControlPlaneUrl();
  }
  else {
    // Let the node's own user read the kubeconfig, so that everything
    // afterwards doesn't have to go through sudo to talk to the cluster
    env.K3S_KUBECONFIG_MODE = "644";
  }

  return env;
}

/**
 * Poll a check until it passes, or until we've waited long enough.
 *
 * Written as one loop rather than joined with the commands around it,
 * since "do" takes the body straight after it with no separator.
 *
 * @param check
 * @returns
 */
function waitUntil(check: string): string {
  return `for attempt in $(seq ${READY_TIMEOUT_SECONDS}); do ${check} && break; sleep 1; done`;
}

export const K3sCommands: CommandSpec[] = [
  /**
   * Install K3s itself. The install script works out that it isn't
   * root and uses sudo for the parts that need it, so this runs as the
   * connecting user and the environment survives to reach it.
   *
   * The script is fetched to a file first rather than piped straight
   * into a shell. In a pipeline the shell's exit status is the one
   * that counts, so a curl that fails hands an empty script to a shell
   * that reads nothing, does nothing, and reports success. That is a
   * miserable thing to debug: the install looks like it worked and the
   * node never comes up.
   */
  {
    name: "install-k3s",
    description: "Install K3s and start it as a server or an agent",
    env: buildInstallEnv,
    command: () =>
      [
        "installer=$(mktemp)",
        `curl -fsSL ${K3S_INSTALL_URL} -o "$installer" || { echo "Couldn't download the K3s install script from ${K3S_INSTALL_URL}" >&2; rm -f "$installer"; exit 1; }`,
        `test -s "$installer" || { echo "The K3s install script came back empty" >&2; rm -f "$installer"; exit 1; }`,
        'sh "$installer"',
        "status=$?",
        'rm -f "$installer"',
        "exit $status",
      ].join("; "),
    output: OutputType.Raw,
  },

  /**
   * Wait for the service to settle. The install script returns once
   * systemd has been told to start K3s, which is a good while before
   * an agent has actually talked to the server.
   */
  {
    name: "wait-for-k3s",
    description: "Wait for the K3s service to come up",
    command: (config: CloudConfig, context: any) => {
      const service = getServiceName(context);

      return [
        waitUntil(`systemctl is-active --quiet ${service}`),
        `systemctl is-active --quiet ${service} || { echo "${service} didn't come up within ${READY_TIMEOUT_SECONDS}s" >&2; systemctl status ${service} --no-pager --lines=20 >&2; exit 1; }`,
        `echo "${service} is active"`,
      ].join("; ");
    },
    output: OutputType.Raw,
  },

  /**
   * Check the node is actually working rather than merely running.
   *
   * A server can be asked directly, since it has a kubeconfig. An
   * agent has no way to query the cluster, so we look for the
   * credentials the server issues it: they only appear once the agent
   * has reached the server, been accepted, and had its certificate
   * signed, which is the whole of what joining means.
   */
  {
    name: "verify-k3s",
    description: "Verify the node has joined and is working",
    command: (config: CloudConfig, context: any) => {
      if (getInstallationType(context) === K3SInstallationType.Server) {
        const nodeName = getNodeName(context);

        return [
          waitUntil("k3s kubectl get nodes >/dev/null 2>&1"),
          "k3s kubectl get nodes -o wide",
          nodeName !== undefined
            ? `k3s kubectl get node ${quoteForShell(nodeName)} >/dev/null || { echo "${nodeName} hasn't registered with the cluster" >&2; exit 1; }`
            : "true",
        ].join("; ");
      }

      // Written by the agent only after the server has accepted it
      const kubeletConfig = "/var/lib/rancher/k3s/agent/kubelet.kubeconfig";
      const clientCert = "/var/lib/rancher/k3s/agent/client-kubelet.crt";

      return [
        waitUntil(`sudo test -s ${kubeletConfig} && sudo test -s ${clientCert}`),
        `sudo test -s ${kubeletConfig} || { echo "The agent never got a kubelet config, so it hasn't joined the cluster" >&2; exit 1; }`,
        `sudo test -s ${clientCert} || { echo "The agent never got a signed client certificate, so the server hasn't accepted it" >&2; exit 1; }`,
        // The certificate is issued by the cluster CA and names the
        // node, so it says which cluster accepted it and as what
        `echo "joined as: $(sudo openssl x509 -in ${clientCert} -noout -subject 2>/dev/null)"`,
        `echo "server: $(sudo awk '/server:/ {print $2; exit}' ${kubeletConfig})"`,
        // Containers won't start without this
        `sudo test -S /run/k3s/containerd/containerd.sock || { echo "containerd isn't listening, so the agent can't run workloads" >&2; exit 1; }`,
        'echo "containerd is up"',
      ].join("; ");
    },
    output: OutputType.Raw,
  },
];
