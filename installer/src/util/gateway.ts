/**
 * @file
 * The addresses the cluster is reached on, read from the configuration.
 *
 * Two things are built from them and have to agree: Cilium's address
 * pool, which the gateway bundle applies, and the cluster Gateway,
 * which listens on them. They're read here so that the pool's bundle
 * and the template values for the Gateway's manifest come from the
 * same answer. Kept out of the gateway bundle itself because the
 * template code needs them, and the bundle needs the template code.
 */
import CloudConfig from "./CloudConfig.ts";
import { GatewayMode, NodeRole } from "./types.ts";

/**
 * The gateway section of a Community Cloud configuration.
 *
 * - mode: which of the two shapes above this cluster is. Worked out
 *   from the addresses when it isn't given.
 * - addresses: what a LoadBalancer Service may be given. Single
 *   addresses, CIDRs, or "first-last" ranges.
 * - interfaces: port-forward only, the interfaces to answer ARP on as
 *   regular expressions
 * - name: what to call the pool and the policy, for a cluster that
 *   wants more than one or has its own naming
 */
export interface GatewayConfiguration {
  mode?: GatewayMode;
  addresses?: string[];
  interfaces?: string[];
  name?: string;
}

/**
 * One range of addresses a Service can be given.
 *
 * Cilium takes either a CIDR or a first and last address, so a single
 * address is written as a CIDR covering only itself.
 */
export interface AddressBlock {
  cidr?: string;
  start?: string;
  stop?: string;
}

/**
 * Read the gateway section of the configuration.
 *
 * @param config
 * @returns
 */
export function getGatewayConfig(config: CloudConfig): GatewayConfiguration {
  return config.getNetworkSection("gateway");
}

/**
 * Addresses a particular node holds, from "network.externalIPs".
 *
 * This is the floating case written per node: the configuration says
 * which machine the provider routes an address to. The addresses end
 * up in the same pool either way, and knowing whose they are is what
 * lets us say so when one is pinned to a node that isn't a gateway.
 *
 * @param config
 * @returns
 */
export function getNodeAddresses(config: CloudConfig): Record<string, string[]> {
  const external = config.getNetworkSection("externalIPs");

  const addresses: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(external)) {
    const list = Array.isArray(value) ? value : [value];
    const usable = list.filter((entry): entry is string => typeof entry === "string" && entry !== "");

    if (usable.length > 0) {
      addresses[name] = usable;
    }
  }

  return addresses;
}

/**
 * The nodes that have a way out.
 *
 * Either said outright with "gateway": true, or by giving the node the
 * gateway role. Both mean the same thing, and a configuration written
 * either way should work.
 *
 * @param config
 * @returns
 */
export function getGatewayNodes(config: CloudConfig): any[] {
  const { nodes } = config.getConfig();

  return (Array.isArray(nodes) ? nodes : []).filter((node: any) => {
    if (node.gateway === true) {
      return true;
    }

    return Array.isArray(node.roles) && node.roles.includes(NodeRole.Gateway);
  });
}

/**
 * Every address that should end up in the pool.
 *
 * @param config
 * @returns
 */
export function getAddresses(config: CloudConfig): string[] {
  const { addresses } = getGatewayConfig(config);

  const configured = Array.isArray(addresses) ? addresses : [];
  const perNode = Object.values(getNodeAddresses(config)).flat();

  return [...new Set([...configured, ...perNode])];
}

/**
 * Whether there's anything to do at all.
 *
 * A cluster that nothing reaches from outside is a perfectly ordinary
 * cluster — a private one, or one still being built — so this stands
 * down rather than complaining.
 *
 * @param config
 * @returns
 */
export function hasGateway(config: CloudConfig): boolean {
  return getAddresses(config).length > 0 && getGatewayNodes(config).length > 0;
}

// What an address looks like. Deliberately loose about the contents of
// an IPv6 address, since the point is to tell the three forms apart
// and hand the rest to Cilium, which has a real parser.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

/**
 * Turn a configured address into a block Cilium understands.
 *
 * @param address
 * @returns
 */
export function parseAddress(address: string): AddressBlock {
  const value = address.trim();

  // A range, written the way people write one
  if (value.includes("-")) {
    const [start, stop] = value.split("-").map((part) => part.trim());

    if (start === undefined || stop === undefined || start === "" || stop === "") {
      throw new Error(
        `The gateway address range "${address}" is missing one of its ends. Expected something like "192.168.1.240-192.168.1.250".`,
      );
    }

    checkAddress(start, address);
    checkAddress(stop, address);

    return { start, stop };
  }

  // A CIDR, passed through as it is
  if (value.includes("/")) {
    const [network] = value.split("/");
    checkAddress(network !== undefined ? network : "", address);
    return { cidr: value };
  }

  // A single address, as the smallest CIDR that holds it. Cilium takes
  // a bare start on its own, but a prefix covering one address says
  // the same thing with nothing left to interpret.
  checkAddress(value, address);
  return { cidr: `${value}/${IPV4.test(value) ? 32 : 128}` };
}

/**
 * Check something is recognisably an address.
 *
 * @param value
 * @param address the whole entry, for saying where the problem is
 */
function checkAddress(value: string, address: string) {
  if (IPV4.test(value)) {
    const octets = value.split(".").map(Number);
    if (octets.every((octet) => octet <= 255)) {
      return;
    }
  }
  else if (IPV6.test(value) && value.includes(":")) {
    return;
  }

  throw new Error(
    `"${address}" isn't an address this understands. Expected an address, a CIDR, or a "first-last" range, e.g. "203.0.113.10", "203.0.113.0/29" or "192.168.1.240-192.168.1.250".`,
  );
}

/**
 * The addresses the cluster Gateway listens on.
 *
 * Every configured address that is exactly one address: a bare one, a
 * /32 or /128, or a range that starts and stops in the same place.
 * Those were chosen one at a time, so they're taken as ways in. A
 * CIDR or a range covering several is a pool for Cilium to choose
 * from, and putting all of it on the Gateway would take every address
 * from any other LoadBalancer Service. When nothing is a single
 * address the Gateway names none, and Cilium gives it one from the
 * pool, as it always has.
 *
 * Nothing when there's no gateway, because the pool isn't made then,
 * and a Gateway asking for an address that isn't in a pool is marked
 * as not programmed.
 *
 * @param config
 * @returns
 */
export function getListenAddresses(config: CloudConfig): string[] {
  if (!hasGateway(config)) {
    return [];
  }

  const single = getAddresses(config).flatMap((address) => {
    const block = parseAddress(address);

    if (block.cidr !== undefined) {
      const [network, prefix] = block.cidr.split("/");
      const whole = network !== undefined && IPV4.test(network) ? "32" : "128";
      return prefix === whole && network !== undefined ? [network] : [];
    }

    return block.start !== undefined && block.start === block.stop ? [block.start] : [];
  });

  return [...new Set(single)];
}
