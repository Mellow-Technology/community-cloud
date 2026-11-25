/**
 * @file
 * Everything AMD hardware needs, on the nodes that have it.
 *
 * Much less than NVIDIA's. A container reaches an AMD card through two
 * kinds of device node: /dev/kfd, which is how ROCm asks the kernel for
 * compute, and the card's own /dev/dri nodes. containerd can already
 * hand a container device nodes, so there's no runtime to install, no
 * RuntimeClass, and K3s never has to be restarted. ROCm's libraries
 * come in the workload's image, as they do in every image AMD publishes
 * for it, so they aren't installed on the node either.
 *
 * What's left is AMD's device plugin. It tells Kubernetes the cards
 * exist, so a pod can ask for "amd.com/gpu" and be placed somewhere
 * with one free, and it's what passes that card's device nodes into
 * the pod. That's what spares a workload being privileged or using the
 * host's network to find its card.
 *
 * The node needs the kernel's amdgpu driver, built with KFD, bound to
 * the card. Ubuntu's and Debian's own kernels have both, and the
 * firmware it loads is in linux-firmware, so on those there's usually
 * nothing to do. AMD also ship amdgpu-dkms, a newer amdgpu built for
 * the running kernel, which is what they test their Instinct cards
 * with. Neither is installed here: it's a kernel module, changing it
 * can mean a reboot, and amdgpu-dkms is only built for the kernels
 * AMD have caught up with. The plugin stops as soon as it starts on a
 * node without amdgpu, and a pod that never starts holds up every Helm
 * install that waits for it, so the plugin only goes where the driver
 * answered, which is what DRIVER_LABEL says. Add a driver to a node and
 * run this bundle again to bring it in.
 *
 * Cards aren't shared. AMD's plugin hands each card to one pod, and has
 * nothing like NVIDIA's time-slicing. Instinct MI300 cards can be split
 * into partitions in hardware, which the plugin offers as separate
 * "amd.com/gpu"s, but that's set on the node with amd-smi and nothing
 * here does it. See the installer's README.
 *
 * An APU, such as the Ryzen AI Max, is one card like any other here: it
 * has a render node, KFD lists it, and the plugin offers it whole. What
 * differs is that its memory is the node's RAM, split between Linux and
 * the GPU by the BIOS and a kernel parameter. That's checked and
 * reported on, and left alone; see AmdUnifiedMemory.ts.
 *
 * Requires:
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
import { assessUnifiedMemory, parseUnifiedMemory, UNIFIED_MEMORY_PROBE } from "./AmdUnifiedMemory.ts";
import { hasGpuVendor } from "./GpuInfo.ts";
import { buildPackageCommands, checkHelmAvailableCommand } from "./Helm.ts";
import { getClusterNodeName } from "./K3s.ts";
import { readLines } from "./output.ts";
import { CLUSTER_NAMESPACE, type PackageDefinition } from "./packages.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { GpuVendor } from "../../util/types.ts";
import { getWaitSeconds, quoteForShell, waitUntil } from "../../util/shell.ts";

// On a node whose driver answered. The device plugin's values select
// on this, so it's what decides which nodes get the plugin.
export const DRIVER_LABEL = "gpu.community-cloud.technology/amd-driver";
const DRIVER_READY = "ready";

// The cards amdgpu has taken. The plugin looks here first, and exits if
// there's nothing, so this is the question to ask.
const BOUND_DEVICES = "/sys/module/amdgpu/drivers/pci:amdgpu/*:*";

// How ROCm asks the kernel for compute. A kernel built without KFD has
// amdgpu and no compute at all.
const KFD_DEVICE = "/dev/kfd";

// What KFD can compute on. The CPUs are in this list too, with a GPU
// ID of 0.
const KFD_GPU_IDS = "/sys/class/kfd/kfd/topology/nodes/*/gpu_id";

// How long to give the plugin, once it's running, to tell the kubelet
// about a node's cards
const PLUGIN_TIMEOUT_SECONDS = 60;

/**
 * Why a node's cards can or can't be used, worked out the way the
 * plugin would. Leaves its answer in $state.
 */
