/**
 * @file
 * What Community Cloud considers a real network interface.
 *
 * Three places needed this and each had its own answer: Cilium's
 * values said "enp+,eth+,defined+", the gateway's announcement policy
 * said "^en[a-z0-9]+" and "^eth[0-9]+", and the interface reader said
 * "enp|wlp|tailscale". A node on onboard ethernet was a real interface
 * to one of them and invisible to the others, which is the kind of
 * disagreement that shows up as a cluster that mostly works.
 *
 * So the names live here once, and each place renders them into
 * whatever syntax it needs.
 *
 * The distinction that matters is between an interface on a network
 * and an interface into a tunnel. Both carry traffic between nodes, so
 * Cilium's datapath wants both. Only the first is somewhere ARP means
 * anything, so a gateway announcing an address wants only those: there
 * is no one to answer on a point to point tunnel.
 */

/**
 * What kind of thing an interface is.
 */
export enum InterfaceKind {
  // On a network, where a neighbour can be asked who holds an address
  Local = "local",

  // A tunnel to the rest of the cluster
  Mesh = "mesh",
}

/**
 * A family of interface names.
 *
 * Linux names physical interfaces by how they're attached — "enp3s0"
 * for a PCI ethernet card, "eno1" for one on the board — and falls
 * back to the old "eth0" when it can't. A prefix covers a family.
 */
export interface InterfaceClass {
  prefix: string;
  kind: InterfaceKind;
  description: string;
}

export const INTERFACE_CLASSES: InterfaceClass[] = [
  {
    prefix: "enp",
    kind: InterfaceKind.Local,
    description: "Wired, named after where it sits on the bus",
  },
  {
    prefix: "eno",
    kind: InterfaceKind.Local,
    description: "Wired, onboard",
  },
  {
    prefix: "ens",
    kind: InterfaceKind.Local,
    description: "Wired, named by a slot index",
  },
  {
    prefix: "eth",
    kind: InterfaceKind.Local,
    description: "Wired, the old unpredictable name. Most virtual machines.",
  },
  {
    prefix: "wlp",
    kind: InterfaceKind.Local,
    description: "Wireless",
  },
  {
    prefix: "wlan",
    kind: InterfaceKind.Local,
    description: "Wireless, the old unpredictable name",
  },
  {
    prefix: "defined",
    kind: InterfaceKind.Mesh,
    description: "The Nebula mesh, from Defined Networking",
  },
  {
    prefix: "tailscale",
    kind: InterfaceKind.Mesh,
    description: "Tailscale",
  },
];

/**
 * The classes of a given kind, or all of them.
 *
 * @param kind
 * @returns
 */
export function getInterfaceClasses(kind?: InterfaceKind): InterfaceClass[] {
  return kind === undefined
    ? INTERFACE_CLASSES
    : INTERFACE_CLASSES.filter((entry) => entry.kind === kind);
}

/**
 * Whether an interface is one we treat as carrying traffic.
 *
 * @param name the interface name, e.g. "enp3s0"
 * @param kind restrict to one kind, or accept any
 * @returns
 */
export function isKnownInterface(name: string, kind?: InterfaceKind): boolean {
  return getInterfaceClasses(kind).some((entry) => name.startsWith(entry.prefix));
}

/**
 * Which class an interface belongs to, if any.
 *
 * Longest prefix first, so "enp3s0" isn't claimed by a shorter name
 * that happens to start the same way.
 *
 * @param name
 * @returns
 */
export function getInterfaceClass(name: string): InterfaceClass | undefined {
  return [...INTERFACE_CLASSES]
    .sort((one, other) => other.prefix.length - one.prefix.length)
    .find((entry) => name.startsWith(entry.prefix));
}

/**
 * The names as regular expressions, which is how the Cilium L2
 * announcement policy asks for interfaces.
 *
 * @param kind
 * @returns
 */
export function asRegularExpressions(kind?: InterfaceKind): string[] {
  return getInterfaceClasses(kind).map((entry) => `^${entry.prefix}`);
}

/**
 * The names as Cilium's own device patterns, where a trailing "+"
 * means "and anything after this".
 *
 * @param kind
 * @returns
 */
export function asCiliumDevices(kind?: InterfaceKind): string {
  return getInterfaceClasses(kind)
    .map((entry) => `${entry.prefix}+`)
    .join(",");
}
