/**
 * @file GPU detection utilities using command-line tools.
 *
 * Provides a pluggable, framework-agnostic way to detect GPU presence,
 * vendor type (NVIDIA/AMD/Intel), model name, driver availability,
 * and count—primarily for remote agents (e.g., SSH-based) but also works locally.
 */

import type { GpuInfo } from "./types";

// ───────────────────────────────────────────────────────────────────────
// Types & Interfaces
// ───────────────────────────────────────────────────────────────────────

/**
 * Represents a command invocation and its output parser for GPU-related queries.
 *
 * Used internally to decouple shell command execution from parsing logic,
 * enabling testability via mock outputs.
 */
export interface CommandWithParser<T = Partial<GpuInfo>> {
  /**
   * Shell command to execute (e.g., `nvidia-smi --query-gpu=name,driver_version ...`).
   *
   * Should be safe to run in a POSIX environment; stderr is suppressed in calls.
   */
  cmd: string;

  /**
   * Parses raw stdout into structured GPU information.
   *
   * @param output — Raw command-line output (string)
   * @returns Partial {@link GpuInfo} with detected attributes or `type: "none"` on failure
   */
  parse(output: string): T;
}

/**
 * Result of a GPU detection pass—may be incomplete if multiple GPUs exist.
 *
 * This interface is used as an accumulator during detection,
 * and normalized before returning the final result.
 */
export type GpuDetectionResult = {
  /**
   * Vendor type of the detected GPU(s).
   * Priority: NVIDIA > AMD > Intel
   */
  type: "nvidia" | "amd" | "intel" | "none";

  /**
   * Human-readable model name (e.g., `"NVIDIA A10"`, `"Radeon RX 6800"`).
   *
   * May be omitted for unrecognized or unknown hardware.
   */
  model?: string;

  /**
   * Indicates whether the appropriate GPU drivers are installed and detectable.
   * Only set for vendors where driver presence is a known success criterion (e.g., AMD ROCm).
   */
  driversInstalled?: boolean;

  /**
   * Number of detected GPUs — currently only populated for NVIDIA via `nvidia-smi`.
   */
  count?: number;
};

// ───────────────────────────────────────────────────────────────────────
// Command builders — pure functions that return executable commands + parsers
// ───────────────────────────────────────────────────────────────────────

/**
 * Builds a command and parser for querying NVIDIA GPUs via `nvidia-smi`.
 *
 * Uses CSV output to reliably parse model name and driver version.
 * Falls back gracefully if the binary is missing or returns no rows.
 *
 * @returns A {@link CommandWithParser} configured to execute and parse `nvidia-smi` output
 */
const buildNvidiaCmd = (): CommandWithParser<Partial<GpuInfo>> => ({
  /**
   * Queries NVIDIA GPUs for model name and driver version in CSV format.
   * - `--format=csv,noheader,nounits`: avoids headers, units, and human-readable formatting.
   * - `2>/dev/null`: suppresses error output (e.g., binary not found).
   */
  cmd: "nvidia-smi --query-gpu=name,driver_version --format=csv,noheader,nounits 2>/dev/null",

  /**
   * Parses the CSV output of `nvidia-smi`.
   *
   * Expected format: `"NVIDIA A10", "525.85.05"`
   * Handles multiple GPUs by counting lines and only using the first for model info.
   */
  parse: (stdout: string): Partial<GpuInfo> => {
    // Split into rows, filter out empty or whitespace-only entries
    const lines = stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    if (!lines.length) return { type: "none" };

    // Extract model and driver from first row (assumes single GPU in CLI format)
    const [model, driverVersion] = lines[0].split(",").map((s) => s?.trim());

    // Require both fields to be present and non-empty
    if (!model || !driverVersion) return { type: "none" };

    return {
      type: "nvidia",
      model,
      driversInstalled: driverVersion.length > 0,
      count: lines.length, // total number of detected GPUs
    };
  },
});

/**
 * Builds a command and parser for detecting AMD GPUs via `lspci`.
 *
 * Searches PCI bus for devices with vendor string "Advanced Micro Devices" (or similar).
 * Falls back to extracting the PCI device ID if model name is unavailable.
 *
 * @returns A {@link CommandWithParser} configured for AMD GPU detection
 */
const buildAmdCmd = (): CommandWithParser<Partial<GpuInfo>> => ({
  /**
   * Lists all PCI devices, then filters for lines containing:
   * - `VGA`, `3D`, or `Display` (GPU-related classes)
   * - Vendor string "Advanced Micro Devices" (AMD)
   */
  cmd: 'lspci -v 2>/dev/null | grep -Ei "(VGA|3D|Display)" | grep -Ei "Advanced Micro Devices" || true',

  /**
   * Parses `lspci` output to detect AMD GPUs.
   *
   * Tries to extract model (e.g., `Radeon Pro W6800`, or `Device 744c`) from output.
   * Returns `{ type: "none" }` if no AMD device is found.
   */
  parse: (stdout: string): Partial<GpuInfo> => {
    const normalized = stdout.toLowerCase();

    // Check for presence of AMD vendor string
    if (!normalized.includes("advanced micro devices")) return { type: "none" };

    let model: string | undefined;

    // Try common Radeon naming patterns (case-insensitive)
    const modelMatch = stdout.match(/Radeon\s+([A-Za-z0-9\-]+)/i);
    if (modelMatch) {
      model = modelMatch[1]; // e.g., `Pro W6800`, `RX 6700`
    }

    // Fallback: extract raw PCI device ID for unknown models
    if (!model) {
      const pciIdMatch = stdout.match(/Device\s+([\da-fA-F]{4})/i);
      if (pciIdMatch) {
        model = `AMD-GPU-${pciIdMatch[1]}`; // e.g., `AMD-GPU-744c`
      }
    }

    return { type: "amd", model };
  },
});

