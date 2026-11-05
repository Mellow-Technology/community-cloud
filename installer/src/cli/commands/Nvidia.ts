/**
 * @file
 * Everything NVIDIA hardware needs, on the nodes that have it.
 *
 * A container can't reach a GPU through containerd's normal runtime.
 * NVIDIA's runtime wraps it, and puts the driver's libraries and device
 * nodes into the containers that ask. There's almost nothing to
 * configure, because K3s looks for the runtime as it starts and writes
 * it into its own containerd configuration. It also brings a
 * RuntimeClass called "nvidia", which is how a pod asks for it.
 *
 * The runtime gets a card into a container. It's the device plugin that
 * tells Kubernetes the card exists, so a pod can ask for
 * "nvidia.com/gpu" and be placed somewhere with one free.
 *
 * Those are one bundle because neither is any use without the other,
 * and that shapes where it goes. The plugin is a chart, so this comes
 * after the helm bundle, with a cluster to install it into. That's too
 * late for K3s to find the runtime as it first starts, so a node with
 * NVIDIA hardware has K3s restarted once. Containers keep running
 * through that.
 *
 * It's left to pods to ask for the runtime, rather than made the
 * node's default. The rest of what runs on these nodes has no use for
 * it.
 *
 * The driver is not installed here. It's a kernel module matched to
 * the card and the kernel, and changing one can mean a reboot, which
 * isn't something to do to a node in passing. The plugin can't start
 * without one, and a pod that never starts holds up every Helm install
 * that waits for it. So the plugin only goes where a driver answered,
 * which is what DRIVER_LABEL says. Add a driver to a node and run this
 * bundle again to bring it in.
 *
 * Requires:
 * - a Debian or Ubuntu node, since this comes from an apt repository
 * - curl, sudo
 * - a running cluster, and Helm on the control plane
 * - the gpu bundle's findings, which this bundle gets for itself when
 *   it's run alone
 */
import {
  CommandOutput,
  CommandPurpose,
  CommandScope,
  CommandSpec,
  CommandTarget,
  OutputType,
} from "./Command.ts";
import { apt } from "./BasePackages.ts";
import { hasGpuVendor } from "./GpuInfo.ts";
import { buildPackageCommands, checkHelmAvailableCommand } from "./Helm.ts";
import { getClusterNodeName } from "./K3s.ts";
import { readLines } from "./output.ts";
import type { PackageDefinition } from "./packages.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { GpuVendor } from "../../util/types.ts";
import { quoteForShell, waitUntil } from "../../util/shell.ts";

// Pinned, like everything else that decides how a cluster behaves. Its
// four packages are released together and have to match, which is why
// NVIDIA's own instructions name all of them.
export const TOOLKIT_VERSION = "1.20.1-1";
const TOOLKIT_PACKAGES = [
  "nvidia-container-toolkit",
  "nvidia-container-toolkit-base",
  "libnvidia-container-tools",
  "libnvidia-container1",
];

// Where the packages come from. An armoured key is fine for apt as
// long as the file ends in .asc, which saves needing gpg to convert it.
const APT_KEY_URL = "https://nvidia.github.io/libnvidia-container/gpgkey";
const APT_KEYRING = "/etc/apt/keyrings/nvidia-container-toolkit.asc";
const APT_LIST = "/etc/apt/sources.list.d/nvidia-container-toolkit.list";

// $(ARCH) is apt's, not the shell's: it's filled in with the node's
// architecture when apt reads the file
const APT_REPO = "https://nvidia.github.io/libnvidia-container/stable/deb/$(ARCH) /";

// What K3s looks for as it starts
const RUNTIME_BINARY = "nvidia-container-runtime";

// What K3s writes when it starts, with any runtime it found in it
const CONTAINERD_CONFIG = "/var/lib/rancher/k3s/agent/etc/containerd/config.toml";

// The services K3s installs, either of which might be the one on
// this node
const SERVICES = ["k3s", "k3s-agent"];

// How long to wait for K3s to come back after a restart
const RESTART_TIMEOUT_SECONDS = 120;

// On a node whose driver answered. The device plugin's values select
// on this, so it's what decides which nodes get the plugin.
export const DRIVER_LABEL = "gpu.community-cloud.technology/nvidia-driver";
const DRIVER_READY = "ready";

// Not in the catalogue, because it isn't a choice: a cluster with a
// working card gets it from this bundle, and one without doesn't
export const DEVICE_PLUGIN: PackageDefinition = {
  name: "nvidia-device-plugin",
  description: "Lets pods ask for NVIDIA GPUs as nvidia.com/gpu",
  chart: { repo: "https://nvidia.github.io/k8s-device-plugin", name: "nvidia-device-plugin" },
  version: "0.20.1",
  // Where NVIDIA's own instructions put it
  namespace: "nvidia-device-plugin",
  valuesFile: "embed://ai/NvidiaDevicePlugin/NvidiaDevicePlugin.values.yaml",
};

