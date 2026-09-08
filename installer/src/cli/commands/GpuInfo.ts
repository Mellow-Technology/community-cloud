/**
 * @file
 * Detect video hardware and what it needs to be usable.
 *
 * The point of this isn't the inventory for its own sake: a container
 * can only reach a GPU if the right vendor runtime is on the node and
 * the right device nodes are passed through, and which runtime that is
 * depends on who made the card. So this works out what's on a node,
 * who made it, and whether the tooling is already there, and leaves
 * the answer in the bundle's context for the bundles that install it.
 *
 * Detection reads sysfs rather than shelling out to lspci, because a
 * node isn't guaranteed to have pciutils and sysfs is always there on
 * Linux. lspci is used afterwards, if present, purely to put readable
 * names on what sysfs already found by number.
 *
 * Two things are deliberately included that aren't GPUs:
 * - onboard server video, which nearly every rack machine has and no
 *   workload should ever be pointed at
 * - the /dev/dri render nodes, which are what a container actually
 *   needs handed to it
 */
import { CommandOutput, CommandSpec, OutputType } from "./Command.ts";
import { GpuVendor, VideoDevice } from "../../util/types.ts";

/**
 * PCI vendor IDs, and whether hardware from that vendor is something
 * a workload can use.
 *
 * The display-only entries are the reason this map exists. A server
 * with an ASPEED BMC and nothing else has video hardware and no GPU,
 * and telling those apart by name is guesswork.
 */
const PCI_VENDORS: Record<string, { vendor: GpuVendor; compute: boolean }> = {
  "0x10de": { vendor: GpuVendor.Nvidia, compute: true },
  "0x1002": { vendor: GpuVendor.Amd, compute: true },
  "0x1022": { vendor: GpuVendor.Amd, compute: true },
  "0x8086": { vendor: GpuVendor.Intel, compute: true },

  "0x1a03": { vendor: GpuVendor.Aspeed, compute: false },
  "0x102b": { vendor: GpuVendor.Matrox, compute: false },
  "0x1af4": { vendor: GpuVendor.Virtio, compute: false },
  "0x1b36": { vendor: GpuVendor.Qemu, compute: false },
  "0x1234": { vendor: GpuVendor.Qemu, compute: false },
  "0x15ad": { vendor: GpuVendor.Vmware, compute: false },
  "0x1414": { vendor: GpuVendor.Hyperv, compute: false },
};

/**
 * Kernel drivers for video hardware that isn't on a PCI bus, which is
 * how the GPU on an ARM board appears. There's no vendor ID to go on,
 * so the driver name is what we have.
 */
const PLATFORM_DRIVERS: Record<string, { vendor: GpuVendor; compute: boolean }> = {
  panfrost: { vendor: GpuVendor.Unknown, compute: true },
  panthor: { vendor: GpuVendor.Unknown, compute: true },
  lima: { vendor: GpuVendor.Unknown, compute: true },
  v3d: { vendor: GpuVendor.Unknown, compute: true },
  vc4: { vendor: GpuVendor.Unknown, compute: false },
  etnaviv: { vendor: GpuVendor.Unknown, compute: true },
};

// The PCI class for display hardware. Everything under it counts:
// 0300 is a VGA controller, but a datacentre card with no display
// output at all reports 0302, and missing those would be a bad joke.
const DISPLAY_CLASS_PREFIX = "0x03";

/**
 * Walk sysfs for anything that draws pixels or does GPU compute.
 *
 * Written as one shell script rather than a pipeline of tools so it
 * runs the same on a minimal node, and reads sysfs directly so it
 * needs nothing installed.
 *
 * The lines are joined with newlines rather than semicolons: a
 * semicolon straight after "do" or "then" is a syntax error, and
 * newlines separate statements everywhere a semicolon would.
 */
