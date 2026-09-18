/**
 * @file
 * Every node in the cluster, connected and ready to be worked on.
 *
 * A multi-node install opens one connection per node and keeps it for
 * the whole run. That matters more than it sounds: SSH handshakes are
 * slow, an install is dozens of steps, and reconnecting per step would
 * spend most of the run negotiating rather than working.
 *
 * Connecting is also the first thing that can go wrong, and it is much
 * better to find out that one machine is unreachable before anything
 * has been changed on the other five. So the whole fleet is raised at
 * once, up front, and a failure there stops the run having done
 * nothing.
 */
import CloudConfig from "../util/CloudConfig.ts";
import { K3SInstallationType } from "../util/types.ts";
import { NodeConnection, connectToNode } from "../runners/nodeConnection.ts";

/**
 * One node, and how to reach it.
 */
export interface FleetMember {
  name: string;
  node: any;
  connection: NodeConnection;

  // Whether this node runs a K3s server, and so can be asked to do
  // something on the cluster's behalf
  isServer: boolean;
}

/**
 * Why a node couldn't be reached.
 */
export interface FleetFailure {
  name: string;
  why: string;

  // Whether the node couldn't be reached, was reached and turned out
  // to be a machine another node is already using, or the cluster
  // this work needs has no server to run it from. The three want
  // different words said about them.
  kind: "unreachable" | "duplicate" | "no-control-plane";
}

/**
 * The nodes of a cluster, connected.
 */
export class Fleet {
  readonly members: FleetMember[];

  // A server that isn't one of the targets, connected only because
  // something here has to talk to the cluster.
  //
  // Running one bundle against one agent is the case this exists for.
  // The agent has no kubeconfig, so anything cluster-facing in that
  // bundle — labelling the node, asking whether it joined — has to be
  // run from a server, and that server is not part of what was asked
  // for. It is reachable through this fleet and is not one of its
  // nodes: it never appears in names(), never counts as an agent or a
  // server for scoping, and so never has a step run on its behalf.
  readonly borrowed?: FleetMember;

  constructor(members: FleetMember[], borrowed?: FleetMember) {
    this.members = members;
    this.borrowed = borrowed;
  }

  /**
   * Every node's name, in configuration order.
   *
   * @returns
   */
  names(): string[] {
    return this.members.map((member) => member.name);
  }

  /**
   * One node by name.
   *
   * @param name
   * @returns
   */
  get(name: string): FleetMember | undefined {
    const member = this.members.find((entry) => entry.name === name);

    if (member !== undefined) {
      return member;
    }

    // A cluster-wide step is attributed to the node it runs from, and
    // that node may be the borrowed one
    return this.borrowed?.name === name ? this.borrowed : undefined;
  }

  /**
   * The nodes that run a server.
   *
   * @returns
   */
  servers(): FleetMember[] {
    return this.members.filter((member) => member.isServer);
  }

  /**
   * The nodes that run an agent.
   *
   * @returns
   */
  agents(): FleetMember[] {
    return this.members.filter((member) => !member.isServer);
  }

  /**
   * The node anything cluster-wide is run from.
   *
   * Any server will do — they all talk to the same API — so this takes
   * the first of the targets, falls back to the borrowed one, and says
   * so plainly when there is neither.
   *
   * @returns
   */
  controlPlane(): FleetMember {
    const server = this.servers()[0] ?? this.borrowed;

    if (server === undefined) {
      throw new Error(
        "None of these nodes is a server, and the configuration names none either, so there's nothing to run the cluster's own work on. One node needs \"type\": \"server\".",
      );
    }

    return server;
  }

  /**
   * Whether there is a server to run cluster work on.
   *
   * @returns
   */
  hasControlPlane(): boolean {
    return this.servers().length > 0 || this.borrowed !== undefined;
  }

  /**
   * Close every connection.
   *
   * Every one is attempted even when an earlier one fails: an open SSH
   * session keeps the process alive, so a connection left behind turns
   * the end of a run into a hang.
   */
  async disconnect() {
    const connections = [
      ...this.members,
      ...(this.borrowed !== undefined ? [this.borrowed] : []),
    ];

    await Promise.allSettled(
      connections.map((member) => member.connection.disconnect()),
    );
  }
}

/**
 * Whether a node's configuration says it runs a server.
 *
 * @param node
 * @returns
 */
export function isServerNode(node: any): boolean {
  return node?.type === K3SInstallationType.Server;
}

