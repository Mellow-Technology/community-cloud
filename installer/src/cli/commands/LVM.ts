/**
 * @file
 * Give TopoLVM something to carve volumes out of.
 *
 * TopoLVM hands a pod a logical volume from a volume group on the node
 * it's scheduled to. It doesn't make the volume groups — something has
 * to have put them there first, with the names its device classes
 * expect. That's this.
 *
 * The device classes exist so that storage performance is predictable
 * rather than a lottery. A database asking for fast storage should not
 * land on a spinning disk because that's what had room. So the disks
 * on a node are sorted by what they actually are:
 *
 *   nvme                → ssd        → cc-ssd-vg
 *   other non-rotating  → ssd-sata   → cc-ssd-sata-vg
 *   rotating            → hdd        → cc-hdd-vg
 *
 * The volume group names aren't written here. They're read from the
 * TopoLVM values file that ships with the installer, because the two
 * have to agree exactly and a name in two places is a name that will
 * one day be in two different places.
 *
 * ── On destroying things ──
 *
 * pvcreate throws away whatever was on a disk. This is the only
 * command in the installer that can lose data that was never ours, so
 * it is deliberately timid: a disk has to be demonstrably unused
 * before it is touched. No partitions, no filesystem signature, not
 * mounted, nothing holding it, not removable, not read-only. Anything
 * else is reported and left alone, with the reason, and a person can
 * go and wipe it themselves if they meant it.
 *
 * Requires:
 * - lvm2, which is not installed by default on a minimal Debian
 * - util-linux, for lsblk
 * - sudo
 */
import { parse } from "yaml";

import {
  CommandOutput,
  CommandPurpose,
  CommandSpec,
  OutputType,
} from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { quoteForShell } from "../../util/shell.ts";
import { renderInstallerFile } from "../../util/template.ts";

// The values file that says which volume groups TopoLVM will look for
const TOPOLVM_VALUES_FILE = "embed://storage/TopoLVM/TopoLVM.values.yaml";

/**
 * A block device as the node describes it.
 */
export interface BlockDevice {
  name: string;
  kname: string;
  type: string;
  size: number;
  rotational: boolean;
  transport: string;
  model: string;
  readOnly: boolean;
  removable: boolean;
  mountpoint: string;
  fstype: string;
  parent: string;
}

/**
 * What we can do with a disk.
 *
 * "Claimed" is the one that matters on a second run. A disk we made
 * into a physical volume looks exactly like a disk somebody else made
 * into one — both say "LVM2_member" — and refusing to touch it is
 * right either way. But a node where every disk is already ours is
 * set up, not unusable, and saying so is the difference between a
 * re-run reporting success and reporting that there's nothing here.
 */
export enum DiskState {
  Free = "free",
  Claimed = "claimed",
  Unusable = "unusable",
}

/**
 * The tag every object we made carries.
 *
 * LVM lets a tag be attached to a physical volume, a volume group or
 * a logical volume, and then used anywhere a name would be: "vgs
 * @community-cloud" lists ours and nothing else. That's worth having
 * for its own sake, and it settles a question the names couldn't.
 *
 * A physical volume looks the same whoever made it. Working out
 * whether one was ours by looking at which volume group it's in means
 * trusting that a group called "cc-ssd-vg" is the one we created,
 * which is an assumption about a name in a namespace we don't own. A
 * tag on the volume itself is the thing actually being asked about.
 */
export const OWNER_TAG = "community-cloud";

/**
 * The tag saying which device class an object serves.
 *
 * So that a disk can say what it was set up as, rather than having it
 * inferred all over again from hardware that may since have been
 * reclassified by a configuration change.
 *
 * @param storageClass
 * @returns
 */
export function classTag(storageClass: string): string {
  return `cc-class-${storageClass}`;
}

/**
 * The class an object's tags say it serves.
 *
 * @param tags
 * @returns
 */
export function readClassTag(tags: string[]): StorageClass | undefined {
  for (const storageClass of Object.values(StorageClass)) {
    if (tags.includes(classTag(storageClass))) {
      return storageClass;
    }
  }

  return undefined;
}

// Smaller than this and it isn't worth the trouble
const MINIMUM_DISK_BYTES = 1024 * 1024 * 1024;

