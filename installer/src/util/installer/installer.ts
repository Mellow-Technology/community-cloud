import fs from "node:fs/promises";
import path from "node:path";
import { program, Argument } from "commander";

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
  Uinstall = "uninstall",
  Clean = "clean",
}

// Set command line options and parse them
program // .option("--server-local")
  // .option("--agent-local")
  // .option("--use-tailscale")
  .version("0.1.0")
  .name(COMMAND_NAME)
  .showHelpAfterError()
  .addArgument(
    new Argument("<operation>", "The operation to run").choices(
      Object.values(CliOperation),
    ),
  )
  .argument("<ccFilePath>", "Path to the Community Cloud configuration file");
program.parse();

// Retrieve options
// TODO: Use Options
// Currently we're simply leaning on the config file
// to make this work. Options supplied at command
// line will be used as overrides or as the value
// if not specified in config
//const options = program.opts();

// Get the program operation
const operation = program.args[0];

// Get the inital input path
const inputPath = program.args[1];

// If the input path is undefined
// we exit (though this shouldn't
// happen right now as it's required)
if (inputPath === undefined) {
  process.exit(0);
}

// Resolve absolute path to the file
const filePath = path.resolve(inputPath);

// Parse the contents
const ccDataRaw = await fs.readFile(filePath, { encoding: "utf-8" });
const ccData = JSON.parse(ccDataRaw);

// TODO: Validate file schema
// This will be a soft validation
// as what we're going to do is use inquirer
// to fill in everything required that isn't
// along with setting up everything else
// Which will then be used

/**
 * Run correct installer command
 */
switch (operation) {
  case CliOperation.Install:
    break;
  case CliOperation.Uinstall:
    break;
  case CliOperation.Clean:
    break;
}
console.log(ccData);
process.exit(0);