/**
 * Builds a command and parser for detecting Intel GPUs via `lspci`.
 *
 * Scans for display controllers or VGA devices with Intel vendor string.
 * Normalizes model names by stripping trailing `" Graphics"` suffixes.
 *
 * @returns A {@link CommandWithParser} configured for Intel GPU detection
 */
const buildIntelCmd = (): CommandWithParser<Partial<GpuInfo>> => ({
  /**
   * Lists PCI devices, filters for display controllers (VGA/Display),
   * then checks if the device is manufactured by Intel.
   *
   * Limits to first match (`head -n1`) to avoid duplicate entries from multi-head setups.
   */
  cmd: 'lspci -v 2>/dev/null | grep -Ei "VGA|Display" | grep -Ei "Intel" | head -n1 || true',

  /**
   * Parses Intel GPU output from `lspci`.
   *
   * Normalizes names like `"Intel Corporation UHD Graphics 630"` → `"UHD Graphics 630"`
   */
  parse: (stdout: string): Partial<GpuInfo> => {
    const normalized = stdout.toLowerCase();
    if (!normalized.includes("intel")) return { type: "none" };

    // Try common Intel model patterns: `Intel Corporation <Name> Graphics`
    const modelMatch = stdout.match(
      /Intel\s+(?:Corporation\s+)?([A-Za-z0-9]+(?:\s+[A-Za-z0-9]+)*\s+Graphics)/i,
    );
    if (!modelMatch) return { type: "intel" }; // Intel device detected but no known model

    const rawModel = modelMatch[1];
    // Strip trailing `" Graphics"` to unify naming (e.g., UHD Graphics → UHD)
    const model = rawModel.replace(/\s+Graphics$/i, "").trim();

    return { type: "intel", model };
  },
});

/**
 * Builds a command and parser for verifying AMD GPU driver installation.
 *
 * Uses `rocm-smi --version` (ROCm System Management Interface) to confirm
 * the presence of ROCm drivers. Returns only boolean presence status.
 *
 * @returns A {@link CommandWithParser} that validates AMD driver availability
 */
const buildAmdDriverCheck = (): CommandWithParser<{
  driversInstalled?: boolean;
}> => ({
  /**
   * Executes `rocm-smi --version` in a subshell.
   * Exits silently with success (0) if ROCm is installed; otherwise fails.
   *
   * Uses `&& echo 'ok' || true` to always exit 0 while capturing output only on success.
   */
  cmd: "rocm-smi --version && echo 'ok' || true",

  /**
   * Interprets command result as driver presence/absence.
   * If output contains `"ROCm"`, we assume drivers are installed.
   *
   * @returns `{ driversInstalled: true }` if ROCm version string is present, else `false`
   */
  parse: (stdout: string): { driversInstalled?: boolean } => {
    const hasRocm = stdout.toLowerCase().includes("rocm");
    return { driversInstalled: hasRocm };
  },
});

// ───────────────────────────────────────────────────────────────────────
// Main detection engine
// ───────────────────────────────────────────────────────────────────────

/**
 * Executes a sequence of GPU queries to detect system GPU information.
 *
 * Runs commands in order (NVIDIA → AMD → Intel) and accumulates results.
 * Stops early if `nvidia-smi` succeeds, prioritizing NVIDIA over open-source alternatives.
 *
 * @param exec — A shell executor function: `(cmd: string) => Promise<string>`.
 *               Defaults to Node’s `child_process.execFile` wrapper in local usage.
 * @returns A promise resolving to the final {@link GpuInfo} result
 */
export const detectGpu = async (
  exec: (command: string) => Promise<string> = (cmd) =>
    // 🛑 Fallback for tests; do not use untrusted input!
    new Promise((resolve) => {
      console.warn(
        "[warn] Using synchronous fallback `exec`—provide real executor in production!",
      );
      resolve(`[mock: ${cmd}]`);
    }),
): Promise<GpuInfo> => {
  const result: GpuDetectionResult = {
    type: "none",
    model: undefined,
    driversInstalled: undefined,
    count: undefined,
  };

  // 🔍 Try NVIDIA first (highest priority)
  {
    const { cmd, parse } = buildNvidiaCmd();
    try {
      const output = await exec(cmd);
      const parsed = parse(output);

      if (parsed.type === "nvidia") {
        Object.assign(result, parsed); // assign only if successful
      }
    } catch (_) {
      // swallow errors — device may not exist
    }
  }

  // 🔍 If no NVIDIA GPU, try AMD
  if (result.type === "none" || result.type === "intel") {
    const { cmd, parse } = buildAmdCmd();
    try {
      const output = await exec(cmd);
      const parsed = parse(output);

      if (parsed.type === "amd") {
        Object.assign(result, parsed);
        // Attempt to check driver presence *only* for AMD
        const { cmd: driverCheckCmd, parse: driverParse } =
          buildAmdDriverCheck();
        try {
          const driverOutput = await exec(driverCheckCmd);
          const driverInfo = driverParse(driverOutput);
          result.driversInstalled = driverInfo.driversInstalled;
        } catch (_) {}
      }
    } catch (_) {}
  }

  // 🔍 Finally, check Intel
  if (result.type === "none") {
    const { cmd, parse } = buildIntelCmd();
    try {
      const output = await exec(cmd);
      const parsed = parse(output);

      if (parsed.type === "intel") {
        Object.assign(result, parsed);
      }
    } catch (_) {}
  }

  // Ensure result conforms to full `GpuInfo` shape
  return result as GpuInfo;
};
