import { K3sBundle } from "../cli/commands/K3s.ts";
import RemoteHost from "../remote/RemoteHost.ts";

/**
 * A map of command bundles
 */
const bundleMap = {
  k3s: K3sBundle,
};

/**
 * Run a command bundle remotely.
 *
 * @param bundleName
 * @param nodeName
 * @param config
 */
export async function runRemoteBundle(bundleName, nodeName, config) {
  // Retrieve the node
  const nodeInfo = config.getNode(nodeName);

  // Connect to the node via SSH
  const node = new RemoteHost({
    host: nodeInfo.address,
    username: nodeInfo.username,
  });
  await node.connect();

  // Run the bundle
  const bundle = bundleMap[bundleName];
  await bundle.start();

  // Disconnect from the node
  await node.disconnect();
}

export async function runRemoteBundles(bundleList, nodeName, config) {}
