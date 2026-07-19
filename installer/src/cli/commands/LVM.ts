import{ CommandOutput, CommandSpec, OutputType } from "./Command.ts";

/**
 * @file
 *
 * Setup Logical Volume Manager Volumes
 *
 * Requires:
 * - jc
 * - lvm
 * - root/sudo
 */

/**
 * Structure of the output from the "sfdisk" command
 */
interface SfDiskOutput {
  disk: string;
  disk_size: string;
  disk_model?: string;
  bytes: number;
  sectors: number;
  units: string;
  logical_sector_size: number;
  physical_sector_size: number;
  min_io_size: number;
  optimal_io_size: number;
}

/**
 * Finds candidate disks for use with LVM.
 * Intentionally filters out loop devices.
 *
 * @param disks
 * @returns
 */
function findCandidateDisks(output: CommandOutput) {
  const disks = output.parsed;
  const validDisks = disks.filter(
    ({ partitions, disk_model }) => partitions === undefined && disk_model !== undefined,
  );

  return validDisks;
}


export const LvmCommands: CommandSpec[] = [
  /**
   * Find disks that can be used with LVM.
   */
  {
    name: "find-disks",
    description: "Find disks that can be used with LVM for node local storage.",
    sudo: true,
    command: "sfdisk -l",
    commandParser: "jc --sfdisk",
    output: OutputType.Json,
    postProcessHooks: [findCandidateDisks],
  },
  /**
   * Create physical volumes for use with LVM volume groups.
   *
   */
  // {
  //   name: "create-pvs",
  //   description: "Create LVM physical volumes from the configured disks.",
  //   output: OutputType.Custom,
  //   command: (context) => `sudo pvcreate ${context.diskList.join(" ")}`,
  // },
  // /**
  //  * Create volume groups.
  //
  //  * TODO: Setup so that different disk types segment into configured
  //  * volume groups
  //  * TODO: Support creation of LVM cache volumes
  //  * see https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/6/html/logical_volume_manager_administration/lvm_cache_volume_creation
  //  */
  // {
  //   name: "create-vgs",
  //   description: "Create LVM volume groups from the selected physical volumes.",
  //   output: OutputType.Custom,
  //   command: (context) => `sudo vgcreate cc-ssd-vg ${context.diskList.join(" ")}`,
  // },
  // /**
  //  * Tag the volume groups
  //  */
  // {
  //   name: "tag-vgs",
  //   description: "Tag logical volumes to indicate that they've been setup by Community Cloud",
  //   OutputType: OutputType.Raw,
  //   command: (context) => `sudo vgchange --addtag @community-cloud ${context.volumeGroup}`
  // }
]
