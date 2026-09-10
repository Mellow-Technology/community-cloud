/**
 * @file
 * Install Helm, the Kubernetes package manager.
 *
 * Helm goes on the control plane, because that's where the kubeconfig
 * is and where anything that talks to the cluster has to run. Nothing
 * else needs it.
 *
 * The installer is fetched to a file and then run, rather than piped
 * into a shell: in a pipeline the shell's exit status is the one that
 * counts, so a download that fails would hand an empty script to a
 * shell that reads nothing and reports success.
 *
 * Requires:
 * - curl and sudo
 */
import { CommandSpec, CommandTarget, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";

// The official installer, which does its own checksum verification
const INSTALL_URL = "https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3";

/**
 * The helm section of a Community Cloud configuration.
 *
 * - version: pin a Helm release, e.g. "v3.16.3". Left unset the
 *   installer takes the current one.
 */
interface HelmConfig {
  version?: string;
}

/**
 * Read the helm section of the configuration.
 *
 * @param config
 * @returns
 */
export function getHelmConfig(config: CloudConfig): HelmConfig {
  const { helm } = config.getConfig();
  return helm !== undefined && helm !== null ? helm : {};
}

export const HelmInstallCommands: CommandSpec[] = [
  /**
   * Find out whether it's already here, and at what version.
   */
  {
    name: "check-helm",
    description: "Check whether Helm is already installed",
    runOn: CommandTarget.ControlPlane,
    command: [
      "if command -v helm > /dev/null 2>&1",
      'then printf "installed|%s\\n" "$(helm version --short 2>/dev/null)"',
      'else echo "missing|"',
      "fi",
    ].join("\n"),
    output: OutputType.Raw,
    saveToContext: (output: any) => {
      const [state, version] = String(output.parsed).trim().split("|");
      const installed = state === "installed";

      console.log(
        installed
          ? `Helm is already installed: ${version}`
          : "Helm isn't installed on the control plane yet",
      );

      return { helmInstalled: installed, helmVersion: version };
    },
  },

  /**
   * Install it.
   */
  {
    name: "install-helm",
    description: "Install Helm on the control plane",
    runOn: CommandTarget.ControlPlane,
    skipWhen: (config: CloudConfig, context: any) => {
      // Already here, and either nothing was pinned or the pinned
      // version is the one that's here
      if (context.helmInstalled !== true) {
        return false;
      }

      const { version } = getHelmConfig(config);
      return version === undefined || String(context.helmVersion).startsWith(version);
    },
    env: (config: CloudConfig) => {
      const { version } = getHelmConfig(config);

      // The installer reads the version it should fetch from here
      return version !== undefined ? { DESIRED_VERSION: version } : {};
    },
    command: [
      "installer=$(mktemp)",
      `curl -fsSL ${INSTALL_URL} -o "$installer" || { echo "Couldn't download the Helm installer from ${INSTALL_URL}" >&2; rm -f "$installer"; exit 1; }`,
      `test -s "$installer" || { echo "The Helm installer came back empty" >&2; rm -f "$installer"; exit 1; }`,
      'chmod 0700 "$installer"',
      // Run it through its own shebang rather than "sh": the script is
      // bash and fails part way through under dash, which is what
      // /bin/sh is on Debian and Ubuntu. It uses sudo itself for the
      // parts that need it.
      '"$installer"',
      "status=$?",
      'rm -f "$installer"',
      "exit $status",
    ].join("\n"),
    output: OutputType.Raw,
  },

  /**
   * Check it works, rather than merely exists.
   */
  {
    name: "verify-helm",
    description: "Verify Helm is installed and can reach the cluster",
    runOn: CommandTarget.ControlPlane,
    env: (config: CloudConfig) => {
      const { k3s } = config.getConfig();

      return {
        KUBECONFIG:
          k3s !== undefined && k3s !== null && k3s.kubeconfig !== undefined
            ? k3s.kubeconfig
            : "/etc/rancher/k3s/k3s.yaml",
      };
    },
    command: [
      'command -v helm > /dev/null 2>&1 || { echo "Helm still isn\'t on the path" >&2; exit 1; }',
      "helm version --short",
      // Listing releases needs a working kubeconfig, so this is the
      // cheapest proof that Helm can actually do anything
      'helm list --all-namespaces > /dev/null || { echo "Helm is installed but can\'t reach the cluster. Check the kubeconfig." >&2; exit 1; }',
      'echo "Helm can reach the cluster"',
    ].join("\n"),
    output: OutputType.Raw,
    saveToContext: (output: any) => ({
      helmVersion: String(output.parsed).trim().split("\n")[0],
    }),
  },
];

/**
 * Where Helm's values files and manifests are written on the node.
 * Shared with the chart bundle so both agree.
 */
export const HELM_WORK_DIR = "/tmp/cc-helm";

/**
 * The kubeconfig Helm should use.
 *
 * @param config
 * @returns
 */
export function buildHelmEnv(config: CloudConfig): Record<string, string> {
  const { k3s } = config.getConfig();

  return {
    KUBECONFIG:
      k3s !== undefined && k3s !== null && k3s.kubeconfig !== undefined
        ? k3s.kubeconfig
        : "/etc/rancher/k3s/k3s.yaml",
  };
}
