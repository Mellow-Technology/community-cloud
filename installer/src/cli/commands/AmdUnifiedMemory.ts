/**
 * @file
 * How an AMD APU's memory is split between Linux and its GPU.
 *
 * An APU, such as the Ryzen AI Max ("Strix Halo", gfx1151), has no
 * memory of its own. The GPU gets RAM in two ways:
 *
 * - VRAM: a share the BIOS sets aside at boot. Linux never sees it, so
 *   it can't be used for anything else, GPU idle or not.
 * - GTT: ordinary RAM the GPU borrows as it needs it and gives back.
 *   How much it may borrow is ttm.pages_limit, which defaults to half
 *   of RAM.
 *
 * AMD's advice is a small BIOS share, about 0.5 GB, and a GTT limit
 * raised to what the GPU should be able to use, so the memory is shared
 * rather than split for good. A large BIOS share with GTT left alone is
 * the setup to catch: the GPU gets the BIOS share, and Linux, and so
 * Kubernetes, sees only what's left.
 *
 * Fixing that means the BIOS and a reboot, which aren't things to do
 * to a node in passing, so this only says what it found and what to
 * change. The same goes for the kernel, which needs particular fixes
 * for gfx1151.
 *
 * The answers come from sysfs, matched up by render node: KFD knows
 * each GPU's architecture, and amdgpu each card's VRAM and GTT.
 */
import { CommandOutput } from "./Command.ts";
import { field, readRecords } from "./output.ts";

// The APUs AMD's RDNA 3.5 memory advice is for: Strix Point, Strix
// Halo and Krackan Point
export const UNIFIED_MEMORY_TARGETS = ["gfx1150", "gfx1151", "gfx1152", "gfx1153"];

// The one this file's kernel requirement is for. AMD list the fixes
// Ryzen AI Max needs as in 6.18.4, and backported to two of Ubuntu
// 24.04's kernels.
const STRIX_HALO = "gfx1151";
const MINIMUM_KERNEL = [6, 18, 4];
const BACKPORTED_KERNELS = [
  { base: [6, 17, 0], abi: 19, flavour: "generic", name: "Ubuntu 24.04's HWE kernel 6.17.0-19" },
  { base: [6, 14, 0], abi: 1018, flavour: "oem", name: "Ubuntu 24.04's OEM kernel 6.14.0-1018" },
];

// A BIOS share past this is memory taken from Linux for good. AMD
// suggest 0.5 GB; a few GB is harmless, tens of GB is the problem.
const LARGE_RESERVATION_BYTES = 4 * 1024 ** 3;

// How close GTT has to be to half of RAM to count as the default. Not
// exact, since the kernel works it out from a slightly different total
// than /proc/meminfo reports.
const DEFAULT_GTT_TOLERANCE = 0.05;

// ttm.pages_limit counts 4 KiB pages
const PAGE_BYTES = 4096;
const GIB = 1024 ** 3;

/**
 * Read the kernel, RAM, ttm.pages_limit, and every amdgpu card's
 * architecture and memory.
 *
 * Lines are newline separated, since a semicolon straight after "do"
 * or "then" is a syntax error.
 */
export const UNIFIED_MEMORY_PROBE = [
  'echo "kernel|$(uname -r)"',
  "while read -r key value unit",
  'do if [ "$key" = MemTotal: ]; then echo "ram|$value"; fi',
  "done < /proc/meminfo",
  "if [ -r /sys/module/ttm/parameters/pages_limit ]",
  'then echo "pages|$(cat /sys/module/ttm/parameters/pages_limit)"',
  "fi",

  // Each GPU KFD knows, by its render node
  "for properties in /sys/class/kfd/kfd/topology/nodes/*/properties",
  'do [ -r "$properties" ] || continue',
  '  minor=""',
  '  target=""',
  "  while read -r key value",
  '  do case "$key" in',
  '    drm_render_minor) minor=$value ;;',
  '    gfx_target_version) target=$value ;;',
  "    esac",
  '  done < "$properties"',
  '  if [ -n "$target" ] && [ "$target" != 0 ]; then echo "target|$minor|$target"; fi',
  "done",

  // Each card amdgpu has, by the same
  "for card in /sys/class/drm/card*",
  'do case "$(basename "$card")" in *-*) continue ;; esac',
  '  [ -r "$card/device/mem_info_vram_total" ] || continue',
  '  minor=""',
  '  for render in "$card"/device/drm/renderD*',
  '  do [ -e "$render" ] && minor=${render##*renderD}',
  "  done",
  '  gtt=""',
  '  if [ -r "$card/device/mem_info_gtt_total" ]; then gtt=$(cat "$card/device/mem_info_gtt_total"); fi',
  '  echo "memory|$minor|$(basename "$(readlink -f "$card/device")")|$(cat "$card/device/mem_info_vram_total")|$gtt"',
  "done",
];

