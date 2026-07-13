import Command, { OutputType } from "./Command.ts";
import { CommandBundle } from "./CommandBundle.ts";

/**
 * @file
 *
 * Setup Logical Volume Manager Volumes
 *
 * Requires:
 * - jc
 * - root/sudo
 */

export const bundle = new CommandBundle();

/**
 * Find disks that can be used with LVM.
 */
bundle.add(
  new Command({
    name: "find-disks",
    description: "Find disks that can be used with LVM for node local storage.",
    command: "sudo sfdisk -l | jc --sfdisk",
    output: OutputType.Json,
    postProcessHooks: [findCandidateDisks],
    // configure,
  }),
);

/**
 * Create physical volumes for use with LVM volume groups.
 */
bundle.add(
  new Command({
    name: "create-pvs",
    description: "Create LVM physical volumes from the configured disks.",
    output: OutputType.Custom,
    command: (context) => `sudo pvcreate ${diskList.join(" ")}`,
  }),
);

/**
 * Create volume groups from physical volumes
 */
bundle.add(
  new Command({
    name: "create-vgs",
    description: "Create LVM volume groups from the selected physical volumes.",
    output: OutputType.Custom,
    command: (context) => `sudo vgcreate cc-ssd-vg ${diskList.join(" ")}`,
  }),
);

/**
 * Regex which will skip loop devices
 * since we're specifically targeting
 * actual physical drives.
 */
const LOOP_DEVICE_REGEX = /^\/dev\/loop[0-9].*$/;

/**
 * Finds candidate disks for use with LVM.
 * Intentionally filters out loop devices.
 *
 * @param disks
 * @returns
 */
function findCandidateDisks(disks: string[]) {
  const noLoopDisks = disks.filter(({ disk }) => !LOOP_DEVICE_REGEX.test(disk));
  const emptyPartitionDisks = noLoopDisks.filter(
    ({ partitions }) => partitions === undefined,
  );

  return emptyPartitionDisks;
}