// Device names that are never storage for this purpose
const NEVER = /^(ram|zram|sr|fd|md|dm-)/;

/**
 * The performance classes, and what hardware lands in each.
 *
 * The names match the device classes in the TopoLVM values, which is
 * what ties a pod asking for "ssd" to a disk that really is one.
 */
export enum StorageClass {
  Ssd = "ssd",
  SsdSata = "ssd-sata",
  SsdCache = "ssd-cache",
  Hdd = "hdd",
}

/**
 * A disk, once we've decided what it is and whether we can have it.
 */
export interface CandidateDisk {
  path: string;
  name: string;
  size: number;
  storageClass: StorageClass;
  state: DiskState;
  device: BlockDevice;

  // Which of our volume groups it's already in, when it's claimed
  volumeGroup?: string;

  // Why it can't be used, when it can't
  unusableBecause?: string;

  // Something worth saying about how it's being treated
  note?: string;
}

/**
 * The storage section of a Community Cloud configuration.
 *
 * - disks: use only these, by path. Without it every disk that is
 *   demonstrably unused is used. A disk named here still has to be
 *   unused: this says which disks to consider, not which to wipe.
 * - diskClasses: put a disk in a class other than the one its
 *   hardware suggests, by path
 * - minimumSizeGb: ignore disks smaller than this
 */
interface StorageConfig {
  disks?: string[];
  diskClasses?: Record<string, StorageClass>;
  minimumSizeGb?: number;
}

/**
 * Read the storage settings, preferring the node's own.
 *
 * Nodes differ in what disks they have far more than they differ in
 * anything else, so a per-node section is the useful place for this
 * and the cluster-wide one is the fallback.
 *
 * @param config
 * @param context
 * @returns
 */
function getStorageConfig(config: CloudConfig, context: any): StorageConfig {
  const node = context?.node !== undefined && context.node !== null ? context.node : {};
  const nodeStorage = node.storage;

  if (nodeStorage !== undefined && nodeStorage !== null) {
    return nodeStorage;
  }

  const { storage } = config.getConfig();
  return storage !== undefined && storage !== null ? storage : {};
}

/**
 * The volume group each device class wants, from the TopoLVM values.
 *
 * Read rather than written down, so that adding a device class over
 * there is all it takes. A class named in the values with no volume
 * group is a mistake worth catching here, where it can be explained,
 * rather than at the point TopoLVM quietly fails to find it.
 *
 * @param config
 * @returns
 */
export function getVolumeGroups(config: CloudConfig): Record<string, string> {
  let values: any;

  try {
    values = parse(renderInstallerFile(config, TOPOLVM_VALUES_FILE));
  } catch (error: any) {
    throw new Error(
      `Couldn't read the TopoLVM values from ${TOPOLVM_VALUES_FILE}, so there's no way to know which volume groups to create: ${error.message}`,
    );
  }

  const classes = values?.lvmd?.deviceClasses;
  if (!Array.isArray(classes) || classes.length === 0) {
    throw new Error(
      `${TOPOLVM_VALUES_FILE} lists no device classes under "lvmd.deviceClasses", so there's nothing to create.`,
    );
  }

  const groups: Record<string, string> = {};

  for (const entry of classes) {
    const group = entry["volume-group"];

    if (typeof entry.name !== "string" || typeof group !== "string" || group === "") {
      throw new Error(
        `The device class ${JSON.stringify(entry.name ?? entry)} in ${TOPOLVM_VALUES_FILE} has no volume group, so nothing can be created for it.`,
      );
    }

    groups[entry.name] = group;
  }

  return groups;
}

/**
 * Parse one line of "lsblk -P", which is key="value" pairs.
 *
 * @param line
 * @returns
 */
function parseDeviceLine(line: string): BlockDevice | undefined {
  const fields: Record<string, string> = {};

  for (const match of line.matchAll(/([A-Z]+)="([^"]*)"/g)) {
    fields[match[1] as string] = match[2] as string;
  }

  if (fields["KNAME"] === undefined) {
    return undefined;
  }

  return {
    name: fields["NAME"] ?? "",
    kname: fields["KNAME"] ?? "",
    type: fields["TYPE"] ?? "",
    size: Number(fields["SIZE"] ?? 0),
    rotational: fields["ROTA"] === "1",
    transport: fields["TRAN"] ?? "",
    model: (fields["MODEL"] ?? "").trim(),
    readOnly: fields["RO"] === "1",
    removable: fields["RM"] === "1",
    mountpoint: fields["MOUNTPOINT"] ?? "",
    fstype: fields["FSTYPE"] ?? "",
    parent: fields["PKNAME"] ?? "",
  };
}

