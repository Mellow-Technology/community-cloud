import { program } from "commander";
import chalk from "chalk";

/**
 * Report a failure the way a command line tool should.
 *
 * The runners throw when something is wrong, and commander doesn't
 * await the handlers, so without this a mistyped path comes back as an
 * unhandled rejection and a stack trace through minified code. Set
 * CC_DEBUG to see the stack anyway.
 */
process.on("unhandledRejection", (reason: any) => {
  const message = reason !== null && reason !== undefined && reason.message !== undefined
    ? reason.message
    : String(reason);

  console.error(`\n${chalk.red("⛔")} ${message}\n`);

  if (process.env["CC_DEBUG"] !== undefined && reason?.stack !== undefined) {
    console.error(reason.stack);
  }

  process.exit(1);
});
import { runBundle } from "../runners/runBundle.ts";
import { runTemplate } from "../runners/runTemplate.ts";
import { listBundles } from "../runners/listBundles.ts";
import { runPipeline } from "../runners/runPipeline.ts";
import { configure } from "../runners/configure.ts";
import { listEmbedded } from "../runners/listEmbedded.ts";

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
  Configure = "configure",
  Install = "install",
  Uninstall = "uninstall",
  Clean = "clean",
  RunBundle = "run-bundle",
  ListBundles = "list-bundles",
  ListEmbedded = "list-embedded",
  RunPipeline = "run-pipeline",
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

// 0. Configure Command
// The default, because a configuration file is what every other
// command takes and this is where one comes from
program
  .command(CliOperation.Configure, { isDefault: true })
  .description("Build a Community Cloud configuration, or change an existing one")
  .argument("[ccFilePath]", "Path to the configuration file", "cc.config.json")
  .option("--all", "Walk through every section rather than opening the menu")
  .option("--section <name>", "Go straight to one section")
  .action(configure);

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

// 5. Apply variables to a template and apply or delete it with kubectl
// 5. RunPipeline Command
program
  .command(CliOperation.RunPipeline)
  .description("Run several bundles against a node, one after another, sharing their context")
  .argument("<pipeline>", "A comma separated list of bundles, or a pipeline named in the configuration")
  .argument("<node>", "The name of the node to run the pipeline on")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file")
  .option("--keep-going", "Carry on after a bundle fails instead of stopping")
  .action(runPipeline);

// 6. ListBundles Command
program
  .command(CliOperation.ListBundles)
  .description("List the command bundles that can be run")
  .argument("[bundleName]", "Show the commands in a single bundle")
  .option("-c, --config <ccFilePath>", "Configuration file, needed for bundles whose commands come from one")
  .action(listBundles);

// 7. ListEmbedded Command
program
  .command(CliOperation.ListEmbedded)
  .description("List the manifests that ship inside the installer")
  .argument("[filter]", "Only show paths containing this")
  .action(listEmbedded);

program
    .command(CliOperation.RunTemplate)
    .description("Apply template variables to a yaml template file and apply (or delete) with kubectl")
    .argument("<yamlFile>", "A template: embed://<path> for one shipped with the installer, or a path on this machine")
    .argument("<ccFilePath>", "Path to the Community Cloud configuration file")
    .option("-o, --operation <operation>", "The kubectl operation to run, either apply or delete", "apply")
    .option("-n, --node <node>", "Run kubectl on this node over SSH rather than locally")
    .option("--namespace <namespace>", "Namespace to scope the operation to")
    .option("--dry-run", "Render the template and print it without running kubectl")
    .action(runTemplate);

// TODO: This is kind of ugly. Would much rather have dynamically generated
// options so that we have a specific mapping
// .argument("[params]...", "Parameters to supply to the command")
// .option("--dry-run", "Simluate a command run and show constructed commands")
// .action(runBundle);

// Parse arguments and exit
program.parse(process.argv);
