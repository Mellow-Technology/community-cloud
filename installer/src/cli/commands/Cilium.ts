/**
 * @file
 * Commands for setting up [Cilium](https://cilium.io/)
 *
 * These run on the control plane, after K3s is installed. K3s is
 * brought up with its own networking disabled, so until Cilium is in
 * place every node sits NotReady with no CNI: this bundle is what
 * finishes the cluster.
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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";

import { CommandSpec, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { K3SInstallationType } from "../../util/types.ts";
import { quoteForShell } from "../../util/shell.ts";
import { buildTemplateValues, renderTemplate } from "../../util/template.ts";

// Where the CLI says which of its releases is current
const CLI_STABLE_URL = "https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt";

// Where its release archives live
const CLI_RELEASE_URL = "https://github.com/cilium/cilium-cli/releases/download";

// Where the CLI is installed to
const CLI_INSTALL_DIR = "/usr/local/bin";

// The Cilium release to install. Pinned rather than tracking latest,
// since the values below are written against it.
const DEFAULT_CILIUM_VERSION = "1.19.6";

// The values file, relative to the root of the repository
const DEFAULT_VALUES_FILE = "k8s/networking/cilium/Cilium.values.yaml";

// Where the rendered values are put on the node. Only the installer
// reads it, and it holds nothing secret.
const REMOTE_VALUES_PATH = "/tmp/cc-cilium-values.yaml";

// K3s writes the cluster's kubeconfig here
const DEFAULT_KUBECONFIG = "/etc/rancher/k3s/k3s.yaml";

// How long to wait for Cilium to report itself healthy
const READY_TIMEOUT = "10m";

/**
 * The cilium section of a Community Cloud configuration.
 *
 * - version: the Cilium release to install
 * - cliVersion: pin the cilium CLI, otherwise the current stable one
 * - valuesFile: override the values file that ships with the repo
 * - kubeProxyReplacement: whether Cilium takes over from kube-proxy,
 *   which K3s also reads when it decides whether to start one
 */
interface CiliumConfig {
  version?: string;
  cliVersion?: string;
  valuesFile?: string;
  kubeProxyReplacement?: boolean;
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
 * Cilium is installed from the control plane, since everything here
 * talks to the cluster rather than to the node it runs on. Pointing
 * this at an agent would get as far as looking for a kubeconfig that
 * isn't there, so we say so up front instead.
 *
 * @param context
 * @returns
 */
function requireControlPlane(context: any): void {
  const node = context.node !== undefined && context.node !== null ? context.node : {};

  if (node.type !== K3SInstallationType.Server) {
    throw new Error(
      `Cilium is installed from the control plane, and "${context.nodeName}" is${node.type !== undefined ? ` an ${node.type}` : "n't a server"}. Run this bundle against a node whose type is "${K3SInstallationType.Server}".`,
    );
  }
}

/**
 * The kubeconfig the CLI should use. K3s puts one on the control
 * plane, which is where these commands run.
 *
 * @param config
 * @returns
 */
function buildKubeEnv(config: CloudConfig, context: any): Record<string, string> {
  requireControlPlane(context);

  const { k3s } = config.getConfig();
  const kubeconfig =
    k3s !== undefined && k3s !== null && k3s.kubeconfig !== undefined
      ? k3s.kubeconfig
      : DEFAULT_KUBECONFIG;

  return { KUBECONFIG: kubeconfig };
}

/**
 * Work out where the Cilium values file is.
 *
 * It ships with the repository, so it's found relative to this file
 * rather than to wherever the installer was run from. A configuration
 * can point somewhere else if it needs to.
 *
 * @param config
 * @returns
 */
function getValuesFilePath(config: CloudConfig): string {
  const { valuesFile } = getCiliumConfig(config);

  if (valuesFile !== undefined) {
    return isAbsolute(valuesFile) ? valuesFile : join(process.cwd(), valuesFile);
  }

  // installer/src/cli/commands -> the root of the repository
  const commandsDir = fileURLToPath(new URL(".", import.meta.url));
  return join(commandsDir, "..", "..", "..", "..", DEFAULT_VALUES_FILE);
}

/**
 * Read the values file and fill in the configured values.
 *
 * @param config
 * @returns
 */
function renderValues(config: CloudConfig): string {
  const valuesFilePath = getValuesFilePath(config);

  let contents = null;
  try {
    contents = readFileSync(valuesFilePath, { encoding: "utf8" });
  } catch (e: any) {
    throw new Error(
      `Couldn't read the Cilium values file at "${valuesFilePath}": ${e.message}`,
    );
  }

  try {
    return renderTemplate(contents, buildTemplateValues(config));
  } catch (e: any) {
    throw new Error(
      `Couldn't render the Cilium values file at "${valuesFilePath}": ${e.message}`,
    );
  }
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
    description: "Find the version of the Cilium CLI to install",
    command: (config: CloudConfig, context: any) => {
      requireControlPlane(context);

      const { cliVersion } = getCiliumConfig(config);
      if (cliVersion !== undefined) {
        return `echo ${quoteForShell(cliVersion)}`;
      }

      return `curl -fsSL ${CLI_STABLE_URL}`;
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
    command: (config: CloudConfig, context: any, commandResults: any) => {
      requireControlPlane(context);

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
      ].join("; ");
    },
    output: OutputType.Raw,
  },

  /**
   * Put the rendered values on the node for the installer to read.
   * They're rendered here rather than there, since the file lives
   * with the repository and the node has never seen it.
   */
  {
    name: "write-cilium-values",
    description: "Write the rendered Cilium values onto the node",
    command: (config: CloudConfig, context: any) => {
      requireControlPlane(context);

      return [
        `printf '%s' ${quoteForShell(renderValues(config))} > ${REMOTE_VALUES_PATH}`,
        `echo "wrote ${REMOTE_VALUES_PATH}"`,
      ].join("; ");
    },
    output: OutputType.Raw,
  },

  /**
   * Install Cilium itself.
   */
  {
    name: "install-cilium",
    description: "Install Cilium with the configured values",
    env: buildKubeEnv,
    command: (config: CloudConfig, context: any) => {
      requireControlPlane(context);

      const { version } = getCiliumConfig(config);

      return `cilium install --version ${quoteForShell(version !== undefined ? version : DEFAULT_CILIUM_VERSION)} --values ${REMOTE_VALUES_PATH}`;
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
    env: buildKubeEnv,
    command: (config: CloudConfig, context: any) => {
      requireControlPlane(context);

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

      return checks.join("; ");
    },
    output: OutputType.Raw,
  },
];
