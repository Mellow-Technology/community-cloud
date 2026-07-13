import { K3sBundle } from "../cli/commands/K3s.ts";
import RemoteHost from "../remote/RemoteHost.ts";

/**
 * A map of command bundles
 */
const bundleMap = {
  k3s: K3sBundle,
};

async function runRemoteBundle(bundleName, nodeName, config) {
  // Retrieve the node
  const node = config.getNode(nodeName);

  // Connect to the node via SSH
  const node = new RemoteHost({
    host: node.address,
    username: node.username,
  });
  await node.connect();

  // Run the bundle
  const bundle = bundleMap[bundleName];
  await bundle.start();

  // Disconnect from the node
  await node.disconnect();
}

async function runRemoteBundles(bundleList, nodeName, config) {}