/**
 * Which class a disk's hardware puts it in.
 *
 * A rotating disk is a rotating disk. Everything else is solid state,
 * and the only distinction that matters for performance is whether
 * it's on the PCIe bus or behind a SATA controller. A virtual disk
 * reports neither, and lands with the SATA SSDs: it's the honest
 * middle guess, and a configuration can say otherwise.
 *
 * @param device
 * @returns
 */
export function classifyDisk(device: BlockDevice): StorageClass {
  if (device.rotational) {
    return StorageClass.Hdd;
  }

  return device.transport === "nvme" ? StorageClass.Ssd : StorageClass.SsdSata;
}

/**
 * Why a disk can't be used, if it can't.
 *
 * Every one of these is a refusal to destroy something. The wording
 * matters: somebody reading this needs to know what to go and look at.
 *
 * @param device
 * @param children everything sitting on top of it
 * @param holders
 * @param minimumBytes
 * @returns
 */
function findProblem(
  device: BlockDevice,
  children: BlockDevice[],
  holders: string[],
  minimumBytes: number,
): string | undefined {
  if (device.type !== "disk" && device.type !== "loop") {
    return `it's a ${device.type}, not a disk`;
  }

  if (NEVER.test(device.kname)) {
    return "it isn't a disk this would ever use";
  }

  if (device.readOnly) {
    return "it's read-only";
  }

  if (device.removable) {
    return "it's removable, and a cluster shouldn't keep its data on something that can be unplugged";
  }

  if (device.size < minimumBytes) {
    return `it's only ${formatSize(device.size)}`;
  }

  if (device.mountpoint !== "") {
    return `it's mounted at ${device.mountpoint}`;
  }

  if (device.fstype !== "") {
    return `it already holds ${describeSignature(device.fstype)}`;
  }

  if (children.length > 0) {
    const mounted = children.filter((child) => child.mountpoint !== "");

    return mounted.length > 0
      ? `it's partitioned, and ${mounted.map((child) => `${child.kname} is mounted at ${child.mountpoint}`).join(", ")}`
      : `it's partitioned into ${children.map((child) => child.kname).join(", ")}`;
  }

  if (holders.length > 0) {
    return `something is already using it: ${holders.join(", ")}`;
  }

  return undefined;
}

/**
 * Say what a signature means in words rather than in abbreviations.
 *
 * @param fstype
 * @returns
 */
function describeSignature(fstype: string): string {
  const known: Record<string, string> = {
    LVM2_member: "an LVM physical volume",
    linux_raid_member: "part of a software RAID array",
    swap: "a swap area",
    crypto_LUKS: "an encrypted volume",
    zfs_member: "part of a ZFS pool",
  };

  return known[fstype] ?? `a ${fstype} filesystem`;
}

/**
 * A size a person can read.
 *
 * @param bytes
 * @returns
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0B";
  }

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;

  return `${value >= 10 || power === 0 ? Math.round(value) : value.toFixed(1)}${units[power]}`;
}

/**
 * Work out what's on this node and what we could use.
 *
 * @param output
 * @param config
 * @param context
 * @returns
 */
