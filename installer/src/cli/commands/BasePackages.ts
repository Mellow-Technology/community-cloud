/**
 * @file
 * Install base packages needed for everything to run.
 *
 * TODO: Support more than just Ubuntu.
 */
import { OutputType } from "./Command.ts"

export const BasePackageCommands = [
  {
    name: "update-apt",
    description: "Update apt packages",
    command: "sudo apt update",
    output: OutputType.Raw
  },
  {
    name: "install-jc",
    description: "Install 'jc' command line tool",
    command: "sudo apt install jc -y",
    output: OutputType.Raw,
  },
];