/**
 * What the probe found about one APU.
 */
export interface UnifiedMemoryCard {
  address: string;
  target: string;
  vramBytes: number;
  gttBytes?: number;
}

/**
 * What the probe found about the node.
 */
export interface UnifiedMemoryFindings {
  kernel?: string;
  ramBytes?: number;
  pagesLimit?: number;
  cards: UnifiedMemoryCard[];
}

/**
 * What to say about it.
 */
export interface UnifiedMemoryAssessment {
  notes: string[];
  warnings: string[];
}

/**
 * Turn KFD's gfx_target_version into the name ROCm uses.
 *
 * It's major, minor and stepping as decimal pairs: 110501 is gfx1151
 * and 90010 is gfx90a, the stepping being written in hex.
 *
 * @param version
 * @returns
 */
export function toGfxTarget(version: number): string {
  const major = Math.floor(version / 10000);
  const minor = Math.floor(version / 100) % 100;
  const stepping = version % 100;

  return `gfx${major}${minor}${stepping.toString(16)}`;
}

/**
 * Read the probe's output, keeping the APUs.
 *
 * @param output
 * @returns
 */
export function parseUnifiedMemory(output: CommandOutput): UnifiedMemoryFindings {
  const findings: UnifiedMemoryFindings = { cards: [] };
  const targets = new Map<string, string>();
  const memory: { minor: string; address: string; vram: number; gtt?: number }[] = [];

  for (const { kind, fields } of readRecords(output)) {
    const number = (index: number) => {
      const value = Number.parseInt(field(fields, index), 10);
      return Number.isNaN(value) ? undefined : value;
    };

    if (kind === "kernel") {
      findings.kernel = field(fields, 0);
    } else if (kind === "ram") {
      // /proc/meminfo counts kB, which are KiB
      const kib = number(0);
      findings.ramBytes = kib !== undefined ? kib * 1024 : undefined;
    } else if (kind === "pages") {
      findings.pagesLimit = number(0);
    } else if (kind === "target") {
      const version = number(1);
      if (version !== undefined) {
        targets.set(field(fields, 0), toGfxTarget(version));
      }
    } else if (kind === "memory") {
      const vram = number(2);
      if (vram !== undefined) {
        memory.push({ minor: field(fields, 0), address: field(fields, 1), vram, gtt: number(3) });
      }
    }
  }

  for (const card of memory) {
    const target = targets.get(card.minor);
    if (target !== undefined && UNIFIED_MEMORY_TARGETS.includes(target)) {
      findings.cards.push({ address: card.address, target, vramBytes: card.vram, gttBytes: card.gtt });
    }
  }

  return findings;
}

/**
 * A size, for someone to read.
 *
 * @param bytes
 * @returns
 */
function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

/**
 * ttm.pages_limit for a number of GiB.
 *
 * @param gibibytes
 * @returns
 */
export function toPagesLimit(gibibytes: number): number {
  return Math.round((gibibytes * GIB) / PAGE_BYTES);
}

/**
 * Whether a kernel has the fixes gfx1151 needs.
 *
 * @param release what uname -r says, e.g. "7.0.0-43-generic"
 * @returns undefined when it can't tell
 */
export function hasStrixHaloKernel(release: string): boolean | undefined {
  const match = release.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:-(\d+))?(?:-(\w+))?/);
  if (match === null) {
    return undefined;
  }

  const base = [match[1], match[2], match[3] ?? "0"].map((part) => Number.parseInt(part!, 10));
  const abi = match[4] !== undefined ? Number.parseInt(match[4], 10) : 0;
  const flavour = match[5] ?? "";

  if (compareVersions(base, MINIMUM_KERNEL) >= 0) {
    return true;
  }

  return BACKPORTED_KERNELS.some(
    (kernel) => compareVersions(base, kernel.base) === 0 && abi >= kernel.abi && flavour === kernel.flavour,
  );
}

