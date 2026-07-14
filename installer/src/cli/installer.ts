import fs from "node:fs/promises";
import path from "node:path";
import { program, Argument } from "commander";
import { runBundle } from "../runners/runBundle.ts";

/**
 * The Community Cloud Command Line Installer
 *
 * Usage:
 *  community-cloud <operation> <CC Config File>
 *
 * Example:
 *  community-cloud install cc.json
 */
const COMMAND_NAME = "community-cloud";

/**
 * The operations the can be run be the command
 * line installer.
 *
 * - install -> run the Community Cloud install process
 * - uninstall -> uninstall Community Cloud
 * - clean -> clean up various install steps
 *
 * TODO: Switch this to use commander sub-commands
 */
enum CliOperation {
  Install = "install",
  Uninstall = "uninstall",
  Clean = "clean",
  RunBundle = "run-bundle"
}


// Set command line options and parse them
program
  .version("0.1.0")
  .name(COMMAND_NAME)
  .description("Community Cloud Installer CLI utility.")
  .showHelpAfterError()

// 1. Install Command (Primary Operation)
program
  .command(CliOperation.Install)
  .description("Run the Community Cloud installation process.")
  .option("--force", "Force install even if dependencies seem met.")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file");

// 2. Uninstall Command
program
  .command(CliOperation.Uninstall)
  .description("Uninstall existing Community Cloud components.")
  .option("--skip-cleanup", "Skip cleanup of related directories and files.")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file");

// 3. Clean Command
program
  .command("clean")
  .description("Clean up various install steps, removing residual files.")
  .option("--full", "Perform a deep clean of all possible installation artifacts.")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file");

// 4. RunBundle Command
program
  .command(CliOperation.RunBundle)
  .description("Run a specific command bundle")
  .argument("<bundleName>")
  .argument("<node>")
  // .option("--profile", "Specify a profile (e.g., staging, production).")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file")
  .action(runBundle);

  // Parse arguments and exit
  program.parse(process.argv);

// Retrieve options
// TODO: Use Options
// Currently we're simply leaning on the config file
// to make this work. Options supplied at command
// line will be used as overrides or as the value
// if not specified in config
//const options = program.opts();

// Get the program operation
// const operation = program.args[0];

// // Get the inital input path
// const inputPath = program.args[1];

// // If the input path is undefined
// // we exit (though this shouldn't
// // happen right now as it's required)
// if (inputPath === undefined) {
//   process.exit(0);
// }

// Resolve absolute path to the file
// const filePath = path.resolve(inputPath);

// Parse the contents
// const ccDataRaw = await fs.readFile(filePath, { encoding: "utf-8" });
// const ccData = JSON.parse(ccDataRaw);

// TODO: Validate file schema
// This will be a soft validation
// as what we're going to do is use inquirer
// to fill in everything required that isn't
// along with setting up everything else
// Which will then be used

// /**
//  * Run correct installer command
//  */
// switch (operation) {
//   case CliOperation.Install:
//     break;
//   case CliOperation.Uinstall:
//     break;
//   case CliOperation.Clean:
//     break;
// }
// console.log(ccData);
// process.exit(0);
