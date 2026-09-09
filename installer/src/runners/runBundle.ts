import { CommandBundle } from "../cli/commands/CommandBundle.ts";
import CloudConfig from "../util/CloudConfig.ts";
import { connectToNode } from "./nodeConnection.ts";
import { getBundle, getBundleCommands, getBundleNames } from "../cli/commands/bundles.ts";

/**
 * Run a command bundle remotely.
 *
 * @param bundleName
 * @param nodeName
 * @param config
 */
export async function runBundle(bundleName: string, nodeName: string, configPath: string, ...params: string[]) {

  // Instantiate the context
  // We include the node name we're
  // operating and any parameters for the command
  let context = {
    nodeName,
    params,
    node: null,
  }

  // Load the configuration
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);

  // Connect to the node, which may be this machine
  const connection = await connectToNode(config, nodeName);

  // Add node information to the context
  context.node = connection.node;

  // Retrieve the correct bundle
  const bundleDefinition = getBundle(bundleName);
  if (bundleDefinition === undefined) {
    throw new Error(`Couldn't find a command bundle named "${bundleName}". Was the bundle name spelled correctly? The bundles that can be run are: ${getBundleNames().join(", ")}.`)
  }

  // Most bundles are a fixed list of commands, but some are built from
  // the configuration: the roles on a Nebula network are a command
  // each, and only the configuration knows how many there are.
  const bundleCommands = getBundleCommands(bundleDefinition, config, context);

  // Instantiate the bundle and add commands
  const bundle = new CommandBundle(config, bundleCommands, context);
  bundle.setExec(connection.exec);

  try {
    await bundle.runAllCommands();
  }
  finally {
    await connection.disconnect();
  }
}

export async function runRemoteBundles(bundleList, nodeName, config) {}
