/**
 * @file
 * Set kernel networking properties on a node.
 *
 * The main reason this exists is TCP congestion control. Linux still
 * defaults to CUBIC, which backs off hard on any packet loss. Community
 * Cloud nodes routinely talk to each other across sites over links that
 * lose the odd packet for reasons that have nothing to do with
 * congestion, and CUBIC reads that as a reason to slow down. BBR paces
 * itself on measured bandwidth and round trip time instead, so it holds
 * throughput up over exactly those links.
 *
 * BBR wants a fair queueing qdisc underneath it to pace packets, hence
 * setting net.core.default_qdisc alongside it.
 *
 * Requires:
 * - sudo
 * - a kernel offering the configured algorithm, as a module or built in
 */
import { CommandSpec, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { quoteForShell } from "../../util/shell.ts";

// Where the settings are persisted. Both of these are drop-in
// directories, so we own one file each and can rewrite it on every
// run. Appending to /etc/sysctl.conf and modules.conf the way this
// is usually described leaves a duplicate line behind every time
// the bundle is run.
const SYSCTL_FILE = "/etc/sysctl.d/99-community-cloud-network.conf";
const MODULES_FILE = "/etc/modules-load.d/community-cloud.conf";

// The qdisc setting, and where the kernel exposes it. Not every
// kernel has it, so we check for the file before writing anything.
const QDISC_SYSCTL_KEY = "net.core.default_qdisc";
const QDISC_SYSCTL_PATH = "/proc/sys/net/core/default_qdisc";

// What we fall back to when a configuration doesn't say
const DEFAULT_CONGESTION_CONTROL = "bbr";
const DEFAULT_QDISC = "fq";

// These values are interpolated into shell commands that run as root,
// so we only accept the shape a kernel module or qdisc name actually
// takes rather than trusting the configuration file
const SAFE_NAME = /^[a-z0-9_-]+$/;

/**
 * The networking section of a Community Cloud configuration.
 *
 * - congestionControl: the TCP congestion control algorithm, e.g. "bbr"
 * - qdisc: the default queueing discipline, e.g. "fq"
 * - congestionModule: the kernel module providing the algorithm.
 *   Derived from the algorithm name when it isn't set.
 */
interface NetworkConfig {
  congestionControl?: string;
  qdisc?: string;
  congestionModule?: string;
}

/**
 * Read the networking section of the configuration.
 *
 * @param config
 * @returns
 */
function getNetworkConfig(config: CloudConfig): NetworkConfig {
  const { network } = config.getConfig();
  return network !== undefined && network !== null ? network : {};
}

/**
 * The configured congestion control algorithm.
 *
 * @param config
 * @returns
 */
function getCongestionControl(config: CloudConfig): string {
  const { congestionControl } = getNetworkConfig(config);
  return checkName(
    congestionControl !== undefined ? congestionControl : DEFAULT_CONGESTION_CONTROL,
    "network.congestionControl",
  );
}

/**
 * The configured queueing discipline.
 *
 * @param config
 * @returns
 */
function getQdisc(config: CloudConfig): string {
  const { qdisc } = getNetworkConfig(config);
  return checkName(qdisc !== undefined ? qdisc : DEFAULT_QDISC, "network.qdisc");
}

/**
 * The kernel module which provides the congestion control algorithm.
 * The kernel names these consistently, so unless a configuration says
 * otherwise we can work it out from the algorithm.
 *
 * @param config
 * @returns
 */
function getCongestionModule(config: CloudConfig): string {
  const { congestionModule } = getNetworkConfig(config);
  if (congestionModule !== undefined) {
    return checkName(congestionModule, "network.congestionModule");
  }

  return `tcp_${getCongestionControl(config)}`;
}

/**
 * Make sure a configured value is a plain kernel style name before it
 * goes anywhere near a command running as root.
 *
 * @param value
 * @param settingName
 * @returns
 */
function checkName(value: string, settingName: string): string {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    throw new Error(
      `"${value}" isn't a valid value for ${settingName}. Expected a name made up of lowercase letters, digits, dashes and underscores.`,
    );
  }

  return value;
}

/**
 * Build a command which writes a file as root.
 *
 * The sudo flag on a command only prefixes the command itself, which
 * is no help here: the privileged part is the write on the far end of
 * a pipe, so a leading sudo would leave the redirect running as the
 * connecting user. These commands carry their own sudo on the tee
 * instead, which is also why they don't set the flag.
 *
 * @param filePath
 * @param lines
 * @returns
 */