const DETECT_SCRIPT = [
  // PCI display hardware
  'for device in /sys/bus/pci/devices/*; do',
  '  [ -r "$device/class" ] || continue',
  '  class=$(cat "$device/class")',
  `  case "$class" in ${DISPLAY_CLASS_PREFIX}*) ;; *) continue ;; esac`,
  '  driver=""',
  '  if [ -L "$device/driver" ]; then driver=$(basename "$(readlink -f "$device/driver")"); fi',
  '  printf "pci|%s|%s|%s|%s|%s\\n" "$(basename "$device")" "$class" "$(cat "$device/vendor")" "$(cat "$device/device")" "$driver"',
  'done',

  // Anything with a DRM card but no PCI vendor, which is a GPU
  // attached some other way. Connector directories are named
  // "card0-HDMI-A-1" and are not devices, so they're skipped.
  'for card in /sys/class/drm/card*; do',
  '  name=$(basename "$card")',
  '  case "$name" in *-*) continue ;; esac',
  '  [ -d "$card/device" ] || continue',
  '  [ -r "$card/device/vendor" ] && continue',
  '  driver=""',
  '  if [ -L "$card/device/driver" ]; then driver=$(basename "$(readlink -f "$card/device/driver")"); fi',
  '  printf "platform|%s|%s\\n" "$name" "$driver"',
  'done',

  // What a container would need passed through
  'for node in /dev/dri/*; do',
  '  [ -e "$node" ] || continue',
  '  printf "devnode|%s\\n" "$node"',
  'done',
].join("\n");

/**
 * Read a field out of a split line, treating a missing one as empty.
 *
 * Every line here is written by the scripts above, but the compiler
 * has no way of knowing that and a truncated line shouldn't throw.
 *
 * @param fields
 * @param index
 * @returns
 */
function field(fields: string[], index: number): string {
  const value = fields[index];
  return value !== undefined ? value : "";
}

/**
 * Turn the detection output into a list of devices.
 *
 * @param output
 * @returns
 */
function parseDetection(output: CommandOutput) {
  const devices: VideoDevice[] = [];
  const renderNodes: string[] = [];

  for (const line of readLines(output)) {
    const fields = line.split("|");

    if (fields[0] === "pci") {
      const address = field(fields, 1);
      const deviceClass = field(fields, 2);
      const vendorId = field(fields, 3);
      const deviceId = field(fields, 4);
      const driver = field(fields, 5);
      const known = PCI_VENDORS[vendorId];

      devices.push({
        address,
        vendor: known !== undefined ? known.vendor : GpuVendor.Unknown,
        // An unrecognised vendor with display hardware is worth
        // treating as usable, since being unknown to this list is not
        // evidence of anything
        compute: known !== undefined ? known.compute : true,
        vendorId,
        deviceId,
        deviceClass,
        driver: driver !== "" ? driver : undefined,
      });
      continue;
    }

    if (fields[0] === "platform") {
      const address = field(fields, 1);
      const driver = field(fields, 2);
      const known = driver !== "" ? PLATFORM_DRIVERS[driver] : undefined;

      devices.push({
        address,
        vendor: known !== undefined ? known.vendor : GpuVendor.Unknown,
        compute: known !== undefined ? known.compute : true,
        driver: driver !== "" ? driver : undefined,
      });
      continue;
    }

    if (fields[0] === "devnode") {
      renderNodes.push(field(fields, 1));
    }
  }

  describeDevices(devices, renderNodes);

  return { devices, renderNodes };
}

/**
 * Say what was found, since this bundle exists to be read.
 *
 * @param devices
 * @param renderNodes
 */
function describeDevices(devices: VideoDevice[], renderNodes: string[]) {
  if (devices.length === 0) {
    console.log("No video hardware found on this node.");
    return;
  }

  for (const device of devices) {
    const model = device.model !== undefined ? device.model : describeIds(device);
    const driver = device.driver !== undefined ? device.driver : "no driver bound";
    const usable = device.compute ? "" : " (display only)";
    console.log(`  ${device.address}  ${device.vendor}${usable}  ${model}  [${driver}]`);
  }

  console.log(
    renderNodes.length > 0
      ? `  render nodes: ${renderNodes.join(", ")}`
      : "  no /dev/dri nodes, so nothing to pass into a container yet",
  );
}

