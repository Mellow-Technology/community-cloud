/**
 * @file
 * Remove what an uninstall deliberately kept.
 *
 * The split between this and the uninstall bundle is the whole point
 * of both of them. Uninstalling takes away the software: K3s stops,
 * its units and binaries go, and everything it was looking after is
 * left exactly where it was, so the node can be put back into a
 * cluster and find its images, its certificates and its volumes still
 * there. Cleaning is the other decision, made separately and out
 * loud — the configuration, the datastore and, if asked for, the
 * disks.
 *
 * Two bundles rather than one, because the two are not the same size
 * of act. Removing /var/lib/rancher/k3s throws away a container image
 * cache and, on a server, a cluster's datastore; both are painful and
 * both are rebuildable. Removing the volume groups throws away what
 * the applications stored, which is not, so that lives in a bundle of
 * its own that refuses to run until somebody has said the word.
 *
 * Both are teardown bundles, which is why neither appears in a
 * check-up: "K3s isn't running here" is a failure when the doctor asks
 * and the entire point once this has run.
 */
import {
  CommandOutput,
  CommandPurpose,
  CommandSpec,
  OutputType,
} from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { OWNER_TAG, formatSize } from "./LVM.ts";
import { CILIUM_LINKS, DATA_DIRECTORIES } from "./Uninstall.ts";
import { readSections } from "./output.ts";
import { quoteForShell } from "../../util/shell.ts";

/**
 * Everything a K3s install leaves on a node's filesystem.
 *
 * The data directories the uninstall kept, plus the scratch a running
 * cluster accumulates around them. The scratch is listed separately
 * from the data because only the first three are things anybody would
 * hesitate over.
 */
const CLEAN_DIRECTORIES = [
  ...DATA_DIRECTORIES,
  "/var/lib/cni",
  "/etc/cni/net.d",
  "/run/k3s",
  "/run/flannel",
];

/**
 * The units a K3s install leaves, in case the uninstall never ran.
 */
const SERVICES = ["k3s", "k3s-agent"];

/**
 * Whether anything on this node is ours to remove.
 *
 * @param context
 * @returns
 */
function hasVolumeGroups(context: any): boolean {
  return Array.isArray(context?.ownedVolumeGroups) && context.ownedVolumeGroups.length > 0;
}

/**
 * Whether somebody has said, in so many words, to destroy the disks.
 *
 * Checked here as well as by the command that refuses without it, and
 * that is not belt and braces. A run told to keep going carries on
 * past a failed step, so a refusal on its own would be noted and
 * stepped over on the way to doing the thing it refused.
 *
 * @param context
 * @returns
 */
function isApproved(context: any): boolean {
  return context?.storageApproved === true;
}

/**
 * A volume group of ours, and what is in it.
 */
interface OwnedGroup {
  name: string;
  size: number;
  volumes: { name: string; size: number }[];
}

/**
 * Read what LVM reported into the groups that are ours.
 *
 * Ownership comes from the tag rather than from the name. A group
 * called "cc-ssd-vg" is probably one of ours and "probably" is not
 * the standard to apply to something about to be destroyed — the tag
 * is a thing this installer put there, and a name is a thing anybody
 * could have chosen.
 *
 * @param output
 * @returns
 */
function readOwned(output: CommandOutput): {
  groups: OwnedGroup[];
  physicalVolumes: string[];
} {
  const sections = readSections(output.stdout ?? "");
  const groups = new Map<string, OwnedGroup>();

  for (const line of sections["vgs"] ?? []) {
    const [name, size, , tags] = line.split("|").map((field) => field.trim());

    if (name === undefined || name === "" || !readTags(tags).includes(OWNER_TAG)) {
      continue;
    }

    groups.set(name, { name, size: Number(size), volumes: [] });
  }

  for (const line of sections["lvs"] ?? []) {
    const [group, name, size] = line.split("|").map((field) => field.trim());
    const owned = group !== undefined ? groups.get(group) : undefined;

    if (owned === undefined || name === undefined || name === "") {
      continue;
    }

    owned.volumes.push({ name, size: Number(size) });
  }

  const physicalVolumes: string[] = [];

  for (const line of sections["pvs"] ?? []) {
    const [path, group, tags] = line.split("|").map((field) => field.trim());

    if (path === undefined || path === "") {
      continue;
    }

    // Ours if we tagged it, or if it is in a group we tagged. The
    // second case catches a disk added to one of our groups by
    // something other than this installer.
    if (readTags(tags).includes(OWNER_TAG) || (group !== undefined && groups.has(group))) {
      physicalVolumes.push(path);
    }
  }

  return { groups: [...groups.values()], physicalVolumes };
}

/**
 * Read a comma separated tag list, as LVM reports one.
 *
 * @param tags
 * @returns
 */