/**
 * Connect to every node named.
 *
 * Connections are opened together rather than one after another, so a
 * cluster of ten machines takes about as long to reach as one does. A
 * node that can't be reached doesn't stop the others being tried —
 * knowing that three of ten are unreachable is a great deal more
 * useful than being told about the first.
 *
 * @param config
 * @param names the nodes to raise
 * @param options
 * @returns the fleet, and anything that couldn't be reached
 */
export async function raiseFleet(
  config: CloudConfig,
  names: string[],
  options: RaiseOptions = {},
): Promise<{ fleet: Fleet; failures: FleetFailure[] }> {
  const attempts = await Promise.allSettled(
    names.map((name) => connectMember(config, name, options)),
  );

  const members: FleetMember[] = [];
  const failures: FleetFailure[] = [];

  for (const [index, attempt] of attempts.entries()) {
    if (attempt.status === "fulfilled") {
      members.push(attempt.value);
      continue;
    }

    failures.push({
      name: names[index]!,
      kind: "unreachable",
      why: attempt.reason?.message ?? String(attempt.reason),
    });
  }

  // A run that has to talk to the cluster needs a server, and the
  // nodes it was asked about might not include one
  let borrowed: FleetMember | undefined = undefined;

  if (options.controlPlane === true && !members.some((member) => member.isServer)) {
    try {
      borrowed = await connectControlPlane(config, options);
    } catch (error: any) {
      failures.push({
        name: "control plane",
        kind: "no-control-plane",
        why: error.message,
      });
    }
  }

  // Anything already open is closed before the failure is reported,
  // rather than being left behind holding the process open
  if (failures.length > 0 && options.partial !== true) {
    await new Fleet(members, borrowed).disconnect();
    return { fleet: new Fleet([]), failures };
  }

  const fleet = new Fleet(members, borrowed);
  const duplicates = await findDuplicates(fleet);

  if (duplicates.length > 0) {
    const reported = duplicates.map((names) => ({
      name: names.join(" and "),
      kind: "duplicate" as const,
      why: `these are configured as different nodes and are the same machine. Every step would run on it twice and the other node would never be touched, so nothing was run. Check "address", "username" and "port" on each of them, and what ~/.ssh/config resolves those to.`,
    }));

    // Something read-only carries on and says so: two entries pointing
    // at one machine is exactly the sort of thing a person runs the
    // doctor to find out. Anything that changes a node stops.
    if (options.partial !== true) {
      await fleet.disconnect();
      return { fleet: new Fleet([]), failures: reported };
    }

    failures.push(...reported);
  }

  return { fleet, failures };
}

/**
 * How a fleet should be raised.
 *
 * - timeout: how long to give a node to answer, in milliseconds
 * - controlPlane: make sure a server is reachable even when none of
 *   the nodes asked for is one. What a bundle needs depends on the
 *   commands in it, so the caller works this out from the plan.
 * - partial: report what couldn't be reached and carry on with the
 *   rest, rather than refusing to run. For the read-only commands: a
 *   cluster with one node down is the case you most want a report
 *   about, and the least useful answer is nothing at all.
 */
export interface RaiseOptions {
  timeout?: number;
  controlPlane?: boolean;
  partial?: boolean;
}

/**
 * Connect to one node and describe it.
 *
 * @param config
 * @param name
 * @param options
 * @returns
 */
async function connectMember(
  config: CloudConfig,
  name: string,
  options: RaiseOptions,
): Promise<FleetMember> {
  const connection = await connectToNode(config, name, { timeout: options.timeout });

  return {
    name,
    node: connection.node,
    connection,
    isServer: isServerNode(connection.node),
  };
}

/**
 * Connect to a server named in the configuration but not asked for.
 *
 * @param config
 * @param options
 * @returns
 */
async function connectControlPlane(
  config: CloudConfig,
  options: RaiseOptions,
): Promise<FleetMember> {
  const node = config.getControlPlaneHost();

  if (node === undefined || node === null) {
    throw new Error(
      'this needs to talk to the cluster, and the configuration has no node with a type of "server" to talk to it from.',
    );
  }

  try {
    return await connectMember(config, node.name, options);
  } catch (error: any) {
    throw new Error(
      `this needs to talk to the cluster and ${node.name}, the only server in the configuration, couldn't be reached: ${error.message}`,
    );
  }
}

/**
 * Say what stopped a fleet being raised, in a way somebody can act on.
 *
 * @param failures
 * @param names the nodes that were asked for
 * @param what the word for what didn't happen, e.g. "installed"
 * @returns
 */