/**
 * A fallback label for hardware lspci hasn't named.
 *
 * @param device
 * @returns
 */
function describeIds(device: VideoDevice): string {
  return device.vendorId !== undefined
    ? `${device.vendorId}:${device.deviceId}`
    : "unnamed device";
}

/**
 * The devices found so far.
 *
 * @param context
 * @returns
 */
function getDevices(context: any): VideoDevice[] {
  return Array.isArray(context.videoDevices) ? context.videoDevices : [];
}

/**
 * Whether a vendor's hardware is on this node.
 *
 * The vendor commands below use it to decide there's nothing for them
 * to do, and it's exported because the bundles that install a vendor's
 * runtime want exactly the same question answered:
 *
 *   skipWhen: (config, context) => !hasGpuVendor(context, GpuVendor.Nvidia)
 *
 * @param context
 * @param vendor
 * @returns
 */
export function hasGpuVendor(context: any, vendor: GpuVendor): boolean {
  return getDevices(context).some(
    (device) => device.vendor === vendor && device.compute,
  );
}

/**
 * Merge details onto the devices already found, matched by address.
 *
 * @param context
 * @param updates
 * @returns
 */
function mergeDevices(
  context: any,
  updates: Map<string, Partial<VideoDevice>>,
): VideoDevice[] {
  return getDevices(context).map((device) => {
    const update = updates.get(device.address);
    return update !== undefined ? { ...device, ...update } : device;
  });
}

/**
 * Split output into non-empty lines.
 *
 * @param output
 * @returns
 */
