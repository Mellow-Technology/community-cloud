/**
 * @file
 * Take K3s off a node, and leave what was stored on it alone.
 *
 * K3s ships its own uninstall scripts, and they are the wrong thing to
 * call here. "k3s-uninstall.sh" and "k3s-agent-uninstall.sh" both end
 * with "rm -rf /etc/rancher/k3s /var/lib/rancher/k3s /var/lib/kubelet",
 * which on a server is the cluster's datastore and its certificate
 * authority — the cluster itself, not the software that served it.
 * Removing the software and removing what it was looking after are two
 * decisions, and running them as one means the cautious version of the
 * operation doesn't exist.
 *
 * So this bundle takes the half that is genuinely an uninstall, and
 * the clean bundle has the other half. What it uses of K3s's own
 * scripts is "k3s-killall.sh", which is the part that changes no data:
 * it stops the service, kills every container and shim, and unmounts
 * everything under /run/k3s and /var/lib/kubelet. Unmounting matters
 * more than it sounds — a later clean does "rm -rf" over those paths,
 * and doing that while a volume is still mounted underneath deletes
 * the contents of the volume rather than the directory it was on.
 *
 * What is deliberately left behind:
 *
 * - /etc/rancher/k3s      the configuration, registry credentials and
 *                         the cluster's kubeconfig
 * - /var/lib/rancher/k3s  the server's datastore and CA, the agent's
 *                         certificates, and the container image cache
 * - /var/lib/kubelet      pod state, and the mount points that node
 *                         local volumes were attached at
 * - every LVM volume group, which is where the actual data is: TopoLVM
 *   carves its volumes out of them, so they outlive the cluster and
 *   are the reason a node can be taken apart and put back together
 *
 * All of that is what "clean" removes, once somebody has said so.
 *
 * One thing this can't tidy and doesn't pretend to: Cilium's datapath.
 * The cilium_* interfaces, the veth pairs for pods that were running,
 * and the eBPF programs attached to them belong to Cilium rather than
 * to K3s, and unpicking somebody else's datapath by hand is a good way
 * to leave a machine that half works. They are reported rather than
 * removed, and a reboot clears them.
 */
import {
  CommandOutput,
  CommandPurpose,
  CommandScope,
  CommandSpec,
  CommandTarget,
  OutputType,
} from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { getClusterNodeName } from "./K3s.ts";
import { quoteForShell } from "../../util/shell.ts";
import { field, readRecordsOfKind } from "./output.ts";

/**
 * The systemd units a K3s install can leave, whichever kind it was.
 *
 * Both are looked for rather than the one the configuration implies.
 * A node's "type" says what it was meant to be, and this bundle runs
 * on machines where that turned out to be wrong — a node installed as
 * a server and since rewritten as an agent has a k3s.service on it
 * that nothing in the configuration would go looking for.
 */
const SERVICES = ["k3s", "k3s-agent"];

// Where the install script puts everything by default
const BIN_DIRECTORY = "/usr/local/bin";

// The K3s binary, and the symlinks the install points at it
const BINARY = `${BIN_DIRECTORY}/k3s`;
const SYMLINKS = ["kubectl", "crictl", "ctr"];

// The scripts the install leaves next to the binary
const SCRIPTS = ["k3s-killall.sh", "k3s-uninstall.sh", "k3s-agent-uninstall.sh"];

/**
 * The interfaces Cilium's datapath leaves on a node.
 *
 * Reported here and removed by the clean bundle, which is why it lives
 * in one place rather than two. An "ip -o link show" line names a veth
 * as "lxc1234@if11", where the part after the "@" is the other end of
 * the pair and not part of the name, so it has to come off before the
 * name can be printed or used.
 */
export const CILIUM_LINKS =
  `ip -o link show 2>/dev/null | awk -F': ' '{ name=$2; sub(/@.*/, "", name); if (name ~ /^(cilium_|lxc)/) print name }'`;

/**
 * What K3s keeps, and this bundle doesn't touch.
 *
 * Named here so that the removal, the check that follows it and the
 * clean that eventually removes them are all talking about the same
 * list rather than three lists that drift.
 */
export const DATA_DIRECTORIES = [
  "/etc/rancher/k3s",
  "/var/lib/rancher/k3s",
  "/var/lib/kubelet",
];

/**
 * Whether there is a K3s here to take off.
 *
 * @param context
 * @returns
 */
function isInstalled(context: any): boolean {
  return context?.k3sInstalled === true;
}

/**
 * Look for the units, the binary and the data, and print what's there.
 *
 * Written as one walk of the node rather than a command per question:
 * the answers are wanted together, and a node that is half uninstalled
 * from a run that stopped partway is the ordinary case rather than the
 * strange one.
 */
