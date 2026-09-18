/**
 * @file
 * Whether a node can be installed on at all.
 *
 * This is deliberately not "run every Require command". Most of those
 * ask for something an earlier step provides — the gateway wants
 * Cilium, the charts want Helm, the labels want a reachable API
 * server — and on a machine nothing has been installed on yet, every
 * one of them fails correctly and tells you nothing. A preflight that
 * reports fifteen problems which the install would have fixed is worse
 * than no preflight, because the real one is in there somewhere.
 *
 * So what's here is the other kind: the things no install step can do
 * anything about, where a person has to go and change something. A
 * kernel without the congestion control we're about to set. A node
 * that can't sudo. A machine that can't reach get.k3s.io. Those are
 * worth finding before a cluster is half built rather than after.
 *
 * Everything here is Require, changes nothing, and runs on the node
 * being asked about.
 *
 * Requires:
 * - an SSH connection, which is itself the first thing being checked
 */
import { CommandOutput, CommandPurpose, CommandSpec, OutputType } from "./Command.ts";
import { field, readRecordOfKind, readRecordsOfKind } from "./output.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { quoteForShell } from "../../util/shell.ts";
import { K3SInstallationType } from "../../util/types.ts";
import { checkNetworkSupportCommand } from "./Networking.ts";
import { checkGatewayInterfacesCommand } from "./GatewayNodes.ts";

// What the bundles here actually shell out to. Missing any of these
// is a failed install several minutes in rather than a sentence now.
const REQUIRED_TOOLS = ["curl", "tar", "sha256sum", "ip", "systemctl", "sudo", "mktemp", "install"];

// K3s ships binaries for these
const SUPPORTED_ARCHITECTURES = ["x86_64", "aarch64", "arm64", "amd64"];

// The bundles install packages with apt, so a node has to be in that
// family. Everything else works, but the base packages and dnclient
// installs won't.
const SUPPORTED_OS = ["debian", "ubuntu", "raspbian", "linuxmint", "pop"];

// Where K3s keeps everything. A node that fills this up stops being a
// node, and container images are not small.
const DATA_DIRECTORY = "/var/lib";
const MINIMUM_FREE_GB = 10;

// What the install downloads from, and so what a node has to reach
const OUTBOUND_HOSTS = ["get.k3s.io", "github.com", "raw.githubusercontent.com"];

// How far apart clocks can drift before TLS starts refusing things
const MAXIMUM_CLOCK_SKEW_SECONDS = 60;

// The ports K3s wants for itself
const SERVER_PORTS = [6443, 10250, 2379, 2380];
const AGENT_PORTS = [10250];

/**
 * The ports this node needs free, which depends on what it will be.
 *
 * @param context
 * @returns
 */
function getRequiredPorts(context: any): number[] {
  const node = context.node !== undefined && context.node !== null ? context.node : {};
  return node.type === K3SInstallationType.Server ? SERVER_PORTS : AGENT_PORTS;
}