const DRIVER_PROBE = [
  'bound=""',
  `for device in ${BOUND_DEVICES}`,
  'do if [ -e "$device" ]; then bound=yes; break; fi',
  "done",
  'if [ -z "$bound" ]',
  "then state=no-driver",
  `elif [ ! -c ${KFD_DEVICE} ]`,
  "then state=no-kfd",
  `elif ! grep -qsv '^0$' ${KFD_GPU_IDS}`,
  "then state=no-compute",
  "else state=working",
  "fi",
];

/**
 * What each answer means, for someone looking at the node. The ones
 * other than "working" leave the node out of the device plugin.
 */
export const DRIVER_STATES: Record<string, string> = {
  working: "The amdgpu driver is working, and ROCm can reach this node's cards through /dev/kfd",
  "no-driver":
    "⚠️  No AMD card on this node is bound to the amdgpu driver, so it's been left out of the device plugin and its cards can't be used. The kernel's own amdgpu is enough: check it isn't blacklisted and linux-firmware is installed, reboot, and run the amd bundle again.",
  "no-kfd":
    "⚠️  amdgpu is loaded but there's no /dev/kfd, which is how ROCm reaches a card, so this node has been left out of the device plugin. The kernel was built without KFD (HSA_AMD). Use a kernel that has it, as Ubuntu's and Debian's do, or AMD's amdgpu-dkms, and run the amd bundle again.",
  "no-compute":
    "⚠️  amdgpu and /dev/kfd are both here, but KFD has no card to compute on, so this node has been left out of the device plugin. The card may be one ROCm doesn't support. dmesg will say if amdgpu gave up on it.",
};

// Not in the catalogue, because it isn't a choice: a cluster with a
// working card gets it from this bundle, and one without doesn't
export const DEVICE_PLUGIN: PackageDefinition = {
  name: "amd-gpu-device-plugin",
  description: "Lets pods ask for AMD GPUs as amd.com/gpu",
  chart: { repo: "https://rocm.github.io/k8s-device-plugin", name: "amd-gpu" },
  // Its image, 1.31.0.9, is pinned by the chart
  version: "0.22.0",
  // AMD's own instructions use kube-system, which isn't the project's
  // own namespace, just the one that was there. It runs the cluster,
  // so it goes with everything else that does.
  namespace: CLUSTER_NAMESPACE,
  valuesFile: "embed://ai/AmdDevicePlugin/AmdDevicePlugin.values.yaml",
};

/**
 * Whether there's nothing here for this node to do.
 *
 * @param _config
 * @param context
 * @returns
 */
function noAmdHardware(_config: unknown, context: any): boolean {
  return !hasGpuVendor(context, GpuVendor.Amd);
}

export const AmdCommands: CommandSpec[] = [
  /**
   * Ask the driver, the same way the plugin will.
   */
  {
    name: "check-amd-driver",
    purpose: CommandPurpose.Inspect,
    description: "Check whether the amdgpu driver can run compute on this node's cards",
    skipWhen: noAmdHardware,
    command: [...DRIVER_PROBE, 'echo "$state"'],
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => readLines(output).find((line) => line in DRIVER_STATES) ?? "no-driver",
    ],
    saveToContext: (output: any) => ({
      amdDriverState: output.processed,
      amdDriverWorking: output.processed === "working",
    }),
  },

  /**
   * Say which nodes the plugin can run on.
   *
   * Taken off again when the driver stops answering, or the plugin's
   * pod on that node would fail until someone looked. Pods already
   * using a card aren't touched.
   */
  {
    name: "label-amd-driver",
    description: "Label the node with whether its amdgpu driver works",
    runOn: CommandTarget.ControlPlane,

    // kubectl, so it has to run on a server, but it's about one machine
    scope: CommandScope.EachNode,
    env: buildKubeEnv,
    skipWhen: noAmdHardware,
    command: (_config: CloudConfig, context: any) => {
      const name = quoteForShell(getClusterNodeName(context));
      const change =
        context.amdDriverWorking === true
          ? `--overwrite ${quoteForShell(`${DRIVER_LABEL}=${DRIVER_READY}`)}`
          : quoteForShell(`${DRIVER_LABEL}-`);

      return `kubectl label node ${name} ${change} || { echo "Couldn't label ${name}" >&2; exit 1; }`;
    },
    output: OutputType.Raw,
  },

  /**
   * Say how the driver is.
   *
   * Only reported on, never a failure, for the reasons at the top of
   * this file.
   */
  {
    name: "verify-amd-driver",
    purpose: CommandPurpose.Verify,
    description: "Report whether this node's AMD cards can be offered to pods",
    skipWhen: noAmdHardware,
    command: [
      ...DRIVER_PROBE,
      'case "$state" in',
      ...Object.entries(DRIVER_STATES).map(
        ([state, message]) => `  ${state}) echo ${quoteForShell(message)} ;;`,
      ),
      "esac",
    ],
    output: OutputType.Raw,
  },

  /**
   * Say how an APU's memory is split, and what to change.
   *
   * Only reported on, like the driver: the fixes are the BIOS and a
   * reboot. Nothing at all is said on a node without an APU.
   */
  {
    name: "verify-amd-unified-memory",
    purpose: CommandPurpose.Verify,
    description: "Report how an AMD APU's memory is split between Linux and its GPU",
    skipWhen: noAmdHardware,
    command: UNIFIED_MEMORY_PROBE,
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => {
        const findings = parseUnifiedMemory(output);
        const assessment = assessUnifiedMemory(findings);

        for (const line of [...assessment.notes, ...assessment.warnings]) {
          console.log(line);
        }

        return { findings, ...assessment };
      },
    ],
    saveToContext: (output: any) => ({ amdUnifiedMemory: output.processed }),
  },
];

