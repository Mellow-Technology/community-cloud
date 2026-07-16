import { K3sCommands } from "../cli/commands/K3s.ts";
import { CommandBundle } from "../cli/commands/CommandBundle.ts";
import RemoteHost from "../remote/RemoteHost.ts";
import CloudConfig from "../util/CloudConfig.ts";
import { exec } from "node:child_process";
import os from "os";

/**
 * A map of command bundles
 */
const commandMap = {
  k3s: K3sCommands,
};

/**
 * Run a command bundle remotely.
 *
 * @param bundleName
 * @param nodeName
 * @param config
 */
export async function runBundle(bundleName: string, nodeName: string, configPath: string) {

  // Load the configuration
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);

  // Retrieve the node configuration
  const nodeInfo = config.getNode(nodeName);
  if (nodeInfo === null) {
    throw new Error(`Couldn't find node "${nodeName}" in the specified configuration. Was the name misspelled?`);
  }

  // Retrieve the correct bundle
  const bundleCommands = commandMap[bundleName];

  // Instantiate the bundle and add commands
  const bundle = new CommandBundle(config, bundleCommands);


  // Don't use SSH if we're running directly
  // on the host already
  const hostname = os.hostname();
  if (hostname === nodeName) {
    bundle.setExec(exec);
    bundle.runAllCommands();
  }
  else {
    // Connect to the node via SSH
    const node = new RemoteHost({
      host: nodeInfo.address,
      username: nodeInfo.username,
    });
    await node.connect();

    // Disconnect from the node
    await node.disconnect();
  }

  //

}

export async function runRemoteBundles(bundleList, nodeName, config) {}
