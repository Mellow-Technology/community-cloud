import { compile, parse } from '@ctrl/golang-template';

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
  base: BasePackageCommands
};

enum KubeCtlOperation {
    Apply = "apply",
    Delete = "delete"
}

/**
 * Apply template values from a Community Cloud
 * configuration file and then use kubectl to
 * apply or delete them
 *
 * @param bundleName
 * @param nodeName
 * @param config
 */
export async function runTemplate(bundleName: string, nodeName: string, configPath: string, yamlFilePath: string, operation: KubeCtlOperation) {

  // Load the configuration
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);

  // Read the file contents and
  const fileContents = await readFile(yamlFilePath, { encoding: "utf8" });
  const parsedTemplate = parse(fileContents, config)

  // Retrieve the node configuration
  const nodeInfo = config.getNode(nodeName);
  if (nodeInfo === null) {
    throw new Error(`Couldn't find node "${nodeName}" in the specified configuration. Was the name misspelled?`);
  }

  // Retrieve the correct bundle
  const bundleCommands = commandMap[bundleName];

  // Instantiate the bundle and add commands
  const bundle = new CommandBundle(config, bundleCommands);


  kubeCtl
  await yamlFilePath

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