export const PreflightCommands: CommandSpec[] = [
  /**
   * Can we do anything as root here?
   *
   * Every bundle in here uses sudo somewhere, and a node whose sudo
   * wants a password hangs rather than fails: the command sits waiting
   * for a prompt nobody is going to answer.
   */
  {
    name: "check-node-access",
    description: "Check we can reach this node and act as root on it",
    purpose: CommandPurpose.Require,
    command: [
      `printf "user|%s\\n" "$(id -un)"`,
      // -n so it fails rather than waits when a password is wanted
      `printf "sudo|%s\\n" "$(sudo -n true 2>/dev/null && echo yes || echo no)"`,
      `printf "home|%s\\n" "$(cd ~ && pwd)"`,
    ],
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => ({
        user: field(readRecordOfKind(output, "user") ?? [], 0),
        sudo: field(readRecordOfKind(output, "sudo") ?? [], 0) === "yes",
      }),
    ],
    saveToContext: (output: any) => {
      const { user, sudo } = output.processed;

      if (!sudo) {
        throw new Error(
          `Connected as "${user}", but sudo asks for a password. Every bundle needs root somewhere, and a command waiting on a prompt hangs rather than fails. Give this user passwordless sudo, or connect as root.`,
        );
      }

      console.log(`  Connected as ${user}, with sudo`);
      return { preflightUser: user };
    },
  },

  /**
   * Is this a machine the bundles know how to work with?
   */
  {
    name: "check-operating-system",
    description: "Check the OS and architecture are ones this supports",
    purpose: CommandPurpose.Require,
    command: [
      `. /etc/os-release 2>/dev/null || true`,
      `printf "os|%s|%s|%s\\n" "\${ID:-unknown}" "\${VERSION_ID:-unknown}" "\${ID_LIKE:-}"`,
      `printf "arch|%s\\n" "$(uname -m)"`,
      `printf "kernel|%s\\n" "$(uname -r)"`,
    ],
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => {
        const os = readRecordOfKind(output, "os") ?? [];
        return {
          id: field(os, 0),
          version: field(os, 1),
          like: field(os, 2),
          arch: field(readRecordOfKind(output, "arch") ?? [], 0),
          kernel: field(readRecordOfKind(output, "kernel") ?? [], 0),
        };
      },
    ],
    saveToContext: (output: any) => {
      const { id, version, like, arch, kernel } = output.processed;

      if (!SUPPORTED_ARCHITECTURES.includes(arch)) {
        throw new Error(
          `This node is ${arch}, and K3s doesn't publish a build for it. Supported: ${SUPPORTED_ARCHITECTURES.join(", ")}.`,
        );
      }

      // The family counts as much as the name: anything Debian-like
      // has apt, which is all the bundles actually need
      const family = `${id} ${like}`.toLowerCase();
      const known = SUPPORTED_OS.some((name) => family.includes(name));

      console.log(`  ${id} ${version} on ${arch}, kernel ${kernel}`);

      if (!known) {
        console.log(
          `  ⚠️  "${id}" isn't a Debian family distribution, so the bundles that install packages with apt won't work here. Everything else will.`,
        );
      }

      return { preflightOs: id, preflightArch: arch };
    },
  },

  /**
   * Are the things the commands shell out to actually here?
   */
  {
    name: "check-required-tools",
    description: "Check the tools the bundles use are installed",
    purpose: CommandPurpose.Require,
    command: [
      `for tool in ${REQUIRED_TOOLS.join(" ")}`,
      "do",
      '  printf "tool|%s|%s\\n" "$tool" "$(command -v "$tool" > /dev/null 2>&1 && echo yes || echo no)"',
      "done",
    ],
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) =>
        readRecordsOfKind(output, "tool")
          .filter((fields) => field(fields, 1) !== "yes")
          .map((fields) => field(fields, 0)),
    ],
    saveToContext: (output: any) => {
      const missing: string[] = output.processed;

      if (missing.length > 0) {
        throw new Error(
          `This node is missing ${missing.join(", ")}. The install shells out to all of them, so it would fail partway rather than at the start.`,
        );
      }

      console.log(`  All ${REQUIRED_TOOLS.length} required tools present`);
      return {};
    },
  },

  /**
   * Can the kernel run a cluster?
   *
   * K3s needs cgroup v2 for resource limits to mean anything, and
   * Cilium's datapath needs the BPF filesystem. Neither is something
   * an install step can put right.
   */
  {
    name: "check-kernel-features",
    description: "Check the kernel can run K3s and Cilium",
    purpose: CommandPurpose.Require,
    command: [
      `printf "cgroup2|%s\\n" "$(test -f /sys/fs/cgroup/cgroup.controllers && echo yes || echo no)"`,
      `printf "bpf|%s\\n" "$(test -d /sys/fs/bpf && echo yes || echo no)"`,
      `printf "forwarding|%s\\n" "$(sysctl -n net.ipv4.ip_forward 2>/dev/null || echo unknown)"`,
      `printf "swap|%s\\n" "$(swapon --show=NAME --noheadings 2>/dev/null | head -1)"`,
    ],
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => ({
        cgroup2: field(readRecordOfKind(output, "cgroup2") ?? [], 0) === "yes",
        bpf: field(readRecordOfKind(output, "bpf") ?? [], 0) === "yes",
        forwarding: field(readRecordOfKind(output, "forwarding") ?? [], 0),
        swap: field(readRecordOfKind(output, "swap") ?? [], 0),
      }),
    ],
    saveToContext: (output: any) => {
      const { cgroup2, bpf, forwarding, swap } = output.processed;
      const problems: string[] = [];

      if (!cgroup2) {
        problems.push(
          "cgroup v2 isn't mounted, so K3s can't enforce the resource limits workloads are scheduled against",
        );
      }

      if (!bpf) {
        problems.push("the BPF filesystem isn't mounted, and Cilium's datapath needs it");
      }

      if (problems.length > 0) {
        throw new Error(`${problems.join(". ")}.`);
      }

      console.log("  cgroup v2 and BPF filesystem both present");

      // Neither of these stops an install, and both are worth knowing
      if (forwarding !== "1") {
        console.log(
          "  ⚠️  IP forwarding is off. K3s turns it on itself, so this is only a note.",
        );
      }

      if (swap !== "") {
        console.log(
          `  ⚠️  Swap is on (${swap}). K3s tolerates it, but a node that starts swapping schedules badly.`,
        );
      }

      return {};
    },
  },

  /**
   * Is anything already sitting on the ports K3s wants?
   *
   * A port in use is the sort of thing that shows up as a service
   * which starts, fails, and restarts forever.
   */
  {
    name: "check-ports-free",
    description: "Check nothing else is using the ports K3s needs",
    purpose: CommandPurpose.Require,
    command: (_config: CloudConfig, context: any) => {
      const ports = getRequiredPorts(context);

      return [
        // ss on anything modern, netstat as the fallback
        'lister() { if command -v ss > /dev/null 2>&1; then ss -lntH 2>/dev/null; else netstat -lnt 2>/dev/null; fi; }',
        "listening=$(lister)",
        `for port in ${ports.join(" ")}`,
        "do",
        '  printf "port|%s|%s\\n" "$port" "$(printf \'%s\\n\' "$listening" | grep -cE "[:.]$port[[:space:]]")"',
        "done",
      ];
    },
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) =>
        readRecordsOfKind(output, "port")
          .filter((fields) => field(fields, 1) !== "0")
          .map((fields) => field(fields, 0)),
    ],
    saveToContext: (output: any, context: any) => {
      const taken: string[] = output.processed;
      const ports = getRequiredPorts(context);

      // K3s itself is the most likely thing already listening, and on
      // a node being reinstalled that's expected rather than wrong
      if (taken.length > 0) {
        console.log(
          `  ⚠️  Already listening on ${taken.join(", ")}. If that's a previous K3s, the install will take them over; if it's something else, it won't start.`,
        );
        return { preflightPortsInUse: taken };
      }

      console.log(`  Ports free: ${ports.join(", ")}`);
      return { preflightPortsInUse: [] };
    },
  },

  /**
   * Can the node get to what it has to download?
   *
   * A node behind a proxy or a firewall that only lets some things
   * out fails several minutes into an install, with an error about
   * whichever download happened to be first.
   */
  {
    name: "check-outbound-access",
    description: "Check the node can reach what the install downloads from",
    purpose: CommandPurpose.Require,
    command: (config: CloudConfig) => {
      const registries = Object.keys(config.getConfig().registries ?? {});
      const hosts = [...OUTBOUND_HOSTS, ...registries].map(quoteForShell).join(" ");

      return [
        `for host in ${hosts}`,
        "do",
        // A name that doesn't resolve and a host that won't answer are
        // different problems, so they're reported apart
        '  resolved=$(getent hosts "$host" > /dev/null 2>&1 && echo yes || echo no)',
        '  reachable=no',
        '  if [ "$resolved" = "yes" ]',
        "  then",
        '    curl -sS --max-time 10 -o /dev/null "https://$host" > /dev/null 2>&1 && reachable=yes',
        "  fi",
        '  printf "host|%s|%s|%s\\n" "$host" "$resolved" "$reachable"',
        "done",
      ];
    },
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) =>
        readRecordsOfKind(output, "host").map((fields) => ({
          host: field(fields, 0),
          resolved: field(fields, 1) === "yes",
          reachable: field(fields, 2) === "yes",
        })),
    ],
    saveToContext: (output: any) => {
      const results: { host: string; resolved: boolean; reachable: boolean }[] = output.processed;

      const unresolved = results.filter((entry) => !entry.resolved).map((entry) => entry.host);
      const unreachable = results
        .filter((entry) => entry.resolved && !entry.reachable)
        .map((entry) => entry.host);

      if (unresolved.length > 0) {
        throw new Error(
          `This node can't resolve ${unresolved.join(", ")}. Check its DNS before installing anything.`,
        );
      }

      if (unreachable.length > 0) {
        throw new Error(
          `This node resolves but can't reach ${unreachable.join(", ")}. The install downloads from all of these, so it would fail partway.`,
        );
      }

      console.log(`  Can reach all ${results.length} hosts the install needs`);
      return {};
    },
  },

  /**
   * Is the clock right?
   *
   * Everything in a cluster is held together by certificates, and a
   * node whose clock is far enough out rejects every one of them. It
   * shows up as TLS errors that look like a misconfiguration.
   */
  {
    name: "check-clock",
    description: "Check the node's clock agrees with this machine's",
    purpose: CommandPurpose.Require,
    command: 'printf "epoch|%s\\n" "$(date -u +%s)"',
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => {
        const remote = Number(field(readRecordOfKind(output, "epoch") ?? [], 0));
        const here = Math.floor(Date.now() / 1000);

        return { remote, skew: Number.isFinite(remote) ? Math.abs(remote - here) : undefined };
      },
    ],
    saveToContext: (output: any) => {
      const { skew } = output.processed;

      if (skew === undefined) {
        console.log("  ⚠️  Couldn't read the node's clock");
        return {};
      }

      if (skew > MAXIMUM_CLOCK_SKEW_SECONDS) {
        throw new Error(
          `This node's clock is ${skew} seconds away from this machine's. Certificates are how a cluster holds together, and a clock this far out rejects them. Set up time synchronisation first.`,
        );
      }

      console.log(`  Clock is within ${skew}s of this machine`);
      return {};
    },
  },

  /**
   * Is there room for a cluster?
   */
  {
    name: "check-disk-space",
    description: "Check there's room for images and cluster data",
    purpose: CommandPurpose.Require,
    command: `printf "free|%s\\n" "$(df -Pk ${DATA_DIRECTORY} | awk 'NR==2 {print $4}')"`,
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => {
        const kilobytes = Number(field(readRecordOfKind(output, "free") ?? [], 0));
        return Number.isFinite(kilobytes) ? kilobytes / 1024 / 1024 : undefined;
      },
    ],
    saveToContext: (output: any) => {
      const freeGb: number | undefined = output.processed;

      if (freeGb === undefined) {
        console.log(`  ⚠️  Couldn't read the free space on ${DATA_DIRECTORY}`);
        return {};
      }

      if (freeGb < MINIMUM_FREE_GB) {
        throw new Error(
          `${DATA_DIRECTORY} has ${freeGb.toFixed(1)}GB free, and a cluster wants at least ${MINIMUM_FREE_GB}GB for images and its own data.`,
        );
      }

      console.log(`  ${freeGb.toFixed(1)}GB free on ${DATA_DIRECTORY}`);
      return {};
    },
  },

  // Two that already existed and are about the machine rather than
  // about a step that hasn't run yet, so they belong here too
  checkNetworkSupportCommand,
  checkGatewayInterfacesCommand,
];