/**
 * Find out whether any node in the cluster has a working card.
 *
 * Asked of the cluster, not the node a step happens to run from, which
 * is any server and likely not the one with the card.
 */
const findDriverNodes: CommandSpec = {
  name: "find-amd-driver-nodes",
  purpose: CommandPurpose.Inspect,
  description: "Find the nodes with a working amdgpu driver",
  runOn: CommandTarget.ControlPlane,
  env: buildKubeEnv,
  command: `kubectl get nodes -l ${DRIVER_LABEL}=${DRIVER_READY} -o name`,
  output: OutputType.Raw,
  postProcessHooks: [(output: CommandOutput) => readLines(output)],
  saveToContext: (output: any) => ({ amdDriverNodes: output.processed }),
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
      (context.amdDriverNodes ?? []).length === 0 ||
      (typeof original === "function" && original(config, context, results) === true),
  };
}

/**
 * Check a node with a working driver is offering its cards.
 *
 * The one thing that shows the whole of this worked: the driver, the
 * label, the plugin running on the node and the plugin finding the
 * cards. Straight after an install the plugin may not have told the
 * kubelet yet, so that's waited for, and nowhere else.
 */
const verifyAllocatable: CommandSpec = {
  name: "verify-amd-gpus-allocatable",
  purpose: CommandPurpose.Verify,
  description: "Verify a node with a working AMD driver offers its cards as amd.com/gpu",
  runOn: CommandTarget.ControlPlane,
  scope: CommandScope.EachNode,
  env: buildKubeEnv,
  skipWhen: (config: CloudConfig, context: any) =>
    noAmdHardware(config, context) || context.amdDriverWorking !== true,
  command: (_config: CloudConfig, context: any) => {
    const name = getClusterNodeName(context);
    const read = `kubectl get node ${quoteForShell(name)} -o jsonpath='{.status.allocatable.amd\\.com/gpu}' 2>/dev/null`;

    return [
      waitUntil(`[ "$(${read})" -gt 0 ] 2>/dev/null`, getWaitSeconds(context, PLUGIN_TIMEOUT_SECONDS)),
      `gpus=$(${read})`,
      `[ "\${gpus:-0}" -gt 0 ] 2>/dev/null || { echo "${name}'s amdgpu driver works, but it offers no amd.com/gpu. Check the device plugin's pod on it in ${DEVICE_PLUGIN.namespace}, and that the node has the ${DRIVER_LABEL} label, and run the amd bundle again." >&2; exit 1; }`,
      `echo "${name} offers $gpus amd.com/gpu"`,
    ];
  },
  output: OutputType.Raw,
};

// The chart, and its checks. In the order they run: the nodes have to
// be labelled before there's anything to look for, and the plugin
// running before a node can offer anything.
export const AmdDevicePluginCommands: CommandSpec[] = [
  findDriverNodes,
  ...[checkHelmAvailableCommand, ...buildPackageCommands(DEVICE_PLUGIN)].map(whenDriverNodes),
  verifyAllocatable,
];