export function describeFleetFailures(
  failures: FleetFailure[],
  names: string[],
  what: string,
): string {
  const unreachable = failures.filter((failure) => failure.kind === "unreachable");

  const headline =
    unreachable.length > 0
      ? `Couldn't reach ${unreachable.length} of ${names.length} node${names.length === 1 ? "" : "s"}`
      : failures.some((failure) => failure.kind === "no-control-plane")
        ? "There's no control plane to run this against"
        : "This configuration doesn't describe the cluster it says it does";

  return `${headline}, so nothing was ${what}:\n${failures
    .map((failure) => `  ${failure.name}: ${failure.why}`)
    .join("\n")}`;
}

/**
 * Nodes that are configured separately and turn out to be the same
 * machine.
 *
 * This is worth a round trip per node because the failure it catches
 * is silent and total: a fleet where two entries point at one host
 * does every step on that host twice and never touches the node
 * everybody thinks is being installed. It is an easy mistake — a
 * copied block with the address changed and the port left alone, a
 * username that overrides what ssh config would have resolved — and
 * without this the first sign of it is a cluster that is missing a
 * node nobody can account for.
 *
 * The machine ID is what Linux already keeps for exactly this
 * question. A node that hasn't got one answers with its hostname
 * instead, which is weaker and better than nothing.
 *
 * @param fleet
 * @returns groups of names that share a machine
 */
async function findDuplicates(fleet: Fleet): Promise<string[][]> {
  const identities = await Promise.all(
    fleet.members.map(async (member) => {
      try {
        const result: any = await member.connection.exec(
          "cat /etc/machine-id 2>/dev/null || hostname",
        );

        return { name: member.name, id: String(result?.stdout ?? "").trim() };
      } catch {
        // A node that won't answer is not this check's problem: the
        // steps that follow will say so with a great deal more detail
        return { name: member.name, id: "" };
      }
    }),
  );

  const byIdentity = new Map<string, string[]>();

  for (const { name, id } of identities) {
    if (id === "") {
      continue;
    }

    byIdentity.set(id, [...(byIdentity.get(id) ?? []), name]);
  }

  return [...byIdentity.values()].filter((names) => names.length > 1);
}

/**
 * A fleet on paper: the nodes a configuration describes, with nothing
 * connected to.
 *
 * Planning only needs to know which nodes exist and which are servers,
 * both of which the configuration says. Building a plan without
 * opening a single connection is what makes a dry run genuinely dry —
 * it can be run against a cluster that isn't built yet, from a laptop
 * that can't reach any of it.
 *
 * @param config
 * @param names
 * @returns
 */
export function paperFleet(config: CloudConfig, names: string[]): Fleet {
  const members = names.map((name) => paperMember(config.getNode(name), name));

  // The same borrowing a real run would do, so a dry run against one
  // agent plans the cluster-facing steps rather than refusing
  const server = config.getControlPlaneHost();
  const borrowed =
    !members.some((member) => member.isServer) && server !== undefined && server !== null
      ? paperMember(server, server.name)
      : undefined;

  return new Fleet(members, borrowed);
}

/**
 * One node of a paper fleet.
 *
 * @param node
 * @param name
 * @returns
 */
function paperMember(node: any, name: string): FleetMember {
  return {
    name,
    node,
    isServer: isServerNode(node),
    connection: {
      node,
      local: false,
      exec: () => {
        throw new Error(
          `Nothing is connected to ${name}. This fleet was built for planning.`,
        );
      },
      disconnect: async () => {},
    },
  };
}

/**
 * The nodes a run should cover.
 *
 * "all" is every node in the configuration; anything else is one node
 * by name, which is what makes a single node an ordinary fleet of one
 * rather than a separate code path.
 *
 * @param config
 * @param target a node name, or "all"
 * @returns
 */
export function resolveTarget(config: CloudConfig, target: string): string[] {
  const nodes = config.getConfig().nodes;
  const all = Array.isArray(nodes) ? nodes : [];

  if (target === ALL_NODES) {
    if (all.length === 0) {
      throw new Error("This configuration has no nodes in it, so there's nothing to install onto.");
    }

    return all.map((node: any) => node.name);
  }

  const found = all.find((node: any) => node.name === target);

  if (found === undefined) {
    throw new Error(
      `Couldn't find a node called "${target}" in the configuration. It has: ${all.map((node: any) => node.name).join(", ") || "no nodes at all"}. Use "${ALL_NODES}" to run against every node.`,
    );
  }

  return [target];
}

// What to write instead of a node name to mean every node
export const ALL_NODES = "all";