const findInstallationCommand: string[] = [
  `for service in ${SERVICES.join(" ")}`,
  "do",
  '  [ -f "/etc/systemd/system/$service.service" ] || continue',
  '  printf "service|%s|%s\\n" "$service" "$(systemctl is-active "$service" 2>/dev/null || echo inactive)"',
  "done",
  `[ -x ${BINARY} ] && printf "binary|%s\\n" ${BINARY}`,
  `for directory in ${DATA_DIRECTORIES.join(" ")}`,
  "do",
  '  [ -d "$directory" ] && printf "data|%s\\n" "$directory"',
  "done",
  "exit 0",
];

export const K3sUninstallCommands: CommandSpec[] = [
  /**
   * What is actually on this machine?
   *
   * Nothing here is a failure. A node with no K3s on it is the state
   * this bundle is trying to reach, so finding it already there means
   * the work is done rather than that something went wrong, and the
   * steps after this skip themselves.
   */
  {
    name: "check-k3s-present",
    purpose: CommandPurpose.Inspect,
    description: "Find out what of K3s is on this node",
    command: findInstallationCommand,
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => ({
        services: readRecordsOfKind(output, "service").map((fields) => ({
          name: field(fields, 0),
          active: field(fields, 1) === "active",
        })),
        binary: readRecordsOfKind(output, "binary").length > 0,
        data: readRecordsOfKind(output, "data").map((fields) => field(fields, 0)),
      }),
    ],
    saveToContext: (output: any) => {
      const { services, binary, data } = output.processed;
      const installed = services.length > 0 || binary === true;

      if (!installed) {
        console.log("There's no K3s on this node, so there is nothing to uninstall");
      } else {
        for (const service of services) {
          console.log(`  ${service.name} is ${service.active ? "running" : "installed and not running"}`);
        }

        if (binary === true) {
          console.log(`  the K3s binary is at ${BINARY}`);
        }
      }

      console.log(
        data.length > 0
          ? `  keeping: ${data.join(", ")}`
          : "  no K3s data directories here to keep",
      );

      return {
        k3sInstalled: installed,
        k3sServices: services.map((service: any) => service.name),
      };
    },
  },

  /**
   * Stop it, and stop it coming back.
   *
   * The killall script is preferred over stopping the unit because
   * stopping the unit stops K3s and leaves everything K3s started
   * running: the containerd shims outlive their parent, and the
   * volumes those containers had open stay mounted. A node that
   * "stopped" that way still has pods on it as far as the kernel is
   * concerned.
   *
   * Disabling is what makes it stick. Without it the machine comes
   * back from its next reboot running a K3s that has been uninstalled
   * everywhere except in systemd's view of the world.
   */
  {
    name: "stop-k3s",
    description: "Stop K3s, its containers and its mounts, and disable the service",
    skipWhen: (_config: CloudConfig, context: any) => !isInstalled(context),
    command: [
      `if [ -x ${BIN_DIRECTORY}/k3s-killall.sh ]`,
      "then",
      `  sudo ${BIN_DIRECTORY}/k3s-killall.sh > /dev/null 2>&1 || { echo "k3s-killall.sh failed, so containers or mounts may be left behind. Look at what is still mounted under /var/lib/kubelet before cleaning." >&2; exit 1; }`,
      '  echo "stopped K3s, its containers and its mounts"',
      "else",
      '  echo "No k3s-killall.sh here, so stopping the service is all that can be done. Check for leftover containerd shims and mounts before cleaning."',
      "fi",

      // Whether or not killall ran, the units are what bring it back
      `for service in ${SERVICES.join(" ")}`,
      "do",
      '  [ -f "/etc/systemd/system/$service.service" ] || continue',
      '  sudo systemctl stop "$service" > /dev/null 2>&1 || true',
      '  sudo systemctl disable "$service" > /dev/null 2>&1 || true',
      '  echo "disabled $service"',
      "done",
    ],
    output: OutputType.Raw,
  },

  /**
   * Take the software off, and nothing else.
   *
   * The symlinks are checked before they're removed. "kubectl" in
   * /usr/local/bin is K3s's if it points at the K3s binary and is
   * somebody's own kubectl if it doesn't, and a node being taken out
   * of one cluster is exactly the machine where that distinction is
   * about to matter.
   */
  {
    name: "remove-k3s",
    description: "Remove the K3s binary, its units and its scripts, keeping the data",
    skipWhen: (_config: CloudConfig, context: any) => !isInstalled(context),
    command: [
      `for service in ${SERVICES.join(" ")}`,
      "do",
      '  sudo rm -f "/etc/systemd/system/$service.service" "/etc/systemd/system/$service.service.env"',
      "done",

      // A symlink is only ours if it points at the binary we're removing
      `for link in ${SYMLINKS.join(" ")}`,
      "do",
      `  path="${BIN_DIRECTORY}/$link"`,
      '  [ -L "$path" ] || continue',
      '  case "$(readlink "$path")" in',
      "    *k3s) sudo rm -f \"$path\" ;;",
      "  esac",
      "done",

      `for script in ${SCRIPTS.join(" ")}`,
      "do",
      `  sudo rm -f "${BIN_DIRECTORY}/$script"`,
      "done",

      `sudo rm -f ${BINARY}`,

      "sudo systemctl daemon-reload > /dev/null 2>&1 || true",
      "sudo systemctl reset-failed > /dev/null 2>&1 || true",

      'echo "removed the K3s binary, its units and its scripts"',
    ],
    output: OutputType.Raw,
  },

  /**
   * Say whether the node is actually clear of it.
   *
   * Deliberately a statement about the machine as it is now, with no
   * reference to what the steps before it found. That is what lets it
   * be asked on its own — "is this node out of the cluster" is a
   * reasonable question to put to a machine nobody has touched today —
   * and it is why there is no skipWhen on it: a node that never had
   * K3s passes this, correctly.
   */
  {
    name: "verify-k3s-removed",
    purpose: CommandPurpose.Verify,
    description: "Verify K3s is gone from this node and the data is not",
    command: [
      "left=''",
      `for service in ${SERVICES.join(" ")}`,
      "do",
      '  [ -f "/etc/systemd/system/$service.service" ] && left="$left $service.service"',
      "done",
      `[ -e ${BINARY} ] && left="$left ${BINARY}"`,
      'if command -v pgrep > /dev/null 2>&1 && pgrep -x k3s > /dev/null 2>&1',
      "then",
      "  left=\"$left a running k3s process\"",
      "fi",
      `[ -n "$left" ] && { echo "K3s is still on this node:$left" >&2; exit 1; }`,

      // The other half of the promise: an uninstall that quietly took
      // the data with it would pass every check above
      "kept=''",
      `for directory in ${DATA_DIRECTORIES.join(" ")}`,
      "do",
      '  [ -d "$directory" ] && kept="$kept $directory"',
      "done",
      `[ -n "$kept" ] && echo "K3s is gone. Kept:$kept — run clean to remove those too."`,
      `[ -z "$kept" ] && echo "K3s is gone, and so are its data directories."`,

      // Somebody else's datapath, reported rather than unpicked
      "if command -v ip > /dev/null 2>&1",
      "then",
      `  cilium=$(${CILIUM_LINKS} | tr '\\n' ' ')`,
      `  [ -n "$cilium" ] && echo "Cilium's interfaces are still here and a reboot clears them: $cilium"`,
      "fi",
      "exit 0",
    ],
    output: OutputType.Raw,
  },
];

