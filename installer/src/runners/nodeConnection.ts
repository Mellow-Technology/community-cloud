/**
 * @file
 * Getting hold of a node so commands can be run on it.
 *
 * Pulled out of the bundle runner because a pipeline runs several
 * bundles against the same node and should open one connection for
 * all of them rather than reconnecting between each.
 */
import os from "os";

import RemoteHost, { RemoteHostOptions } from "../remote/RemoteHost.ts";
import CloudConfig from "../util/CloudConfig.ts";
import { exec } from "../util/exec.ts";

/**
 * A node that's ready to run commands.
 *
 * - node: the node's entry in the configuration
 * - exec: runs a command on it, whether that's here or over SSH
 * - local: whether this is the machine we're already on
 * - disconnect: closes the connection, and does nothing when there
 *   wasn't one to close
 */
export interface NodeConnection {
  node: any;
  exec: Function;
  local: boolean;
  disconnect: () => Promise<void>;
}

/**
 * Connect to a node.
 *
 * @param config
 * @param nodeName
 * @returns
 */
export async function connectToNode(
  config: CloudConfig,
  nodeName: string,
): Promise<NodeConnection> {
  const node = config.getNode(nodeName);
  if (node === null) {
    throw new Error(
      `Couldn't find node "${nodeName}" in the specified configuration. Was the name misspelled?`,
    );
  }

  // Don't use SSH if we're running directly on the host already
  if (isThisMachine(node)) {
    return {
      node,
      exec,
      local: true,
      disconnect: async () => {},
    };
  }

  const options: RemoteHostOptions = {
    host: node.address,
    username: node.username,
    keyFile: node.keyFile,
    port: node.port,
  };

  const host = new RemoteHost(options);
  await host.connect();

  return {
    node,
    exec: (command: string) => host.exec(command),
    local: false,
    disconnect: () => host.disconnect(),
  };
}

/**
 * Whether a node is the machine this is running on.
 *
 * A node answers to its name or its address, so either one matching
 * the hostname means there's nothing to connect to.
 *
 * @param node
 * @returns
 */
function isThisMachine(node: any): boolean {
  const hostname = os.hostname().toLowerCase();
  const shortName = hostname.split(".")[0];

  return [node.name, node.address].some((candidate) => {
    if (typeof candidate !== "string") {
      return false;
    }

    const value = candidate.toLowerCase();
    return value === hostname || value === shortName;
  });
}

/**
 * Connect to the cluster's control plane.
 *
 * When the node we're already on is the control plane the same
 * connection is handed back, so nothing opens a second session to a
 * machine it's already talking to. Callers can tell by comparing the
 * result with what they passed in.
 *
 * @param config
 * @param target the connection to the node the work is aimed at
 * @returns
 */
export async function connectToControlPlane(
  config: CloudConfig,
  target: NodeConnection,
): Promise<NodeConnection> {
  let controlPlane = undefined;
  try {
    controlPlane = config.getControlPlaneHost();
  } catch {
    controlPlane = undefined;
  }

  if (controlPlane === undefined) {
    throw new Error(
      'This needs a control plane to run against, and the configuration has no node with a type of "server".',
    );
  }

  if (isSameNode(controlPlane, target.node)) {
    return target;
  }

  return connectToNode(config, controlPlane.name);
}

/**
 * Whether two node entries describe the same machine.
 *
 * Only the name counts. An address is how a node is reached, not what
 * it is, and two nodes can share one: a pair of machines behind the
 * same bastion or port forward both read as 127.0.0.1 and differ only
 * in the port or the user. Matching on that would quietly send a
 * command to the wrong node.
 *
 * @param one
 * @param other
 * @returns
 */
function isSameNode(one: any, other: any): boolean {
  if (one === undefined || other === undefined || one === null || other === null) {
    return false;
  }

  return (
    typeof one.name === "string" &&
    typeof other.name === "string" &&
    one.name.toLowerCase() === other.name.toLowerCase()
  );
}