/**
 * Whether there's nothing here for this node to do.
 *
 * @param _config
 * @param context
 * @returns
 */
function noNvidiaHardware(_config: unknown, context: any): boolean {
  return !hasGpuVendor(context, GpuVendor.Nvidia);
}

export const NvidiaCommands: CommandSpec[] = [
  /**
   * Install the toolkit.
   *
   * The repository is added afresh each run, which costs nothing and
   * puts a half-finished setup right. Only the repository's own index
   * is updated, since the base bundle has done the rest.
   */
  {
    name: "install-nvidia-container-toolkit",
    description: "Install the NVIDIA Container Toolkit",
    skipWhen: noNvidiaHardware,
    command: [
      `sudo install -m 0755 -d /etc/apt/keyrings || { echo "Couldn't create /etc/apt/keyrings" >&2; exit 1; }`,
      `sudo curl -fsSL ${APT_KEY_URL} -o ${APT_KEYRING} || { echo "Couldn't download NVIDIA's signing key from ${APT_KEY_URL}" >&2; exit 1; }`,
      `sudo chmod 0644 ${APT_KEYRING}`,
      `echo 'deb [signed-by=${APT_KEYRING}] ${APT_REPO}' | sudo tee ${APT_LIST} > /dev/null`,
      `if [ "$(dpkg-query -W -f='\${Version}' ${TOOLKIT_PACKAGES[0]} 2>/dev/null)" = "${TOOLKIT_VERSION}" ]`,
      `then echo "The NVIDIA Container Toolkit ${TOOLKIT_VERSION} is already installed"`,
      "else",
      ...apt(
        `update -q -o Dir::Etc::sourcelist=${APT_LIST} -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0`,
        "Couldn't read NVIDIA's package repository",
      ),
      ...apt(
        `install -y --allow-downgrades ${TOOLKIT_PACKAGES.map((name) => `${name}=${TOOLKIT_VERSION}`).join(" ")}`,
        `Couldn't install the NVIDIA Container Toolkit ${TOOLKIT_VERSION}`,
      ),
      "fi",
    ],
    output: OutputType.Raw,
  },

  /**
   * Find a running K3s that hasn't seen the runtime.
   *
   * On a new node that's every time, since K3s got here first.
   */
  {
    name: "check-k3s-nvidia-runtime",
    purpose: CommandPurpose.Inspect,
    description: "Check whether K3s has picked up the NVIDIA runtime",
    skipWhen: noNvidiaHardware,
    command: [
      `for service in ${SERVICES.join(" ")}`,
      'do systemctl is-active --quiet "$service" 2>/dev/null || continue',
      `  sudo grep -q ${RUNTIME_BINARY} ${CONTAINERD_CONFIG} 2>/dev/null || echo "stale|$service"`,
      "done",
    ],
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) =>
        readLines(output)
          .filter((line) => line.startsWith("stale|"))
          .map((line) => line.slice("stale|".length)),
    ],
    saveToContext: (output: any) => ({ k3sMissingNvidiaRuntime: output.processed }),
  },

  /**
   * Restart K3s, so it looks for runtimes again.
   */
  {
    name: "restart-k3s-for-nvidia",
    description: "Restart K3s so it picks up the NVIDIA runtime",
    skipWhen: (config: unknown, context: any) =>
      noNvidiaHardware(config, context) || (context.k3sMissingNvidiaRuntime ?? []).length === 0,
    command: (_config: unknown, context: any) =>
      context.k3sMissingNvidiaRuntime.flatMap((service: string) => [
        // Without --no-block this waits for K3s to say it's ready, with
        // no limit. The wait below is the one with a limit.
        `sudo systemctl restart --no-block ${service} || { echo "Couldn't restart ${service}" >&2; exit 1; }`,
        waitUntil(`systemctl is-active --quiet ${service}`, RESTART_TIMEOUT_SECONDS),
        `systemctl is-active --quiet ${service} || { echo "${service} didn't come back within ${RESTART_TIMEOUT_SECONDS}s" >&2; exit 1; }`,
        `echo "${service} restarted and running"`,
      ]),
    output: OutputType.Raw,
  },

  /**
   * Ask the driver.
   *
   * Of nvidia-smi rather than whether nvidia-smi exists, since it can
   * be installed and still not reach a driver that's been upgraded and
   * is waiting on a reboot.
   */
  {
    name: "check-nvidia-driver",
    purpose: CommandPurpose.Inspect,
    description: "Check whether the NVIDIA driver is working",
    skipWhen: noNvidiaHardware,
    command: 'if nvidia-smi -L > /dev/null 2>&1; then echo working; else echo "not working"; fi',
    output: OutputType.Raw,
    postProcessHooks: [(output: CommandOutput) => readLines(output).includes("working")],
    saveToContext: (output: any) => ({ nvidiaDriverWorking: output.processed }),
  },

  /**
   * Say which nodes the plugin can run on.
   *
   * Taken off again when a driver stops answering, or the plugin's
   * pod on that node would fail until someone looked. Pods already
   * using the card aren't touched.
   */
  {
    name: "label-nvidia-driver",
    description: "Label the node with whether its NVIDIA driver works",
    runOn: CommandTarget.ControlPlane,

    // kubectl, so it has to run on a server, but it's about one machine
    scope: CommandScope.EachNode,
    env: buildKubeEnv,
    skipWhen: noNvidiaHardware,
    command: (_config: CloudConfig, context: any) => {
      const name = quoteForShell(getClusterNodeName(context));
      const change =
        context.nvidiaDriverWorking === true
          ? `--overwrite ${quoteForShell(`${DRIVER_LABEL}=${DRIVER_READY}`)}`
          : quoteForShell(`${DRIVER_LABEL}-`);

      return [
        // This node might be the server that was just restarted
        waitUntil(`kubectl get node ${name} > /dev/null 2>&1`, RESTART_TIMEOUT_SECONDS),
        `kubectl label node ${name} ${change} || { echo "Couldn't label ${name}" >&2; exit 1; }`,
      ];
    },
    output: OutputType.Raw,
  },

  /**
   * Check the runtime is there, and that K3s has it.
   *
   * The driver is only reported on; see the top of this file.
   */
  {
    name: "verify-nvidia-runtime",
    purpose: CommandPurpose.Verify,
    description: "Verify the NVIDIA runtime is installed and K3s has it",
    skipWhen: noNvidiaHardware,
    command: [
      `command -v ${RUNTIME_BINARY} > /dev/null 2>&1 || { echo "${RUNTIME_BINARY} isn't installed" >&2; exit 1; }`,
      `for service in ${SERVICES.join(" ")}`,
      'do systemctl is-active --quiet "$service" 2>/dev/null || continue',
      `  sudo grep -q ${RUNTIME_BINARY} ${CONTAINERD_CONFIG} || { echo "$service is running without the NVIDIA runtime. Its containerd configuration doesn't mention it." >&2; exit 1; }`,
      '  echo "$service has the NVIDIA runtime"',
      "done",
      'if nvidia-smi -L 2>/dev/null',
      "then :",
      `else echo "⚠️  The NVIDIA driver isn't working on this node, so it's been left out of the device plugin and its cards can't be used. Install a driver for this card, reboot if it asks for one, and run the nvidia bundle again."`,
      "fi",
    ],
    output: OutputType.Raw,
  },
];