export const NodeRemovedCommands: CommandSpec[] = [
  /**
   * Tell the cluster the node has gone.
   *
   * Left behind, a Node object for a machine that no longer exists is
   * not harmless. It sits NotReady forever, it counts towards topology
   * spread and anti-affinity decisions, and anything holding volumes
   * scheduled to it waits for a kubelet that is never coming back.
   *
   * This is the last cluster-facing step on purpose. Deleting the Node
   * while its kubelet is still alive achieves nothing — the kubelet
   * simply registers again a few seconds later — so the agent has to
   * be stopped first, which is what the bundle before this does.
   */
  {
    name: "remove-node",
    description: "Remove the node from the cluster",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.EachNode,
    env: buildKubeEnv,
    command: (_config: CloudConfig, context: any) => {
      const readable = getClusterNodeName(context);
      const name = quoteForShell(readable);

      return [
        `kubectl delete node ${name} --ignore-not-found --timeout=60s || { echo "Couldn't remove ${readable} from the cluster." >&2; exit 1; }`,
        `echo "${readable} is no longer a node of this cluster"`,
      ];
    },
    output: OutputType.Raw,
  },

  /**
   * And check the cluster agrees.
   */
  {
    name: "verify-node-removed",
    purpose: CommandPurpose.Verify,
    description: "Verify the cluster no longer has this node",
    runOn: CommandTarget.ControlPlane,
    scope: CommandScope.EachNode,
    env: buildKubeEnv,
    command: (_config: CloudConfig, context: any) => {
      const readable = getClusterNodeName(context);
      const name = quoteForShell(readable);

      return [
        `kubectl get node ${name} > /dev/null 2>&1 || { echo "${readable} is not in the cluster"; exit 0; }`,
        `echo "${readable} is still a node of this cluster. A node that registers again after being deleted has a kubelet still running on it." >&2`,
        "exit 1",
      ];
    },
    output: OutputType.Raw,
  },
];