export function readDisks(
  output: CommandOutput,
  config: CloudConfig,
  context: any,
): CandidateDisk[] {
  const text = typeof output.parsed === "string" ? output.parsed : (output.stdout ?? "");
  const sections = readSections(text);

  const devices = (sections["devices"] ?? [])
    .map(parseDeviceLine)
    .filter((device): device is BlockDevice => device !== undefined);

  // Which devices are sitting on top of which
  const childrenOf = new Map<string, BlockDevice[]>();
  for (const device of devices) {
    if (device.parent === "") {
      continue;
    }

    const list = childrenOf.get(device.parent) ?? [];
    list.push(device);
    childrenOf.set(device.parent, list);
  }

  // "holders" is how the kernel says something is built on this
  const holdersOf = new Map<string, string[]>();
  for (const line of sections["holders"] ?? []) {
    const [name, holder] = line.split("|");
    if (name === undefined || holder === undefined || holder === "") {
      continue;
    }
    holdersOf.set(name, [...(holdersOf.get(name) ?? []), holder]);
  }

  // What LVM already has. Ownership comes from the tag on the volume
  // itself; the volume group it happens to be in is just where it is.
  const volumes = new Map<string, { group: string; tags: string[] }>();

  for (const line of sections["pvs"] ?? []) {
    const fields = line.split("|").map((field) => field.trim());
    const name = fields[0];

    if (name === undefined || name === "") {
      continue;
    }

    volumes.set(name, { group: fields[1] ?? "", tags: readTags(fields[2]) });
  }

  const groupTags = new Map<string, string[]>();
  for (const line of sections["vgs"] ?? []) {
    const fields = line.split("|").map((field) => field.trim());

    if (fields[0] !== undefined && fields[0] !== "") {
      groupTags.set(fields[0], readTags(fields[1]));
    }
  }

  const storage = getStorageConfig(config, context);
  const named = Array.isArray(storage.disks) ? storage.disks : undefined;
  const overrides = storage.diskClasses ?? {};
  const minimumBytes =
    storage.minimumSizeGb !== undefined
      ? storage.minimumSizeGb * 1024 * 1024 * 1024
      : MINIMUM_DISK_BYTES;

  const disks: CandidateDisk[] = [];

  for (const device of devices) {
    const path = `/dev/${device.kname}`;

    // A partition is only ever something that makes its parent
    // unusable, never a candidate of its own
    if (device.parent !== "") {
      continue;
    }

    // Loop devices are never picked up on their own, but naming one
    // is how this gets tested without a machine full of spare disks
    if (named === undefined && device.type === "loop") {
      continue;
    }

    if (named !== undefined && !named.includes(path) && !named.includes(device.kname)) {
      continue;
    }

    const problem = findProblem(
      device,
      childrenOf.get(device.kname) ?? [],
      holdersOf.get(device.kname) ?? [],
      minimumBytes,
    );

    const override = overrides[path] ?? overrides[device.kname];

    // A physical volume we tagged isn't a disk we can't have, it's a
    // disk we already took
    const volume = volumes.get(path);
    const claimed = volume !== undefined && volume.tags.includes(OWNER_TAG);

    // A physical volume belonging to no volume group contains
    // nothing: logical volumes live in groups, so there is nowhere
    // for data to be. That makes it safe to take, and it's usually
    // one of ours from a run that stopped halfway — the tag couldn't
    // have been written yet, because tags live in the group.
    const bare = volume !== undefined && volume.group === "" && !claimed;

    // What it was set up as beats what its hardware suggests. A disk
    // put in a class by a configuration that has since changed is
    // still serving the class it's actually in.
    const tagged = volume !== undefined ? readClassTag(volume.tags) : undefined;

    disks.push({
      path,
      name: device.kname,
      size: device.size,
      storageClass: (claimed ? tagged : undefined) ?? override ?? classifyDisk(device),
      state: claimed
        ? DiskState.Claimed
        : problem !== undefined && !bare
          ? DiskState.Unusable
          : DiskState.Free,
      device,
      volumeGroup: claimed && volume.group !== "" ? volume.group : undefined,
      unusableBecause: claimed || bare ? undefined : problem,
      note: bare
        ? "an LVM physical volume in no volume group, so it holds nothing — taking it"
        : undefined,
    });
  }

  // A disk the configuration named and the node doesn't have is worth
  // saying outright: it's usually a typo, and the alternative is
  // quietly building a smaller cluster than was asked for
  for (const wanted of named ?? []) {
    const found = disks.some((disk) => disk.path === wanted || disk.name === wanted);

    if (!found) {
      disks.push({
        path: wanted,
        name: wanted.replace(/^\/dev\//, ""),
        size: 0,
        storageClass: StorageClass.Hdd,
        state: DiskState.Unusable,
        device: {
          name: wanted, kname: wanted, type: "missing", size: 0, rotational: false,
          transport: "", model: "", readOnly: false, removable: false,
          mountpoint: "", fstype: "", parent: "",
        },
        unusableBecause: "this node doesn't have it",
      });
    }
  }

  return disks;
}

/**
 * Read a comma separated tag list, as LVM reports one.
 *
 * @param value
 * @returns
 */
function readTags(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

/**
 * Split the output into the sections the command printed.
 *
 * @param text
 * @returns
 */
function readSections(text: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let current = "";

  for (const line of text.split("\n")) {
    const marker = line.match(/^==\s*(\S+)\s*==$/);

    if (marker !== null) {
      current = marker[1] as string;
      sections[current] = [];
      continue;
    }

    if (current !== "" && line.trim() !== "") {
      (sections[current] as string[]).push(line.trim());
    }
  }

  return sections;
}

/**
 * The disks we can actually use, grouped by the class they'll serve.
 *
 * @param disks
 * @returns
 */
export function groupUsableDisks(disks: CandidateDisk[]): Record<string, CandidateDisk[]> {
  return groupDisks(disks, [DiskState.Free]);
}

/**
 * The disks this node serves a class from, whether they were set up
 * just now or on a previous run.
 *
 * @param disks
 * @returns
 */
export function groupServingDisks(disks: CandidateDisk[]): Record<string, CandidateDisk[]> {
  return groupDisks(disks, [DiskState.Free, DiskState.Claimed]);
}

/**
 * Group disks in any of the given states by the class they serve.
 *
 * @param disks
 * @param states
 * @returns
 */
function groupDisks(
  disks: CandidateDisk[],
  states: DiskState[],
): Record<string, CandidateDisk[]> {
  const groups: Record<string, CandidateDisk[]> = {};

  for (const disk of disks) {
    if (!states.includes(disk.state)) {
      continue;
    }

    groups[disk.storageClass] = [...(groups[disk.storageClass] ?? []), disk];
  }

  return groups;
}

/**
 * The disks an earlier command found, out of the context.
 *
 * @param context
 * @returns
 */
function getDisks(context: any): CandidateDisk[] {
  const disks = context.storageDisks;
  return Array.isArray(disks) ? disks : [];
}

/**
 * Whether there's anything to do on this node.
 *
 * A node with no spare disks is an ordinary node. Most of a cluster
 * is nodes with nowhere to put a volume, and that's fine — TopoLVM
 * only schedules onto the ones that have somewhere.
 *
 * @param context
 * @returns
 */
function hasUsableDisks(context: any): boolean {
  return Object.keys(groupUsableDisks(getDisks(context))).length > 0;
}

/**
 * Whether this node serves any storage at all, set up now or before.
 *
 * @param context
 * @returns
 */
function servesStorage(context: any): boolean {
  return Object.keys(groupServingDisks(getDisks(context))).length > 0;
}

export const LvmCommands: CommandSpec[] = [
  /**
   * Look at every block device on the node and work out which of them
   * are spare.
   *
   * One walk that reports everything, rather than a question per
   * disk: the reasons a disk can't be used are as interesting as the
   * list of ones that can, and a node where nothing is usable is the
   * case most in need of explaining.
   */
  {
    name: "find-disks",
    description: "Find the disks on this node and work out which are free",
    purpose: CommandPurpose.Inspect,
    command: [
      'command -v lsblk > /dev/null 2>&1 || { echo "lsblk isn\'t installed, so the disks can\'t be read. Install util-linux." >&2; exit 1; }',
      'echo "== devices =="',
      "lsblk -b -P -o NAME,KNAME,TYPE,SIZE,ROTA,TRAN,MODEL,RO,RM,MOUNTPOINT,FSTYPE,PKNAME",
      'echo "== pvs =="',
      // What LVM already has, and which of it is ours. The tag is the
      // answer to that, not the volume group's name.
      'if command -v pvs > /dev/null 2>&1',
      "then sudo pvs --noheadings -o pv_name,vg_name,pv_tags --separator '|' 2>/dev/null || true",
      "fi",
      'echo "== vgs =="',
      'if command -v vgs > /dev/null 2>&1',
      "then sudo vgs --noheadings -o vg_name,vg_tags --separator '|' 2>/dev/null || true",
      "fi",
      'echo "== holders =="',
      // What the kernel says is built on top of each device
      "for device in /sys/block/*; do",
      '  name=$(basename "$device")',
      '  for holder in "$device"/holders/*; do',
      '    [ -e "$holder" ] || continue',
      '    printf "%s|%s\\n" "$name" "$(basename "$holder")"',
      "  done",
      "done",
    ],
    output: OutputType.Raw,
    postProcessHooks: [],
    saveToContext: (output: any, context: any, config: CloudConfig) => {
      const disks = readDisks(output, config, context);
      const usable = groupUsableDisks(disks);
      const groups = getVolumeGroups(config);

      for (const disk of disks) {
        if (disk.state === DiskState.Unusable) {
          console.log(`  ${disk.path.padEnd(16)} ${formatSize(disk.size).padStart(6)}  left alone: ${disk.unusableBecause}`);
        }
        else if (disk.state === DiskState.Claimed) {
          console.log(`  ${disk.path.padEnd(16)} ${formatSize(disk.size).padStart(6)}  already in ${disk.volumeGroup}`);
        }
        else if (disk.note !== undefined) {
          console.log(`  ${disk.path.padEnd(16)} ${formatSize(disk.size).padStart(6)}  ${disk.note}`);
        }
      }

      for (const [storageClass, entries] of Object.entries(usable)) {
        const group = groups[storageClass];
        const total = entries.reduce((sum, disk) => sum + disk.size, 0);

        console.log(
          `  ${storageClass.padEnd(10)} ${formatSize(total).padStart(6)}  ${group ?? "no volume group for this class"}  ${entries.map((disk) => `${disk.path} (${disk.device.model || disk.device.transport || "unknown"})`).join(", ")}`,
        );

        if (group === undefined) {
          throw new Error(
            `This node has ${storageClass} disks, but the TopoLVM values name no volume group for a "${storageClass}" device class. Either add one there or set "storage.diskClasses" to put these disks somewhere else.`,
          );
        }
      }

      const serving = groupServingDisks(disks);

      if (Object.keys(serving).length === 0) {
        console.log("  No free disks on this node, so there's nothing for TopoLVM to use here.");
      }
      else if (Object.keys(usable).length === 0) {
        console.log(
          `  Already set up: ${Object.keys(serving).join(", ")}. Nothing new to add.`,
        );
      }

      return {
        storageDisks: disks,
        storageVolumeGroups: groups,
        storageClassesPresent: Object.keys(serving),
      };
    },
  },

  /**
   * Make the disks available to LVM.
   *
   * This is the destructive one. Everything it touches has already
   * been shown to be unused by the command above, and anything that
   * wasn't is not in the list.
   */
  {
    name: "create-physical-volumes",
    description: "Make the free disks into LVM physical volumes",
    purpose: CommandPurpose.Apply,
    skipWhen: (_config: CloudConfig, context: any) => !hasUsableDisks(context),
    command: (_config: CloudConfig, context: any) => {
      const disks = Object.values(groupUsableDisks(getDisks(context))).flat();

      return [
        'command -v pvcreate > /dev/null 2>&1 || { echo "LVM isn\'t installed on this node. Install lvm2." >&2; exit 1; }',
        ...disks.flatMap((disk) => {
          const path = quoteForShell(disk.path);

          return [
            // Already a physical volume is the re-run case, and not a
            // reason to stop or to wipe anything
            `sudo pvs ${path} > /dev/null 2>&1 || sudo pvcreate ${path} || { echo "Couldn't make ${disk.path} into a physical volume" >&2; exit 1; }`,
          ];
        }),
        "sudo pvs --noheadings -o pv_name,pv_size,vg_name,pv_tags",
      ];
    },
    output: OutputType.Raw,
  },

  /**
   * Put them into the volume groups TopoLVM expects.
   */
  {
    name: "create-volume-groups",
    description: "Create the volume groups TopoLVM's device classes name",
    purpose: CommandPurpose.Apply,
    skipWhen: (_config: CloudConfig, context: any) => !hasUsableDisks(context),
    command: (config: CloudConfig, context: any) => {
      const groups = getVolumeGroups(config);
      const usable = groupUsableDisks(getDisks(context));
      const lines: string[] = [];

      for (const [storageClass, disks] of Object.entries(usable)) {
        const group = groups[storageClass];
        if (group === undefined) {
          continue;
        }

        const name = quoteForShell(group);
        const paths = disks.map((disk) => quoteForShell(disk.path)).join(" ");

        lines.push(
          // Extend rather than recreate, so adding a disk to a node
          // later is the same command
          `if sudo vgs ${name} > /dev/null 2>&1`,
          `then sudo vgextend ${name} ${paths} 2>/dev/null || echo "${group} already has these disks"`,
          `else sudo vgcreate --addtag ${OWNER_TAG} --addtag ${classTag(storageClass)} ${name} ${paths} || { echo "Couldn't create the volume group ${group}" >&2; exit 1; }`,
          "fi",
          // Tagged whichever way it was made, so a group this created
          // is always recognisable later
          `sudo vgchange --addtag ${OWNER_TAG} --addtag ${classTag(storageClass)} ${name} > /dev/null`,

          // The physical volumes are tagged here rather than when
          // they were created, because LVM keeps a volume's tags in
          // the metadata of the group it belongs to. A physical
          // volume in no group has nowhere to put them, and says so.
          ...disks.map(
            (disk) =>
              `sudo pvchange --addtag ${OWNER_TAG} --addtag ${classTag(storageClass)} ${quoteForShell(disk.path)} > /dev/null || { echo "Couldn't tag ${disk.path}" >&2; exit 1; }`,
          ),
        );
      }

      return [...lines, "sudo vgs --noheadings -o vg_name,vg_size,vg_free,vg_tags"];
    },
    output: OutputType.Raw,
  },

  /**
   * Check the node ended up where we wanted.
   *
   * vgcreate reports success for the group it made, which says
   * nothing about whether the set of them is what TopoLVM will go
   * looking for. That's the thing worth knowing.
   */
  {
    name: "verify-volume-groups",
    description: "Check the volume groups TopoLVM needs are all present",
    purpose: CommandPurpose.Verify,
    skipWhen: (_config: CloudConfig, context: any) => !servesStorage(context),
    command: [
      'command -v vgs > /dev/null 2>&1 || { echo "LVM isn\'t installed on this node, so there are no volume groups." >&2; exit 1; }',
      "sudo vgs --noheadings --units b --nosuffix -o vg_name,vg_size,vg_free,pv_count,vg_tags --separator '|'",
    ],
    output: OutputType.Raw,
    saveToContext: (output: any, context: any, config: CloudConfig) => {
      const groups = getVolumeGroups(config);
      const present = new Map<string, { size: number; free: number; disks: number; tags: string }>();

      for (const line of String(output.parsed ?? "").split("\n")) {
        const fields = line.trim().split("|");
        if (fields.length < 5 || fields[0] === "") {
          continue;
        }

        present.set(fields[0] as string, {
          size: Number(fields[1]),
          free: Number(fields[2]),
          disks: Number(fields[3]),
          tags: fields[4] as string,
        });
      }

      // Only the classes this node actually has disks for. A node
      // with no spinning disks isn't missing cc-hdd-vg, it just
      // doesn't serve that class, and TopoLVM is fine with that.
      const expected = Object.keys(groupServingDisks(getDisks(context)));
      const missing: string[] = [];

      for (const storageClass of expected) {
        const group = groups[storageClass];
        if (group === undefined) {
          continue;
        }

        const found = present.get(group);
        if (found === undefined) {
          missing.push(`${group} (for the ${storageClass} device class)`);
          continue;
        }

        // A group with the right name and not our tag is somebody
        // else's, and using it would be taking something that isn't
        // ours. Worth saying rather than quietly filling it up.
        const tags = readTags(found.tags);
        const notes: string[] = [];

        if (!tags.includes(OWNER_TAG)) {
          notes.push(`⚠️  this group isn't tagged ${OWNER_TAG}, so something else made it`);
        }
        else if (!tags.includes(classTag(storageClass))) {
          notes.push(`⚠️  tagged for a different device class than ${storageClass}`);
        }

        console.log(
          `  ${group.padEnd(18)} ${formatSize(found.size).padStart(7)} total, ${formatSize(found.free).padStart(7)} free, ${found.disks} disk${found.disks === 1 ? "" : "s"}${notes.length > 0 ? `  ${notes.join(", ")}` : ""}`,
        );
      }

      if (missing.length > 0) {
        throw new Error(
          `These volume groups should exist on this node and don't: ${missing.join(", ")}. TopoLVM will report the device class as unavailable and nothing will be scheduled onto it.`,
        );
      }

      return {
        storageVolumeGroupsPresent: [...present.keys()],
      };
    },
  },
];