function writeFileAsRoot(filePath: string, lines: string[]): string {
  const contents = lines.map(quoteForShell).join(" ");
  return `printf '%s\\n' ${contents} | sudo tee ${filePath} > /dev/null`;
}

export const NetworkingCommands: CommandSpec[] = [
  /**
   * Load the module for this boot. A kernel with the algorithm built
   * in has nothing to load, and modprobe says so, so we let this one
   * pass either way and leave the real check to the next command.
   */
  {
    name: "load-congestion-module",
    description: "Load the TCP congestion control kernel module",
    sudo: true,
    command: (config: CloudConfig) =>
      `modprobe ${getCongestionModule(config)} || true`,
    output: OutputType.Raw,
  },

  /**
   * Confirm the kernel can do what we're about to ask of it, before we
   * write anything. Setting an algorithm the kernel doesn't have
   * leaves the node quietly on whatever it was using before, and
   * writing a sysctl key the kernel doesn't expose makes every later
   * "sysctl --system" on that node fail, including for settings that
   * have nothing to do with us.
   */
  {
    name: "check-network-support",
    description: "Check the kernel supports the configured congestion control and qdisc",
    command: (config: CloudConfig) => {
      const algorithm = getCongestionControl(config);
      return [
        "available=$(sysctl -n net.ipv4.tcp_available_congestion_control)",
        'echo "available congestion control: $available"',
        // The algorithms come back space separated, so split them onto
        // their own lines and match one whole
        `echo "$available" | tr ' ' '\\n' | grep -qx ${quoteForShell(algorithm)} || { echo "This kernel doesn't offer ${algorithm} congestion control. Available: $available" >&2; exit 1; }`,
        `[ -e "${QDISC_SYSCTL_PATH}" ] || { echo "This kernel doesn't expose ${QDISC_SYSCTL_KEY}, so the default qdisc can't be set" >&2; exit 1; }`,
      ].join("; ");
    },
    output: OutputType.Raw,
  },

  /**
   * Load the module on every boot from here on.
   */
  {
    name: "persist-congestion-module",
    description: "Load the congestion control module on boot",
    command: (config: CloudConfig) =>
      writeFileAsRoot(MODULES_FILE, [
        "# Managed by Community Cloud",
        getCongestionModule(config),
      ]),
    output: OutputType.Raw,
  },

  /**
   * Persist the settings themselves.
   */
  {
    name: "write-sysctl-config",
    description: "Write the congestion control and qdisc sysctl settings",
    command: (config: CloudConfig) =>
      writeFileAsRoot(SYSCTL_FILE, [
        "# Managed by Community Cloud",
        `${QDISC_SYSCTL_KEY} = ${getQdisc(config)}`,
        `net.ipv4.tcp_congestion_control = ${getCongestionControl(config)}`,
      ]),
    output: OutputType.Raw,
  },

  /**
   * Apply what we just wrote so the node doesn't need a reboot.
   */
  {
    name: "apply-sysctl",
    description: "Apply the sysctl settings",
    sudo: true,
    command: "sysctl --system",
    output: OutputType.Raw,
  },

  /**
   * Read the settings back. sysctl reports success even when a value
   * doesn't take, so the only way to know the node ended up where we
   * wanted is to ask it.
   */
  {
    name: "verify-network-settings",
    description: "Verify the node is using the configured congestion control and qdisc",
    command: (config: CloudConfig) => {
      const algorithm = getCongestionControl(config);
      const qdisc = getQdisc(config);

      return [
        "current_congestion=$(sysctl -n net.ipv4.tcp_congestion_control)",
        `current_qdisc=$(sysctl -n ${QDISC_SYSCTL_KEY})`,
        'echo "congestion control: $current_congestion"',
        'echo "default qdisc: $current_qdisc"',
        `[ "$current_congestion" = "${algorithm}" ] || { echo "Expected congestion control ${algorithm}, got $current_congestion" >&2; exit 1; }`,
        `[ "$current_qdisc" = "${qdisc}" ] || { echo "Expected qdisc ${qdisc}, got $current_qdisc" >&2; exit 1; }`,
      ].join("; ");
    },
    output: OutputType.Raw,
  },
];