/**
 * Compare two versions, part by part.
 *
 * @param one
 * @param other
 * @returns negative, zero or positive
 */
function compareVersions(one: number[], other: number[]): number {
  for (let index = 0; index < Math.max(one.length, other.length); index++) {
    const difference = (one[index] ?? 0) - (other[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

/**
 * Say how an APU's memory is set up, and what to change.
 *
 * @param findings
 * @returns nothing at all for a node without an APU
 */
export function assessUnifiedMemory(findings: UnifiedMemoryFindings): UnifiedMemoryAssessment {
  const notes: string[] = [];
  const warnings: string[] = [];

  if (findings.cards.length === 0) {
    return { notes, warnings };
  }

  const ram = findings.ramBytes;

  if (findings.cards.some((card) => card.target === STRIX_HALO) && findings.kernel !== undefined) {
    const ready = hasStrixHaloKernel(findings.kernel);

    if (ready === false) {
      warnings.push(
        `⚠️  Kernel ${findings.kernel} is older than AMD support for Ryzen AI Max (gfx1151): it needs 6.18.4 or later, or ${BACKPORTED_KERNELS.map((kernel) => `${kernel.name} or later`).join(", or ")}. Upgrade the kernel and reboot.`,
      );
    } else if (ready === true) {
      notes.push(`Kernel ${findings.kernel} has the fixes Ryzen AI Max (gfx1151) needs`);
    }
  }

  for (const card of findings.cards) {
    const gtt = card.gttBytes;
    notes.push(
      `${card.address} (${card.target}, an APU): the BIOS sets aside ${gib(card.vramBytes)} for the GPU${gtt !== undefined ? `, and it may borrow up to ${gib(gtt)} more of RAM through GTT` : ""}${ram !== undefined ? `. Linux has ${gib(ram)}.` : "."}${findings.pagesLimit !== undefined ? ` ttm.pages_limit is ${findings.pagesLimit}.` : ""}`,
    );

    const largeReservation = card.vramBytes > LARGE_RESERVATION_BYTES;
    const defaultGtt =
      gtt !== undefined && ram !== undefined && Math.abs(gtt - ram / 2) <= ram * DEFAULT_GTT_TOLERANCE;

    if (!largeReservation && !defaultGtt) {
      continue;
    }

    // What to give the GPU: the share it has now when the BIOS sets
    // that, so nothing that fits today stops fitting, and otherwise
    // three quarters of the machine
    const total = (ram ?? 0) + card.vramBytes;
    const share = largeReservation ? Math.round(card.vramBytes / GIB) : Math.floor((total * 0.75) / GIB);
    const pages = toPagesLimit(share);

    const found = [
      largeReservation
        ? `the BIOS sets aside ${gib(card.vramBytes)} for the GPU, which Linux and Kubernetes can never use, even with the GPU idle`
        : undefined,
      defaultGtt ? `GTT is left at its default, half of the RAM Linux has (${gib(gtt!)})` : undefined,
    ].filter((part) => part !== undefined);

    warnings.push(
      [
        `⚠️  On ${card.address}, ${found.join(", and ")}. AMD's advice for this APU is a small BIOS share and a GTT limit raised instead, so the memory is shared rather than split for good. To give the GPU ${share} GiB:`,
        `  1. In the BIOS, set the GPU's dedicated memory (UMA frame buffer) to its minimum, about 0.5 GB.`,
        `  2. Add ttm.pages_limit=${pages} to GRUB_CMDLINE_LINUX_DEFAULT in /etc/default/grub, run "sudo update-grub", and reboot. It counts 4 KiB pages: GiB × 262144.`,
        `  Linux, and Kubernetes, will then see about ${gib(total)}, and what the GPU borrows comes out of it, so reserve it for the pod using the GPU. See "AMD GPUs" in the installer's README.`,
      ].join("\n"),
    );
  }

  return { notes, warnings };
}
