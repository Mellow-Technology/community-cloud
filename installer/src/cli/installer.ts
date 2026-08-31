import { program } from "commander";
import { runBundle } from "../runners/runBundle.ts";
import { runTemplate } from "../runners/runTemplate.ts";

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
  RunBundle = "run-bundle",
  RunTemplate = "run-template"
}

// =================================================
// TODO: Use Options
// Currently we're simply leaning on the config file
// to make this work. Options supplied at command
// line will be used as overrides or as the value
// if not specified in config
// =================================================

// =================================================
// TODO: Validate file schema
// This will be a soft validation
// as what we're going to do is use inquirer
// to fill in everything required that isn't
// along with setting up everything else
// Which will then be used
// =================================================


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
  .command(CliOperation.Clean)
  .description("Clean up various install steps, removing residual files.")
  .option("--full", "Perform a deep clean of all possible installation artifacts.")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file");

// 4. RunBundle Command
program
  .command(CliOperation.RunBundle)
  .description("Run a specific command bundle")
  .argument("<bundleName>", "The name of the bundle to run")
  .argument("<node>", "The name of the node to run the bundle on")
  // .option("--profile", "Specify a profile (e.g., staging, production).")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file")
  .action(runBundle);

program
    .command(CliOperation.RunTemplate)
    .description("Apply template variables to a yaml template file and apply (or delete) with kubectl")
    .argument("<yamlFile>", "Path to the Yaml template file")
    .argument("<ccFilePath>", "Path to the Community Cloud configuration file")
    .action(runTemplate);

// TODO: This is kind of ugly. Would much rather have dynamically generated
// options so that we have a specific mapping
// .argument("[params]...", "Parameters to supply to the command")
// .option("--dry-run", "Simluate a command run and show constructed commands")
// .action(runBundle);

// Parse arguments and exit
program.parse(process.argv);