/**
 * Find out whether any node in the cluster has a working card.
 *
 * Asked of the cluster, not the node a step happens to run from, which
 * is any server and likely not the one with the card.
 */
const findDriverNodes: CommandSpec = {
  name: "find-nvidia-driver-nodes",
  purpose: CommandPurpose.Inspect,
  description: "Find the nodes with a working NVIDIA driver",
  runOn: CommandTarget.ControlPlane,
  env: buildKubeEnv,
  command: `kubectl get nodes -l ${DRIVER_LABEL}=${DRIVER_READY} -o name`,
  output: OutputType.Raw,
  postProcessHooks: [(output: CommandOutput) => readLines(output)],
  saveToContext: (output: any) => ({ nvidiaDriverNodes: output.processed }),
};

/**
 * Skip a device plugin command on a cluster it has nothing to do on.
 *
 * @param spec
 * @returns
 */
function whenDriverNodes(spec: CommandSpec): CommandSpec {
  const original = spec.skipWhen;

  return {
    ...spec,
    skipWhen: (config: CloudConfig, context: any, results: any) =>
      (context.nvidiaDriverNodes ?? []).length === 0 ||
      (typeof original === "function" && original(config, context, results) === true),
  };
}

// The chart, and its checks. In the order they run: the nodes have to
// be labelled before there's anything to look for.
export const DevicePluginCommands: CommandSpec[] = [
  findDriverNodes,
  ...[checkHelmAvailableCommand, ...buildPackageCommands(DEVICE_PLUGIN)].map(whenDriverNodes),
];
