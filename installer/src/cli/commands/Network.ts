/**
 * @file
 * What a node's networking actually looks like.
 *
 * Everything else in here decides what a node's networking should be —
 * the congestion control it runs, the addresses it answers for — and
 * all of it is written against a picture of the node that nobody ever
 * checks. This is the part that goes and looks.
 *
 * It matters most for the gateway. The two ways into a cluster both
 * rest on an assumption about an interface: that a floating address is
 * on one, or that a gateway node has one on the LAN to answer ARP on.
 * Neither fails loudly when it's wrong. The address is handed out, the
 * Service reports it, everything says it worked, and the traffic goes
 * nowhere. Reading the interfaces is how that becomes a sentence
 * instead of a mystery.
 *
 * Requires:
 * - iproute2, which is on any Linux that can run K3s
 */
import {
  CommandOutput,
  CommandPurpose,
  CommandSpec,
  OutputType,
} from "./Command.ts";
import {
  InterfaceKind,
  getInterfaceClass,
  isKnownInterface,
} from "../../util/interfaces.ts";

/**
 * One address on an interface, as "ip -j addr" reports it.
 */
export interface InterfaceAddress {
  family: string;
  local: string;
  prefixlen: number;
  scope: string;

  broadcast?: string;
  dynamic?: boolean;
  temporary?: boolean;
  noprefixroute?: boolean;
}

/**
 * One interface, as "ip -j addr" reports it. Only the fields anything
 * here reads are named; the command returns a good deal more.
 */
export interface NetworkInterface {
  ifindex: number;
  ifname: string;
  flags: string[];
  mtu: number;
  operstate: string;
  addr_info: InterfaceAddress[];

  qdisc?: string;
  address?: string;
  link_type?: string;
}

/**
 * An interface as this installer thinks of it: the name, what kind of
 * thing it is, and the addresses on it.
 */
export interface NodeInterface {
  name: string;
  kind: InterfaceKind;
  up: boolean;
  addresses: string[];
}

/**
 * The name of the command which reads a node's interfaces. Exported so
 * a bundle including it can find the result.
 */
export const READ_INTERFACES_COMMAND = "read-network-interfaces";

/**
 * Whether an interface is worth considering at all.
 *
 * Loopback, bridges, and the virtual interfaces a container runtime
 * leaves lying around are all real interfaces and none of them is a
 * way in or out of the node.
 *
 * @param entry
 * @returns
 */
function isUsable(entry: NetworkInterface): boolean {
  return (
    typeof entry.ifname === "string" &&
    !entry.flags?.includes("LOOPBACK") &&
    isKnownInterface(entry.ifname)
  );
}

/**
 * The addresses on an interface.
 *
 * Only global ones: a link-local address is reachable from exactly one
 * cable away and is never what something outside connects to.
 *
 * @param entry
 * @returns
 */
function getAddresses(entry: NetworkInterface): string[] {
  return (Array.isArray(entry.addr_info) ? entry.addr_info : [])
    .filter((address) => address.scope === "global")
    .map((address) => address.local)
    .filter((address) => typeof address === "string" && address !== "");
}

/**
 * Turn what "ip" said into what we want to know.
 *
 * @param interfaces
 * @returns
 */
export function readInterfaces(interfaces: NetworkInterface[]): NodeInterface[] {
  return (Array.isArray(interfaces) ? interfaces : [])
    .filter(isUsable)
    .map((entry) => {
      const entryClass = getInterfaceClass(entry.ifname);

      return {
        name: entry.ifname,
        kind: entryClass !== undefined ? entryClass.kind : InterfaceKind.Local,
        up: entry.operstate === "UP" || entry.flags?.includes("UP") === true,
        addresses: getAddresses(entry),
      };
    });
}

/**
 * The interfaces of one kind.
 *
 * @param interfaces
 * @param kind
 * @returns
 */
export function getInterfacesOfKind(
  interfaces: NodeInterface[],
  kind: InterfaceKind,
): NodeInterface[] {
  return interfaces.filter((entry) => entry.kind === kind);
}

/**
 * The interfaces holding a given address.
 *
 * @param interfaces
 * @param address
 * @returns
 */
export function findInterfacesHolding(
  interfaces: NodeInterface[],
  address: string,
): NodeInterface[] {
  return interfaces.filter((entry) => entry.addresses.includes(address));
}

/**
 * Every address the node holds.
 *
 * @param interfaces
 * @returns
 */
export function getNodeAddresses(interfaces: NodeInterface[]): string[] {
  return [...new Set(interfaces.flatMap((entry) => entry.addresses))];
}

/**
 * The interfaces a set of regular expressions matches.
 *
 * This is how the Cilium announcement policy selects what to answer
 * ARP on, so asking the same question here is how we find out whether
 * a configured pattern matches anything on the node it's aimed at.
 *
 * @param interfaces
 * @param patterns
 * @returns
 */
export function matchInterfaces(
  interfaces: NodeInterface[],
  patterns: string[],
): NodeInterface[] {
  const expressions = patterns.map((pattern) => new RegExp(pattern));

  return interfaces.filter((entry) =>
    expressions.some((expression) => expression.test(entry.name)),
  );
}

/**
 * Read the node's interfaces.
 *
 * JSON from "ip" rather than parsing its usual output, which is meant
 * for people and changes shape depending on what it's describing.
 */
export const readInterfacesCommand: CommandSpec = {
  name: READ_INTERFACES_COMMAND,
  description: "Read the node's network interfaces and their addresses",
  purpose: CommandPurpose.Inspect,
  command: 'ip -j addr show || { echo "Couldn\'t read the network interfaces. Is iproute2 installed?" >&2; exit 1; }',
  output: OutputType.Json,
  postProcessHooks: [(output: CommandOutput) => readInterfaces(output.parsed)],
  saveToContext: (output: any) => {
    const interfaces: NodeInterface[] = output.processed;

    for (const entry of interfaces) {
      const addresses = entry.addresses.length > 0 ? entry.addresses.join(", ") : "no addresses";
      console.log(`  ${entry.name} (${entry.kind}${entry.up ? "" : ", down"}): ${addresses}`);
    }

    if (interfaces.length === 0) {
      console.log("  No interfaces this recognises as carrying traffic.");
    }

    return {
      nodeInterfaces: interfaces,
      nodeAddresses: getNodeAddresses(interfaces),
    };
  },
};

/**
 * The interfaces an earlier command found, if one ran.
 *
 * @param context
 * @returns
 */
export function getContextInterfaces(context: any): NodeInterface[] {
  const interfaces = context.nodeInterfaces;
  return Array.isArray(interfaces) ? interfaces : [];
}