function readTags(tags: string | undefined): string[] {
  return (tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

export const CleanCommands: CommandSpec[] = [
  /**
   * Refuse to clean a node that is still using what would be removed.
   *
   * Two separate ways this goes wrong, and the second is the one worth
   * the trouble. A running K3s means the directories are in use and
   * the clean is pointless, which is annoying. A volume still mounted
   * under /var/lib/kubelet means "rm -rf /var/lib/kubelet" descends
   * through the mount point and deletes the contents of the volume —
   * which is to say it deletes exactly the data that every other
   * decision here has been arranged to protect.
   */
  {
    name: "check-ready-to-clean",
    purpose: CommandPurpose.Require,
    description: "Check nothing is still using what is about to be removed",
    command: [
      "running=''",
      `for service in ${SERVICES.join(" ")}`,
      "do",
      '  systemctl is-active --quiet "$service" 2>/dev/null && running="$running $service"',
      "done",
      `[ -n "$running" ] && { echo "K3s is still running here ($running). Cleaning removes the directories it is using, so uninstall it first." >&2; exit 1; }`,

      // The dangerous one
      `mounted=$(awk '{ print $2 }' /proc/self/mounts 2>/dev/null | grep -E '^(/var/lib/kubelet|/var/lib/rancher|/run/k3s)' || true)`,
      `[ -n "$mounted" ] && { echo "Something is still mounted under a directory this would remove, and removing a directory a volume is mounted on deletes what is in the volume rather than the directory it was on. Run the uninstall first — it unmounts these — or unmount them by hand." >&2; echo "$mounted" >&2; exit 1; }`,

      'echo "nothing is running and nothing is mounted, so this node is safe to clean"',
      "exit 0",
    ],
    output: OutputType.Raw,
  },

  /**
   * Remove it.
   */
  {
    name: "remove-k3s-state",
    description: "Remove the K3s directories, units and network leftovers",
    command: [
      `for directory in ${CLEAN_DIRECTORIES.join(" ")}`,
      "do",
      '  [ -e "$directory" ] || continue',
      '  sudo rm -rf "$directory" || { echo "Couldn\'t remove $directory" >&2; exit 1; }',
      '  echo "removed $directory"',
      "done",

      // Only if nothing else put anything there
      "sudo rmdir /etc/rancher /var/lib/rancher > /dev/null 2>&1 || true",

      // In case this was run without an uninstall first
      `for service in ${SERVICES.join(" ")}`,
      "do",
      '  sudo rm -f "/etc/systemd/system/$service.service" "/etc/systemd/system/$service.service.env"',
      "done",
      "sudo systemctl daemon-reload > /dev/null 2>&1 || true",

      // Cilium's datapath. The uninstall leaves this alone because a
      // node between clusters may want it; a node being cleaned is one
      // that is not coming back as it was.
      "if command -v ip > /dev/null 2>&1",
      "then",
      `  for link in $(${CILIUM_LINKS})`,
      "  do",
      '    sudo ip link delete "$link" > /dev/null 2>&1 || true',
      "  done",
      "fi",
      "sudo rm -rf /sys/fs/bpf/tc/globals/cilium_* > /dev/null 2>&1 || true",
      'echo "removed what was left of the pod network"',
    ],
    output: OutputType.Raw,
  },

  /**
   * And say whether the node is clear.
   */
  {
    name: "verify-clean",
    purpose: CommandPurpose.Verify,
    description: "Verify nothing of K3s is left on this node's filesystem",
    command: [
      "left=''",
      `for directory in ${CLEAN_DIRECTORIES.join(" ")}`,
      "do",
      '  [ -e "$directory" ] && left="$left $directory"',
      "done",
      `[ -n "$left" ] && { echo "These are still here:$left" >&2; exit 1; }`,
      'echo "nothing of K3s is left on this node"',
      "exit 0",
    ],
    output: OutputType.Raw,
  },
];

export const StorageRemoveCommands: CommandSpec[] = [
  /**
   * Find out what would be destroyed, and say so in full.
   *
   * This runs before anything is approved rather than after, which is
   * the only ordering that helps: a list of volume groups and their
   * sizes is what somebody needs in order to decide, so producing it
   * after the decision would be producing it too late. It is an
   * Inspect, so asking this bundle what it would do changes nothing.
   */
  {
    name: "read-volume-groups",
    purpose: CommandPurpose.Inspect,
    description: "Find the volume groups this installer created, and what is in them",
    command: [
      'command -v vgs > /dev/null 2>&1 || { echo "LVM isn\'t installed on this node, so there are no volume groups to remove."; exit 0; }',
      'echo "== vgs =="',
      `sudo vgs --noheadings -o vg_name,vg_size,lv_count,vg_tags --units b --nosuffix --separator '|' 2>/dev/null || true`,
      'echo "== lvs =="',
      `sudo lvs --noheadings -o vg_name,lv_name,lv_size --units b --nosuffix --separator '|' 2>/dev/null || true`,
      'echo "== pvs =="',
      `sudo pvs --noheadings -o pv_name,vg_name,pv_tags --separator '|' 2>/dev/null || true`,
      "exit 0",
    ],
    output: OutputType.Raw,
    postProcessHooks: [readOwned],
    saveToContext: (output: any) => {
      const { groups, physicalVolumes } = output.processed;

      if (groups.length === 0) {
        console.log(`  no volume group here carries the "${OWNER_TAG}" tag, so there is nothing of ours to remove`);
        return { ownedVolumeGroups: [], ownedPhysicalVolumes: [] };
      }

      for (const group of groups) {
        console.log(
          `  ${group.name.padEnd(18)} ${formatSize(group.size).padStart(7)}  ${group.volumes.length} logical volume${group.volumes.length === 1 ? "" : "s"}`,
        );

        for (const volume of group.volumes) {
          console.log(`      ${volume.name.padEnd(38)} ${formatSize(volume.size).padStart(7)}`);
        }
      }

      if (physicalVolumes.length > 0) {
        console.log(`  on: ${physicalVolumes.join(", ")}`);
      }

      return { ownedVolumeGroups: groups, ownedPhysicalVolumes: physicalVolumes };
    },
  },

  /**
   * Stop unless somebody has said to go ahead.
   *
   * The gate is in the bundle rather than in the runner so that it
   * holds however this is reached. "run-bundle storage-remove" is an
   * ordinary thing to be able to do and it must not be a shorter way
   * to destroy a node's data than the command that asks first.
   */
  {
    name: "check-storage-approved",
    purpose: CommandPurpose.Require,
    description: "Check that destroying this node's volume groups was actually asked for",
    command: (_config: CloudConfig, context: any) => {
      if (!hasVolumeGroups(context)) {
        return 'echo "Nothing of ours on this node, so there is nothing to approve."';
      }

      const groups = context.ownedVolumeGroups as OwnedGroup[];
      const volumes = groups.reduce((count, group) => count + group.volumes.length, 0);

      if (isApproved(context)) {
        return `echo "Approved: removing ${groups.length} volume group${groups.length === 1 ? "" : "s"} and the ${volumes} logical volume${volumes === 1 ? "" : "s"} in them."`;
      }

      const listed = groups
        .map((group) => `  ${group.name} (${formatSize(group.size)}, ${group.volumes.length} logical volume${group.volumes.length === 1 ? "" : "s"})`)
        .join("\n");

      return [
        `echo ${quoteForShell(`This would destroy:\n${listed}`)} >&2`,
        `echo "Everything a pod stored on this node goes with them, and nothing here can put it back. Re-run with --yes if that is what you want." >&2`,
        "exit 1",
      ];
    },
    output: OutputType.Raw,
  },

  /**
   * Destroy them.
   */
  {
    name: "remove-volume-groups",
    description: "Remove the volume groups and release the disks they were on",
    skipWhen: (_config: CloudConfig, context: any) =>
      !hasVolumeGroups(context) || !isApproved(context),
    command: (_config: CloudConfig, context: any) => {
      const groups = (context.ownedVolumeGroups as OwnedGroup[]).map((group) => group.name);
      const physicalVolumes = (context.ownedPhysicalVolumes as string[]) ?? [];

      return [
        // The group goes first: a physical volume can't be removed
        // while it still belongs to one
        `for group in ${groups.map(quoteForShell).join(" ")}`,
        "do",
        '  sudo vgremove -f "$group" > /dev/null || { echo "Couldn\'t remove the volume group $group" >&2; exit 1; }',
        '  echo "removed the volume group $group"',
        "done",

        ...(physicalVolumes.length > 0
          ? [
              `for volume in ${physicalVolumes.map(quoteForShell).join(" ")}`,
              "do",
              '  [ -e "$volume" ] || continue',
              '  sudo pvremove -ff -y "$volume" > /dev/null 2>&1 || { echo "Couldn\'t release $volume, which is now a disk in no volume group." >&2; continue; }',
              '  echo "released $volume"',
              "done",
            ]
          : []),
        "exit 0",
      ];
    },
    output: OutputType.Raw,
  },

  /**
   * And check none of ours are left.
   */
  {
    name: "verify-volume-groups-removed",
    purpose: CommandPurpose.Verify,
    description: "Verify no volume group on this node is still ours",
    command: [
      'command -v vgs > /dev/null 2>&1 || { echo "LVM isn\'t installed here, so there is nothing of ours."; exit 0; }',
      `left=$(sudo vgs --noheadings -o vg_name @${OWNER_TAG} 2>/dev/null | tr -d ' ' | grep . || true)`,
      `[ -n "$left" ] && { echo "These volume groups are still here: $(echo "$left" | tr '\\n' ' ')" >&2; exit 1; }`,
      `echo "no volume group on this node carries the \\"${OWNER_TAG}\\" tag"`,
      "exit 0",
    ],
    output: OutputType.Raw,
  },
];
