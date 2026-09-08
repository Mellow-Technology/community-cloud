import os from "os";

import { exec } from "../util/exec.ts";

import { CommandBundle } from "../cli/commands/CommandBundle.ts";
import RemoteHost from "../remote/RemoteHost.ts";
import CloudConfig from "../util/CloudConfig.ts";
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

  // Retrieve the node configuration
  const nodeInfo = config.getNode(nodeName);
  if (nodeInfo === null) {
    throw new Error(`Couldn't find node "${nodeName}" in the specified configuration. Was the name misspelled?`);
  }

  // Add node information to the context
  context.node = nodeInfo;

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


  // Don't use SSH if we're running directly
  // on the host already
  const hostname = os.hostname();
  if (hostname === nodeName) {
    bundle.setExec(exec);
    await bundle.runAllCommands();
  }
  else {
    // Connect to the node via SSH
    const node = new RemoteHost({
      host: nodeInfo.address,
      username: nodeInfo.username,
      keyFile: nodeInfo.keyFile,
      port: nodeInfo.port,
    });
    await node.connect();

    try {
      // Run every command in the bundle over the connection
      // we just opened
      bundle.setExec((command: string) => node.exec(command));
      await bundle.runAllCommands();
    }
    finally {
      // Disconnect from the node
      await node.disconnect();
    }
  }
}

export async function runRemoteBundles(bundleList, nodeName, config) {}
