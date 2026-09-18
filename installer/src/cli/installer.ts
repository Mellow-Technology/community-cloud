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
import { addNode } from "../runners/addNode.ts";
import { runTemplate } from "../runners/runTemplate.ts";
import { listBundles } from "../runners/listBundles.ts";
import { runBundle, runPipeline } from "../runners/runPipeline.ts";
import { install } from "../runners/install.ts";
import { configure } from "../runners/configure.ts";
import { listEmbedded } from "../runners/listEmbedded.ts";
import { doctor } from "../runners/doctor.ts";
import { preflight } from "../runners/preflight.ts";

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
 * - add-node -> add a node to a cluster that already exists
 * - uninstall -> uninstall Community Cloud
 * - clean -> clean up various install steps
 */
enum CliOperation {
  Configure = "configure",
  Install = "install",
  Uninstall = "uninstall",
  Clean = "clean",
  AddNode = "add-node",
  RunBundle = "run-bundle",
  ListBundles = "list-bundles",
  ListEmbedded = "list-embedded",
  Doctor = "doctor",
  Preflight = "preflight",
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

// Configure
// The default, because a configuration file is what every other
// command takes and this is where one comes from
program
  .command(CliOperation.Configure, { isDefault: true })
  .description("Build a Community Cloud configuration, or change an existing one")
  .argument("[ccFilePath]", "Path to the configuration file", "cc.config.json")
  .option("--all", "Walk through every section rather than opening the menu")
  .option("--section <name>", "Go straight to one section")
  .action(configure);

// Install
program
  .command(CliOperation.Install)
  .description("Install Community Cloud across every node in a configuration")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file")
  .option("-n, --node <node>", "Install onto one node only. To add a machine to a cluster that exists, use add-node")
  .option("--dry-run", "Work out every step and print it, changing nothing")
  .option("--keep-going", "Carry on after a step fails instead of stopping")
  .option("--timeout <seconds>", "How long to give a node to answer when connecting")
  .action(install);

// Add a node
// An install with the cluster-wide half taken out: everything that
// makes one machine a member, and nothing that rebuilds the cluster
program
  .command(CliOperation.AddNode)
  .description("Add a node to a cluster that already exists")
  .argument("<node>", "The node to add, as it is named in the configuration")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file")
  .option("--dry-run", "Work out every step and print it, changing nothing")
  .option("--keep-going", "Carry on after a step fails instead of stopping")
  .option("--timeout <seconds>", "How long to give the node to answer when connecting")
  .option("--verbose", "Print each command's output as well as the report")
  .action(addNode);

// Uninstall
program
  .command(CliOperation.Uninstall)
  .description("Uninstall existing Community Cloud components.")
  .option("--skip-cleanup", "Skip cleanup of related directories and files.")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file");

// Clean
program
  .command(CliOperation.Clean)
  .description("Clean up various install steps, removing residual files.")
  .option("--full", "Perform a deep clean of all possible installation artifacts.")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file");

// Run one bundle
program
  .command(CliOperation.RunBundle)
  .description("Run a specific command bundle against one node or every node, in lock step")
  .argument("<bundleName>", "The name of the bundle to run")
  .argument("<node>", 'The node to run against, or "all" for every node in the configuration')
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file")
  .option("--keep-going", "Carry on after a step fails instead of stopping")
  .option("--dry-run", "Work out every step and print it, changing nothing")
  .option("--timeout <seconds>", "How long to give a node to answer when connecting")
  .option("--verbose", "Print each command's output as well as the report")
  .action(runBundle);

// Run several bundles
program
  .command(CliOperation.RunPipeline)
  .description("Run several bundles against one node or every node, in lock step")
  .argument("<pipeline>", "A comma separated list of bundles, or a pipeline named in the configuration")
  .argument("<node>", 'The node to run against, or "all" for every node in the configuration')
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file")
  .option("--keep-going", "Carry on after a step fails instead of stopping")
  .option("--dry-run", "Work out every step and print it, changing nothing")
  .option("--timeout <seconds>", "How long to give a node to answer when connecting")
  .option("--verbose", "Print each command's output as well as the report")
  .action(runPipeline);

// List bundles
program
  .command(CliOperation.ListBundles)
  .description("List the command bundles that can be run")
  .argument("[bundleName]", "Show the commands in a single bundle")
  .option("-c, --config <ccFilePath>", "Configuration file, needed for bundles whose commands come from one")
  .action(listBundles);

// Preflight
program
  .command(CliOperation.Preflight)
  .description("Check a configuration could be installed, before installing it")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file")
  .option("-n, --node <node>", "Check this node only")
  .option("--timeout <seconds>", "How long to give a node to answer before calling it unreachable", "8")
  .option("--verbose", "Print each command's output as well as the report")
  .action(preflight);

// Doctor
program
  .command(CliOperation.Doctor)
  .description("Ask a cluster how it's doing, without changing anything")
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file")
  .option("-n, --node <node>", "Look at this node only")
  .option("-b, --bundle <bundle>", "Run the checks from this bundle only")
  .option("--verifications", "Only the checks that assert something, skipping the ones that just report")
  .option("--wait", "Also run the checks that wait for something to settle, which are slow when anything is wrong")
  .option("--verbose", "Print each command's output as well as the report")
  .action(doctor);

// List embedded manifests
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
    // Wrapped because run-template hands back the rendered manifest
    // for anything calling it directly, and commander wants nothing
    .action(async (yamlFile: string, ccFilePath: string, options: any) => {
      await runTemplate(yamlFile, ccFilePath, options);
    });

// Parse arguments and exit
program.parse(process.argv);
