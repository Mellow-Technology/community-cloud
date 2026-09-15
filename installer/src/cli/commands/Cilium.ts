/**
 * @file
 * Commands for setting up [Cilium](https://cilium.io/)
 *
 * Every command here runs on the control plane, which is where the
 * kubeconfig is and therefore where the CLI, the values file and the
 * install itself have to live. The bundle can be aimed at any node:
 * installing Cilium is a thing done to the cluster, not to a node,
 * and the runner opens the connection it needs.
 *
 * K3s is brought up with its own networking disabled, so until Cilium
 * is in place every node sits NotReady with no CNI: this bundle is
 * what finishes the cluster.
 *
 * The settings come from k8s/networking/cilium/Cilium.values.yaml
 * rather than a pile of --set flags. That file is a template, so the
 * API server address is filled in from the configuration the same way
 * it is for every other manifest.
 *
 * Requires:
 * - a running K3s server, with a readable kubeconfig
 * - curl, tar, sha256sum
 * - sudo, to put the CLI on the path
 */

import { CommandSpec, CommandTarget, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { quoteForShell } from "../../util/shell.ts";
import { renderInstallerFile } from "../../util/template.ts";
import { buildKubeEnv } from "../../util/kube.ts";

// Where the CLI says which of its releases is current. Only consulted
// when a configuration asks for it by name, since the whole point of
// the pinning below is not to.
const CLI_STABLE_URL = "https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt";

// What a configuration writes to opt out of the pin and take whatever
// the CLI currently calls stable
const CLI_STABLE = "stable";

// Where its release archives live
const CLI_RELEASE_URL = "https://github.com/cilium/cilium-cli/releases/download";

// Where the CLI is installed to
const CLI_INSTALL_DIR = "/usr/local/bin";

/**
 * The three versions this installs, and they are pinned together on
 * purpose.
 *
 * Nothing here floats. A cluster built in March and a cluster built in
 * September should be the same cluster, and the failures that come
 * from these drifting apart are the quiet kind: Cilium 1.19 against a
 * Gateway API that had stopped serving the TLSRoute version it wanted
 * didn't report anything, it just never started a Gateway API
 * controller. Moving any of these is a deliberate act — change the
 * version, check the values file still matches what that release
 * expects, and run it against a cluster you can throw away.
 *
 * - DEFAULT_CILIUM_VERSION: the release the values file is written for
 * - DEFAULT_CLI_VERSION: the CLI that installs it. It carries its own
 *   idea of a default Cilium version and its own flags, so it belongs
 *   to a release rather than to whatever is current.
 * - DEFAULT_GATEWAY_API_VERSION: below, next to the resources it
 *   brings, since which of those are needed changes with it
 */
const DEFAULT_CILIUM_VERSION = "1.20.1";
const DEFAULT_CLI_VERSION = "v0.20.0";

// The values file that ships with the installer
const DEFAULT_VALUES_FILE = "embed://networking/cilium/Cilium.values.yaml";

// The Gateway API release to install, and the one the Cilium above
// says it supports. Pinned rather than taken from latest: the pairing
// is the thing that breaks, and it breaks quietly. Cilium 1.19 needed
// TLSRoute v1alpha2, which a newer bundle had stopped serving, and the
// symptom was a Gateway API that silently never started.
const DEFAULT_GATEWAY_API_VERSION = "v1.6.1";

// Where the Gateway API releases live
const GATEWAY_API_URL =
  "https://raw.githubusercontent.com/kubernetes-sigs/gateway-api";

// The resources Cilium's Gateway API controller needs. All of these
// are in the standard channel as of the release above, including the
// two that used to be experimental:
//
// - tlsroutes, which Cilium requires rather than merely supports
// - listenersets, which is what makes a Gateway's allowedListeners
//   mean anything. Optional to Cilium, but the Gateway that ships with
//   Community Cloud uses it to say which namespaces may attach
//   listeners, so it isn't optional here.
const GATEWAY_API_CRDS = [
  "gatewayclasses",
  "gateways",
  "httproutes",
  "grpcroutes",
  "referencegrants",
  "backendtlspolicies",
  "tlsroutes",
  "listenersets",
];

// The channel the resources above are published in
const GATEWAY_API_CHANNEL = "standard";

// Where the rendered values are put on the node. Only the installer
// reads it, and it holds nothing secret.
const REMOTE_VALUES_PATH = "/tmp/cc-cilium-values.yaml";

// How long to wait for Cilium to report itself healthy
const READY_TIMEOUT = "10m";

/**
 * The cilium section of a Community Cloud configuration.
 *
 * - version: the Cilium release to install
 * - cliVersion: the cilium CLI release, which is pinned by default.
 *   Set it to "stable" to take whatever the CLI currently calls
 *   current, which is deliberately something you have to write.
 * - valuesFile: override the values file that ships with the repo
 * - kubeProxyReplacement: whether Cilium takes over from kube-proxy,
 *   which K3s also reads when it decides whether to start one
 * - gatewayApiVersion: the Gateway API release to install, which has
 *   to be one this Cilium supports
 */
interface CiliumConfig {
  version?: string;
  cliVersion?: string;
  valuesFile?: string;
  kubeProxyReplacement?: boolean;
  gatewayApiVersion?: string;
}

/**
 * Read the cilium section of the configuration.
 *
 * @param config
 * @returns
 */
function getCiliumConfig(config: CloudConfig): CiliumConfig {
  const { network } = config.getConfig();
  const cilium = network !== undefined && network !== null ? network.cilium : undefined;

  return cilium !== undefined && cilium !== null ? cilium : {};
}

/**
 * The Cilium release to install.
 *
 * @param config
 * @returns
 */
function getCiliumVersion(config: CloudConfig): string {
  const { version } = getCiliumConfig(config);

  return version !== undefined && version !== "" ? version : DEFAULT_CILIUM_VERSION;
}

/**
 * The Cilium CLI release to install.
 *
 * The pin unless a configuration says otherwise. "stable" is how a
 * configuration asks for whatever is current instead, which is a thing
 * worth having to write down.
 *
 * @param config
 * @returns
 */
function getCliVersion(config: CloudConfig): string {
  const { cliVersion } = getCiliumConfig(config);

  return cliVersion !== undefined && cliVersion !== ""
    ? cliVersion
    : DEFAULT_CLI_VERSION;
}

/**
 * The Gateway API release to install.
 *
 * @param config
 * @returns
 */
function getGatewayApiVersion(config: CloudConfig): string {
  const { gatewayApiVersion } = getCiliumConfig(config);

  return gatewayApiVersion !== undefined && gatewayApiVersion !== ""
    ? gatewayApiVersion
    : DEFAULT_GATEWAY_API_VERSION;
}

/**
 * Read the values file and fill in the configured values.
 *
 * The file ships with the installer, so it's read through the shared
 * helper: from the repository in a checkout, and from inside the
 * binary in a release.
 *
 * @param config
 * @returns
 */
function renderValues(config: CloudConfig): string {
  const { valuesFile } = getCiliumConfig(config);

  return renderInstallerFile(
    config,
    valuesFile !== undefined ? valuesFile : DEFAULT_VALUES_FILE,
  );
}

/**
 * The shell that works out which CLI build a node wants. Cilium
 * publishes one archive per architecture and nothing else tells us
 * which of them we're on.
 */
const DETECT_ARCH = 'case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=amd64 ;; esac';

export const CiliumCommands: CommandSpec[] = [
  // TODO: Include Rasberry Pi support
  // Needs "sudo apt install linux-modules-extra-raspi" first, which
  // means running a command only on some nodes

  /**
   * Work out which CLI to fetch. A configuration can pin one, which
   * is worth doing for a cluster that has to come back up the same
   * way twice.
   */
  {
    name: "get-cilium-cli-version",
    description: "Work out which version of the Cilium CLI to install",
    runOn: CommandTarget.ControlPlane,
    command: (config: CloudConfig) => {
      const version = getCliVersion(config);

      // Asked for by name rather than reached for by default, so a
      // repeated install is a repeated install
      if (version === CLI_STABLE) {
        return `curl -fsSL ${CLI_STABLE_URL} || { echo "Couldn't ask ${CLI_STABLE_URL} which Cilium CLI is current" >&2; exit 1; }`;
      }

      return `echo ${quoteForShell(version)}`;
    },
    output: OutputType.Raw,
  },

  /**
   * Fetch the CLI and put it on the path.
   *
   * Download, checksum and extract are one command rather than four
   * because each command is its own shell: a working directory or a
   * variable set in one is gone by the next. Working in a temporary
   * directory also means a failed download leaves nothing behind.
   */
  {
    name: "install-cilium-cli",
    description: "Download the Cilium CLI, check it, and install it",
    runOn: CommandTarget.ControlPlane,
    command: (_config: CloudConfig, _context: any, commandResults: any) => {

      const version = commandResults["get-cilium-cli-version"].parsed.trim();
      if (version === "") {
        throw new Error("Couldn't work out which version of the Cilium CLI to install.");
      }

      const archive = "cilium-linux-${arch}.tar.gz";
      const releaseUrl = `${CLI_RELEASE_URL}/${version}`;

      return [
        DETECT_ARCH,
        "workdir=$(mktemp -d)",
        `cd "$workdir" || exit 1`,
        // --fail so that an error page doesn't get unpacked as if it
        // were the CLI
        `curl -fsSL --remote-name-all "${releaseUrl}/${archive}" "${releaseUrl}/${archive}.sha256sum" || { echo "Couldn't download the Cilium CLI ${version}" >&2; rm -rf "$workdir"; exit 1; }`,
        `sha256sum --check "${archive}.sha256sum" || { echo "The Cilium CLI download didn't match its checksum" >&2; rm -rf "$workdir"; exit 1; }`,
        `sudo tar xzf "${archive}" -C ${CLI_INSTALL_DIR} || { echo "Couldn't unpack the Cilium CLI into ${CLI_INSTALL_DIR}" >&2; rm -rf "$workdir"; exit 1; }`,
        `cd / && rm -rf "$workdir"`,
        `${CLI_INSTALL_DIR}/cilium version --client`,
      ];
    },
    output: OutputType.Raw,
  },

  /**
   * Put the rendered values on the node for the installer to read.
   * They're rendered here rather than there, since the file lives
   * with the repository and the node has never seen it.
   *
   * They travel on standard input, which keeps a whole YAML document
   * out of a command line and means the values file is never quoted
   * into one. Nothing in the Cilium values is secret today, but the
   * writing of a file shouldn't depend on that staying true.
   */
  {
    name: "write-cilium-values",
    description: "Write the rendered Cilium values onto the node",
    runOn: CommandTarget.ControlPlane,
    command: [
      `install -m 0600 /dev/null ${REMOTE_VALUES_PATH} || { echo "Couldn't create ${REMOTE_VALUES_PATH}" >&2; exit 1; }`,
      `cat > ${REMOTE_VALUES_PATH} || { echo "Couldn't write ${REMOTE_VALUES_PATH}" >&2; exit 1; }`,
      `echo "wrote ${REMOTE_VALUES_PATH}"`,
    ],
    stdin: (config: CloudConfig) => renderValues(config),
    output: OutputType.Raw,
  },

  /**
   * Put the Gateway API resources in the cluster.
   *
   * Before Cilium, and that ordering is the whole point. The operator
   * builds its Gateway API controller once, at startup, from what it
   * finds then: installed afterwards and Cilium has already decided
   * Gateway API is unavailable and turned it off, with nothing to say
   * so except a line in a log nobody reads.
   *
   * K3s would otherwise bring these itself, as part of Traefik. That
   * is why the K3s install leaves Traefik out: the bundle it ships
   * stops serving TLSRoute v1alpha2, and Cilium needs that version.
   */
  {
    name: "install-gateway-api",
    description: "Install the Gateway API resources Cilium's Envoy serves",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: (config: CloudConfig) => {
      const version = getGatewayApiVersion(config);

      return [
        // Server-side, which is what the Gateway API's own
        // instructions use. These schemas are large enough that the
        // annotation a client-side apply leaves behind runs into the
        // API server's limit on one.
        ...GATEWAY_API_CRDS.map((name) => {
          const url = `${GATEWAY_API_URL}/${version}/config/crd/${GATEWAY_API_CHANNEL}/gateway.networking.k8s.io_${name}.yaml`;
          return `kubectl apply --server-side -f ${quoteForShell(url)} || { echo "Couldn't install the ${name} resource from ${url}" >&2; exit 1; }`;
        }),

        // The Gateway that ships with Community Cloud names the
        // namespaces its listeners may come from, and a Gateway schema
        // without that field rejects the whole manifest rather than
        // ignoring the part it doesn't know. Checked here, where it
        // can say what to do about it, rather than at the apply.
        `listeners=$(kubectl get crd gateways.gateway.networking.k8s.io -o jsonpath='{range .spec.versions[?(@.name=="v1")]}{.schema.openAPIV3Schema.properties.spec.properties.allowedListeners.type}{end}' 2>/dev/null)`,
        `[ -n "$listeners" ] || { echo "The Gateway API ${version} in this cluster has no allowedListeners on a Gateway, so ListenerSets can't attach. Pin \"network.cilium.gatewayApiVersion\" to a release that has it." >&2; exit 1; }`,
        `echo "Gateway API ${version} installed"`,
      ];
    },
    output: OutputType.Raw,
  },

  /**
   * Install Cilium itself.
   */
  {
    name: "install-cilium",
    description: "Install Cilium with the configured values",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: (config: CloudConfig) => {
      return `cilium install --version ${quoteForShell(getCiliumVersion(config))} --values ${REMOTE_VALUES_PATH}`;
    },
    output: OutputType.Raw,
  },

  /**
   * Wait for it to come up. The install returns once the manifests
   * are applied, well before the agents are running on every node.
   */
  {
    name: "wait-for-cilium",
    description: "Wait for Cilium to report itself healthy",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: `cilium status --wait --wait-duration ${READY_TIMEOUT}`,
    output: OutputType.Raw,
  },

  /**
   * Check the cluster got what the values asked for.
   *
   * Cilium reporting itself healthy isn't the same as the cluster
   * working, and the settings here are the ones K3s was configured
   * against: if kube-proxy replacement didn't take, K3s has already
   * been told not to run a kube-proxy and nothing is doing the job.
   */
  {
    name: "verify-cilium",
    description: "Verify the CNI is up and the nodes are ready",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: (config: CloudConfig) => {

      const checks = [
        "kubectl wait --for=condition=Ready nodes --all --timeout=300s",
        "kubectl get nodes -o wide",
      ];

      if (getCiliumConfig(config).kubeProxyReplacement !== false) {
        checks.push(
          'replacement=$(cilium config view | awk \'$1 == "kube-proxy-replacement" {print $2}\')',
          'echo "kube-proxy replacement: $replacement"',
          '[ "$replacement" = "true" ] || { echo "Cilium isn\'t replacing kube-proxy, but K3s was installed without one" >&2; exit 1; }',
        );
      }

      return checks;
    },
    output: OutputType.Raw,
  },
];