function readLines(output: CommandOutput): string[] {
  const text = typeof output.parsed === "string" ? output.parsed : output.stdout;

  return (text !== null && text !== undefined ? text : "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export const GpuInfoCommands: CommandSpec[] = [
  /**
   * Find the hardware.
   */
  {
    name: "detect-video-hardware",
    description: "Find the video hardware on the node and work out who made it",
    command: DETECT_SCRIPT,
    output: OutputType.Raw,
    postProcessHooks: [parseDetection],
    saveToContext: (output: any) => ({
      videoDevices: output.processed.devices,
      gpuRenderNodes: output.processed.renderNodes,

      // The vendors worth installing something for, display-only
      // hardware left out
      gpuVendors: [
        ...new Set(
          output.processed.devices
            .filter((device: VideoDevice) => device.compute)
            .map((device: VideoDevice) => device.vendor),
        ),
      ],
    }),
  },

  /**
   * Put names to it, when the node can.
   *
   * sysfs knows a card is 0x10de:0x2204 and nothing more; the name
   * lives in the PCI ID database that ships with pciutils. Useful when
   * it's there, not worth requiring when it isn't.
   */
  {
    name: "name-video-hardware",
    description: "Name the detected hardware using lspci, when it's installed",
    skipWhen: (_config: any, context: any) => getDevices(context).length === 0,
    command:
      'if command -v lspci > /dev/null 2>&1; then lspci -D -mm 2>/dev/null || true; else echo "lspci is not installed, so the hardware is reported by ID only"; fi',
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => {
        const names = new Map<string, string>();

        for (const line of readLines(output)) {
          // "0000:01:00.0 "VGA compatible controller" "NVIDIA Corporation" "GA102 [GeForce RTX 3090]" ..."
          const address = field(line.split(" "), 0);
          const quoted = line.match(/"([^"]*)"/g);

          if (quoted === null || quoted.length < 3) {
            continue;
          }

          const parts = quoted.map((part) => part.slice(1, -1));
          names.set(address, `${field(parts, 1)} ${field(parts, 2)}`.trim());
        }

        return names;
      },
    ],
    saveToContext: (output: any, context: any) => {
      const names: Map<string, string> = output.processed;

      const updates = new Map<string, Partial<VideoDevice>>();
      for (const [address, model] of names) {
        updates.set(address, { model });
      }

      const devices = mergeDevices(context, updates);
      describeDevices(devices, context.gpuRenderNodes ?? []);

      return { videoDevices: devices };
    },
  },

  /**
   * Ask NVIDIA's own tool, which is the only thing that knows the
   * memory, the driver version and the compute capability. Its
   * absence is itself the answer: no nvidia-smi means the driver
   * stack isn't installed yet.
   */
  {
    name: "nvidia-gpu-details",
    description: "Read NVIDIA GPU details from nvidia-smi",
    skipWhen: (_config: any, context: any) => !hasGpuVendor(context, GpuVendor.Nvidia),
    command: [
      'if command -v nvidia-smi > /dev/null 2>&1',
      'then echo "tooling|installed"',
      '  nvidia-smi --query-gpu=pci.bus_id,name,memory.total,driver_version,compute_cap,uuid --format=csv,noheader,nounits 2>/dev/null || true',
      'else echo "tooling|missing"',
      "fi",
    ].join("\n"),
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => {
        const updates = new Map<string, Partial<VideoDevice>>();
        let toolingInstalled = false;

        for (const line of readLines(output)) {
          if (line.startsWith("tooling|")) {
            toolingInstalled = line.endsWith("installed");
            continue;
          }

          const row = line.split(",").map((value) => value.trim());
          const busId = field(row, 0);
          const name = field(row, 1);
          const computeCap = field(row, 4);
          const uuid = field(row, 5);

          if (busId === "" || name === "") {
            continue;
          }

          updates.set(normaliseBusId(busId), {
            model: name,
            // nvidia-smi reports mebibytes
            memoryBytes: toBytes(field(row, 2), 1024 * 1024),
            driverVersion: field(row, 3),
            computeCapability: computeCap !== "" ? computeCap : undefined,
            uuid: uuid !== "" ? uuid : undefined,
          });
        }

        console.log(
          toolingInstalled
            ? `nvidia-smi reported ${updates.size} GPU${updates.size === 1 ? "" : "s"}`
            : "nvidia-smi isn't installed, so the NVIDIA driver stack still needs setting up",
        );

        return { updates, toolingInstalled };
      },
    ],
    saveToContext: (output: any, context: any) => ({
      videoDevices: mergeDevices(context, output.processed.updates),
      nvidiaToolingInstalled: output.processed.toolingInstalled,
    }),
  },

  /**
   * AMD memory comes from the amdgpu driver through sysfs, so it's
   * readable without ROCm. Whether ROCm is there is asked separately,
   * because that's the part a workload needs and the part that has to
   * be installed.
   */
  {
    name: "amd-gpu-details",
    description: "Read AMD GPU details from sysfs and check for ROCm",
    skipWhen: (_config: any, context: any) => !hasGpuVendor(context, GpuVendor.Amd),
    command: [
      'for card in /sys/class/drm/card*',
      "do name=$(basename \"$card\")",
      '  case "$name" in *-*) continue ;; esac',
      '  [ -r "$card/device/mem_info_vram_total" ] || continue',
      '  address=$(basename "$(readlink -f "$card/device")")',
      '  units=""',
      '  if [ -r "$card/device/num_compute_units" ]; then units=$(cat "$card/device/num_compute_units"); fi',
      '  printf "vram|%s|%s|%s\\n" "$address" "$(cat "$card/device/mem_info_vram_total")" "$units"',
      "done",
      'for tool in rocm-smi amd-smi',
      "do if command -v $tool > /dev/null 2>&1",
      '   then printf "tooling|%s|installed\\n" "$tool"',
      '   else printf "tooling|%s|missing\\n" "$tool"',
      "   fi",
      "done",
    ].join("\n"),
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => {
        const updates = new Map<string, Partial<VideoDevice>>();
        const tooling: Record<string, boolean> = {};

        for (const line of readLines(output)) {
          const fields = line.split("|");

          if (fields[0] === "vram") {
            const units = field(fields, 3);
            updates.set(field(fields, 1), {
              // amdgpu reports this one in bytes already
              memoryBytes: toBytes(field(fields, 2), 1),
              cores: units !== "" ? Number.parseInt(units, 10) : undefined,
            });
            continue;
          }

          if (fields[0] === "tooling") {
            tooling[field(fields, 1)] = field(fields, 2) === "installed";
          }
        }

        const installed = Object.entries(tooling)
          .filter(([, present]) => present)
          .map(([tool]) => tool);

        console.log(
          installed.length > 0
            ? `AMD tooling present: ${installed.join(", ")}`
            : "No ROCm tooling found, so AMD compute still needs setting up",
        );

        return { updates, toolingInstalled: installed.length > 0, tooling };
      },
    ],
    saveToContext: (output: any, context: any) => ({
      videoDevices: mergeDevices(context, output.processed.updates),
      amdToolingInstalled: output.processed.toolingInstalled,
    }),
  },

  /**
   * Intel graphics share system memory, so there's no VRAM figure to
   * report. What matters is whether a render node exists and which
   * driver took the card, since i915 and xe want different runtimes.
   */
  {
    name: "intel-gpu-details",
    description: "Read Intel GPU details and check for the compute runtime",
    skipWhen: (_config: any, context: any) => !hasGpuVendor(context, GpuVendor.Intel),
    command: [
      'for card in /sys/class/drm/card*',
      "do name=$(basename \"$card\")",
      '  case "$name" in *-*) continue ;; esac',
      '  [ -d "$card/device" ] || continue',
      '  address=$(basename "$(readlink -f "$card/device")")',
      '  frequency=""',
      '  for knob in "$card/gt_max_freq_mhz" "$card/gt/gt0/rps_max_freq_mhz"',
      '  do if [ -r "$knob" ]; then frequency=$(cat "$knob"); break; fi',
      "  done",
      '  printf "card|%s|%s\\n" "$address" "$frequency"',
      "done",
      'for tool in clinfo intel_gpu_top',
      "do if command -v $tool > /dev/null 2>&1",
      '   then printf "tooling|%s|installed\\n" "$tool"',
      '   else printf "tooling|%s|missing\\n" "$tool"',
      "   fi",
      "done",
    ].join("\n"),
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => {
        const updates = new Map<string, Partial<VideoDevice>>();
        const tooling: Record<string, boolean> = {};

        for (const line of readLines(output)) {
          const fields = line.split("|");

          const frequency = field(fields, 2);
          if (fields[0] === "card" && frequency !== "") {
            updates.set(field(fields, 1), {
              maxFrequencyMhz: Number.parseInt(frequency, 10),
            });
            continue;
          }

          if (fields[0] === "tooling") {
            tooling[field(fields, 1)] = field(fields, 2) === "installed";
          }
        }

        const installed = Object.entries(tooling)
          .filter(([, present]) => present)
          .map(([tool]) => tool);

        console.log(
          installed.length > 0
            ? `Intel tooling present: ${installed.join(", ")}`
            : "No Intel compute tooling found",
        );

        return { updates, toolingInstalled: installed.length > 0 };
      },
    ],
    saveToContext: (output: any, context: any) => ({
      videoDevices: mergeDevices(context, output.processed.updates),
      intelToolingInstalled: output.processed.toolingInstalled,
    }),
  },
];

/**
 * Turn a reported size into bytes, leaving it out when there wasn't one.
 *
 * @param value
 * @param multiplier
 * @returns
 */
function toBytes(value: string | undefined, multiplier: number): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  const size = Number.parseInt(value, 10);
  return Number.isNaN(size) ? undefined : size * multiplier;
}

/**
 * nvidia-smi writes bus IDs as "00000000:01:00.0" while sysfs uses
 * "0000:01:00.0", and they have to match to be merged.
 *
 * @param busId
 * @returns
 */
function normaliseBusId(busId: string): string {
  const normalised = busId.trim().toLowerCase();
  const parts = normalised.split(":");

  if (parts.length !== 3) {
    return normalised;
  }

  // sysfs uses a four digit domain, nvidia-smi an eight digit one
  return `${field(parts, 0).slice(-4)}:${field(parts, 1)}:${field(parts, 2)}`;
}
