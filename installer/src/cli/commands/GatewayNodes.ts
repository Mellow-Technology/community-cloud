/**
 * @file
 * Give the cluster a way in from outside.
 *
 * Everything a Community Cloud cluster serves is reached through the
 * Gateway API, and a Gateway only works once something has given it an
 * address the outside world can connect to. That address comes from a
 * LoadBalancer Service, which in a cluster with no cloud provider
 * means Cilium's own load balancer IP management. This bundle is what
 * sets that up.
 *
 * Two shapes cover nearly every install, and they differ only in who
 * is responsible for getting a packet to a node:
 *
 * - floating: the provider routes an address to a machine and the
 *   machine holds it on an interface. Common in a data centre, where
 *   it's sold as a floating or failover IP. Cilium only has to give
 *   the address to a Service, because the node already answers for it.
 * - port-forward: a router maps ports on its external address to an
 *   address on the LAN. Nothing holds that address, so Cilium claims
 *   it with ARP from a gateway node. Common on a home network.
 *
 * In both cases the addresses go into a CiliumLoadBalancerIPPool. The
 * port-forward case also needs a CiliumL2AnnouncementPolicy, so that a
 * gateway node answers for an address nothing is holding.
 *
 * Which nodes those are comes from the configuration: a node with
 * "gateway": true is one with a way out. They're labelled with the
 * gateway role, which is what the announcement policy selects on and
 * what a workload that has to run near the edge can be scheduled
 * against.
 *
 * The Gateway itself isn't applied here. It's an ordinary manifest
 * with listeners and hostnames in it:
 *
 *   community-cloud run-template embed://networking/gateway/Gateway.yaml cc.config.json
 *
 * Every command runs on the control plane, since all of this is done
 * to the cluster rather than to a node.
 *
 * Requires:
 * - a running cluster with Cilium installed
 * - for port-forward, Cilium installed with l2announcements enabled
 */
import { stringify } from "yaml";

import { CommandOutput, CommandSpec, CommandTarget, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { GatewayMode, NodeRole } from "../../util/types.ts";
import { ROLE_PREFIX, buildKubeEnv } from "../../util/kube.ts";
import { quoteForShell } from "../../util/shell.ts";
import { getNodeName } from "./K3s.ts";

// What the pool and the policy are called when the configuration
// doesn't say. One name for both, since they describe one thing.
const DEFAULT_NAME = "community-cloud-gateway";

// The GatewayClass Cilium registers. Its presence is how we know the
// Gateway API support is actually switched on rather than merely
// installed.
const GATEWAY_CLASS = "cilium";

// Where Cilium keeps the settings it was installed with. Read rather
// than the CLI, so this works on a node that only has kubectl.
const CILIUM_CONFIGMAP = "cilium-config";
const CILIUM_NAMESPACE = "kube-system";

// The interfaces to answer ARP on when the configuration doesn't name
// any. These are the predictable and unpredictable names Linux gives
// physical interfaces, which is what a gateway's LAN side is.
const DEFAULT_INTERFACES = ["^en[a-z0-9]+", "^eth[0-9]+"];

// How long to wait for the pool to be accepted and report addresses
const POOL_TIMEOUT_SECONDS = 60;

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
interface GatewayConfiguration {
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
interface AddressBlock {
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
function getGatewayConfig(config: CloudConfig): GatewayConfiguration {
  const { network } = config.getConfig();
  const gateway =
    network !== undefined && network !== null ? network.gateway : undefined;

  return gateway !== undefined && gateway !== null ? gateway : {};
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
function getNodeAddresses(config: CloudConfig): Record<string, string[]> {
  const { network } = config.getConfig();
  const external =
    network !== undefined && network !== null ? network.externalIPs : undefined;

  if (external === undefined || external === null) {
    return {};
  }

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
function getGatewayNodes(config: CloudConfig): any[] {
  const { nodes } = config.getConfig();

  return (Array.isArray(nodes) ? nodes : []).filter((node: any) => {
    if (node.gateway === true) {
      return true;
    }

    return Array.isArray(node.roles) && node.roles.includes(NodeRole.Gateway);
  });
}

/**
 * What a node is called in the cluster.
 *
 * The same derivation K3s registers a node under, so the name used
 * here is the one the API server knows.
 *
 * @param node
 * @returns
 */
function getClusterName(node: any): string {
  const name = getNodeName({ node });

  if (name === undefined) {
    throw new Error(
      `Couldn't work out what the gateway node "${node.name}" is called in the cluster. Give it a name or address that can be a DNS label, or set "nodeName" on it.`,
    );
  }

  return name;
}

/**
 * Every address that should end up in the pool.
 *
 * @param config
 * @returns
 */
function getAddresses(config: CloudConfig): string[] {
  const { addresses } = getGatewayConfig(config);

  const configured = Array.isArray(addresses) ? addresses : [];
  const perNode = Object.values(getNodeAddresses(config)).flat();

  return [...new Set([...configured, ...perNode])];
}

/**
 * Which shape this cluster is.
 *
 * Said outright when the configuration says it. Otherwise it's the
 * floating case, because an address written against a particular node
 * is one that node already holds, and that's the only thing we can
 * infer without guessing about somebody's router.
 *
 * @param config
 * @returns
 */
function getGatewayMode(config: CloudConfig): GatewayMode {
  const { mode } = getGatewayConfig(config);

  if (mode === undefined) {
    return GatewayMode.Floating;
  }

  const modes = Object.values(GatewayMode);
  if (!modes.includes(mode)) {
    throw new Error(
      `"${mode}" isn't a way into the cluster this knows about. Set "network.gateway.mode" to one of: ${modes.join(", ")}.`,
    );
  }

  return mode;
}

/**
 * Whether Cilium has to announce the addresses itself.
 *
 * @param config
 * @returns
 */
function announcesAddresses(config: CloudConfig): boolean {
  return getGatewayMode(config) === GatewayMode.PortForward;
}

/**
 * What the pool and the policy are called.
 *
 * @param config
 * @returns
 */
function getName(config: CloudConfig): string {
  const { name } = getGatewayConfig(config);
  return name !== undefined && name !== "" ? name : DEFAULT_NAME;
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
function hasGateway(config: CloudConfig): boolean {
  return getAddresses(config).length > 0 && getGatewayNodes(config).length > 0;
}

/**
 * Explain what's missing, when something is.
 *
 * Both halves are needed and each is useless alone, so a configuration
 * with one of them is a mistake worth naming rather than a cluster
 * with no gateway.
 *
 * @param config
 * @returns
 */
function describeGap(config: CloudConfig): string | undefined {
  const addresses = getAddresses(config);
  const nodes = getGatewayNodes(config);

  if (addresses.length === 0 && nodes.length === 0) {
    return 'No gateway is configured. Add addresses under "network.gateway.addresses" and mark at least one node with "gateway": true.';
  }

  if (addresses.length === 0) {
    return `${nodes.length} node${nodes.length === 1 ? " is" : "s are"} marked as a gateway, but there are no addresses to hand out. Add them under "network.gateway.addresses", or under "network.externalIPs" for an address a particular node holds.`;
  }

  if (nodes.length === 0) {
    return 'There are gateway addresses configured, but no node is marked as a gateway. Set "gateway": true on the nodes that can be reached from outside.';
  }

  return undefined;
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
function parseAddress(address: string): AddressBlock {
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
 * The addresses, as the blocks that go into the pool.
 *
 * @param config
 * @returns
 */
function buildAddressBlocks(config: CloudConfig): AddressBlock[] {
  return getAddresses(config).map(parseAddress);
}

/**
 * The pool that gives a LoadBalancer Service its address.
 *
 * Without one of these a Service of type LoadBalancer sits at
 * <pending> forever, and so does every Gateway in the cluster.
 *
 * @param config
 * @returns
 */
export function buildIPPool(config: CloudConfig): string {
  const pool = {
    apiVersion: "cilium.io/v2",
    kind: "CiliumLoadBalancerIPPool",
    metadata: {
      name: getName(config),
      labels: { "app.kubernetes.io/managed-by": "community-cloud" },
    },
    spec: {
      blocks: buildAddressBlocks(config),
    },
  };

  return [
    "# Managed by Community Cloud",
    "# https://docs.cilium.io/en/stable/network/lb-ipam/",
    stringify(pool),
  ].join("\n");
}

/**
 * The policy that makes a gateway node answer for an address.
 *
 * Only for the port-forward case. A router forwards to an address on
 * the LAN that nothing is holding, so somebody has to reply to the ARP
 * request for it, and that somebody should be a node with a way out.
 *
 * @param config
 * @returns
 */
export function buildL2Policy(config: CloudConfig): string {
  const { interfaces } = getGatewayConfig(config);
  const wanted =
    Array.isArray(interfaces) && interfaces.length > 0 ? interfaces : DEFAULT_INTERFACES;

  const policy = {
    apiVersion: "cilium.io/v2alpha1",
    kind: "CiliumL2AnnouncementPolicy",
    metadata: {
      name: getName(config),
      labels: { "app.kubernetes.io/managed-by": "community-cloud" },
    },
    spec: {
      // Only the nodes with a way out. Announcing from a node the
      // router can't reach would black-hole the address.
      nodeSelector: {
        matchLabels: { [`${ROLE_PREFIX}/${NodeRole.Gateway}`]: NodeRole.Gateway },
      },
      interfaces: wanted,
      loadBalancerIPs: true,
      externalIPs: true,
    },
  };

  return [
    "# Managed by Community Cloud",
    "# https://docs.cilium.io/en/stable/network/l2-announcements/",
    stringify(policy),
  ].join("\n");
}

/**
 * Say why there's no GatewayClass, when there isn't one.
 *
 * The addresses are only half of getting in: something still has to
 * turn a Gateway into a listening proxy, and in this cluster that's
 * Cilium. It builds its Gateway API controller once, when the operator
 * starts, out of whatever it finds then — so there are several ways to
 * end up with a pool that works and a Gateway that never gets
 * programmed, and they look identical from the outside.
 *
 * @param found what the check read off the cluster
 * @returns lines to print, most specific cause first
 */
function describeGatewayClass(found: Record<string, string>): string[] {
  const missing = found["gatewayclass"] === "missing";
  const headline = `⚠️  The "${GATEWAY_CLASS}" GatewayClass ${missing ? "doesn't exist" : "hasn't been accepted"}, so a Gateway won't be programmed. The addresses below still work for any other LoadBalancer Service.`;

  if (found["setting.gatewayapi"] !== "true") {
    return [
      headline,
      'Cilium was installed without Gateway API support. Set "gatewayAPI.enabled" in the Cilium values and run the "cilium" bundle again.',
    ];
  }

  if (found["crd.gatewayapi"] !== "present") {
    return [
      headline,
      "The Gateway API resources aren't installed in this cluster, so Cilium had nothing to build a controller from.",
    ];
  }

  // Served is what counts: the kind can exist with the version Cilium
  // wants turned off, which is what a current Gateway API bundle does
  if (found["tlsroute"] !== "true") {
    return [
      headline,
      `Cilium's Gateway API controller needs TLSRoute v1alpha2, and this cluster's Gateway API ${found["tlsroute"] === "missing" ? "doesn't have TLSRoute at all" : "has it but doesn't serve that version"}. The Cilium operator can't start its controller, so it either disables Gateway API or crashes on restart.`,
      'This is what K3s\'s bundled Traefik installs. Disable it with "k3s.disable": ["traefik"] and install a Gateway API release Cilium supports.',
    ];
  }

  if (found["operator"] !== undefined && found["operator"].includes("false")) {
    return [
      headline,
      "The Cilium operator isn't ready, which is where the Gateway API controller runs. Check its logs on the control plane.",
    ];
  }

  return [
    headline,
    "Cilium has Gateway API enabled and the resources are present, so the operator may not have picked them up. Restarting cilium-operator makes it look again.",
  ];
}

/**
 * The number a condition carries, which Cilium puts in its message.
 *
 * @param condition
 * @param fallback
 * @returns
 */
function readCount(condition: any, fallback: string): string {
  const message = condition !== undefined && condition !== null ? condition.message : undefined;
  return typeof message === "string" && message !== "" ? message : fallback;
}

/**
 * Read one of the pool's conditions, whichever name it goes by.
 *
 * @param conditions
 * @param names in the order to try them
 * @returns
 */
function readCondition(conditions: Record<string, any>, ...names: string[]): any {
  for (const name of names) {
    if (conditions[name] !== undefined) {
      return conditions[name];
    }
  }

  return undefined;
}

/**
 * Read a field out of a split line, treating a missing one as empty.
 *
 * @param fields
 * @param index
 * @returns
 */
function field(fields: string[], index: number): string {
  const value = fields[index];
  return value !== undefined ? value : "";
}

/**
 * Split output into non-empty lines.
 *
 * @param output
 * @returns
 */
function readLines(output: CommandOutput): string[] {
  const text = typeof output.parsed === "string" ? output.parsed : output.stdout;

  return (text !== null && text !== undefined ? text : "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export const GatewayCommands: CommandSpec[] = [
  /**
   * Find out whether the cluster can do any of this.
   *
   * The pool and the policy are Cilium's own resources, so a cluster
   * without Cilium, or with a Cilium that was installed without L2
   * announcements, can't be given a gateway. Both show up here with
   * something worth reading rather than as an apply that fails on a
   * missing kind three commands later.
   */
  {
    name: "check-gateway-support",
    description: "Check the cluster can hand out addresses from outside",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      'command -v kubectl > /dev/null 2>&1 || { echo "kubectl isn\'t on the control plane, so the cluster can\'t be configured. Check K3s is installed there." >&2; exit 1; }',
      'kubectl version > /dev/null 2>&1 || { echo "kubectl can\'t reach the cluster. Check the API server is up and KUBECONFIG points at it." >&2; exit 1; }',

      // Cilium's own resources, which only exist once it's installed
      `printf "crd|pool|%s\\n" "$(kubectl get crd ciliumloadbalancerippools.cilium.io > /dev/null 2>&1 && echo present || echo missing)"`,
      `printf "crd|policy|%s\\n" "$(kubectl get crd ciliuml2announcementpolicies.cilium.io > /dev/null 2>&1 && echo present || echo missing)"`,

      // Announcing an address is off by default, and a policy applied
      // to a Cilium without it is accepted and ignored
      `printf "setting|l2|%s\\n" "$(kubectl -n ${CILIUM_NAMESPACE} get configmap ${CILIUM_CONFIGMAP} -o jsonpath='{.data.enable-l2-announcements}' 2>/dev/null || echo unknown)"`,

      // The Gateway API half. A GatewayClass that isn't accepted means
      // a Gateway will never be programmed, whatever address it gets.
      `printf "gatewayclass|%s\\n" "$(kubectl get gatewayclass ${GATEWAY_CLASS} -o jsonpath='{.status.conditions[?(@.type=="Accepted")].status}' 2>/dev/null || echo missing)"`,

      // When there's no GatewayClass these say why. Cilium's operator
      // builds its Gateway API controller once, at startup, from the
      // resources it finds then.
      `printf "setting|gatewayapi|%s\\n" "$(kubectl -n ${CILIUM_NAMESPACE} get configmap ${CILIUM_CONFIGMAP} -o jsonpath='{.data.enable-gateway-api}' 2>/dev/null || echo unknown)"`,
      `printf "crd|gatewayapi|%s\\n" "$(kubectl get crd gatewayclasses.gateway.networking.k8s.io > /dev/null 2>&1 && echo present || echo missing)"`,
      `printf "operator|%s\\n" "$(kubectl -n ${CILIUM_NAMESPACE} get pods -l io.cilium/app=operator -o jsonpath='{.items[*].status.containerStatuses[*].ready}' 2>/dev/null || echo unknown)"`,

      // Cilium's Gateway API controller wants TLSRoute v1alpha2, and a
      // recent Gateway API bundle ships the kind without serving that
      // version. The operator can't build its controller and dies.
      `printf "tlsroute|%s\\n" "$(kubectl get crd tlsroutes.gateway.networking.k8s.io -o jsonpath='{range .spec.versions[?(@.name=="v1alpha2")]}{.served}{end}' 2>/dev/null || echo missing)"`,
    ],
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => {
        const found: Record<string, string> = {};

        for (const line of readLines(output)) {
          const fields = line.split("|");

          if (fields[0] === "crd" || fields[0] === "setting") {
            found[`${field(fields, 0)}.${field(fields, 1)}`] = field(fields, 2);
          }
          else if (fields[0] === "gatewayclass" || fields[0] === "operator" || fields[0] === "tlsroute") {
            found[field(fields, 0)] = field(fields, 1);
          }
        }

        return found;
      },
    ],
    saveToContext: (output: any, _context: any, config: CloudConfig) => {
      const found = output.processed;

      if (found["crd.pool"] !== "present") {
        throw new Error(
          "This cluster has no CiliumLoadBalancerIPPool resource, which means Cilium isn't installed. Run the \"cilium\" bundle first.",
        );
      }

      const gap = describeGap(config);
      if (gap !== undefined) {
        console.log(`  ${gap}`);
        return { gatewayConfigured: false };
      }

      const mode = getGatewayMode(config);
      const nodes = getGatewayNodes(config).map(getClusterName);
      const addresses = getAddresses(config);

      console.log(`  Mode: ${mode}`);
      console.log(`  Gateway nodes: ${nodes.join(", ")}`);
      console.log(`  Addresses: ${addresses.join(", ")}`);

      // A pinned address on a node with no way out is a configuration
      // that can't work, and it fails as a timeout rather than as
      // anything that names the cause
      for (const [name, pinned] of Object.entries(getNodeAddresses(config))) {
        const node = getGatewayNodes(config).find(
          (candidate: any) => candidate.name === name || getClusterName(candidate) === name,
        );

        if (node === undefined) {
          throw new Error(
            `"network.externalIPs" gives ${pinned.join(", ")} to "${name}", but that node isn't marked as a gateway. Set "gateway": true on it, or move the address to "network.gateway.addresses".`,
          );
        }
      }

      if (announcesAddresses(config) && found["setting.l2"] !== "true") {
        throw new Error(
          'This cluster is set up to have Cilium announce its gateway addresses, but Cilium was installed without L2 announcements. Set "l2announcements.enabled" in the Cilium values and run the "cilium" bundle again.',
        );
      }

      if (found["gatewayclass"] !== "True") {
        for (const line of describeGatewayClass(found)) {
          console.log(`  ${line}`);
        }
      }

      return {
        gatewayConfigured: true,
        gatewayMode: mode,
        gatewayNodes: nodes,
        gatewayAddresses: addresses,
      };
    },
  },

  /**
   * Give the gateway nodes their role.
   *
   * The announcement policy selects on this label, so a policy created
   * before the label exists selects nothing and no address is ever
   * answered for. Labelling here rather than leaving it to the
   * nodeLabels bundle means this one works on its own, and it's the
   * same label either way.
   */
  {
    name: "label-gateway-nodes",
    description: "Label the nodes that can be reached from outside",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    skipWhen: (config: CloudConfig) => !hasGateway(config),
    command: (config: CloudConfig) => {
      const label = `${ROLE_PREFIX}/${NodeRole.Gateway}=${NodeRole.Gateway}`;

      return getGatewayNodes(config).flatMap((node: any) => {
        const name = quoteForShell(getClusterName(node));

        return [
          // --overwrite so a node that already has it isn't an error,
          // which is what makes the whole bundle safe to run again
          `kubectl label node ${name} --overwrite ${quoteForShell(label)} || { echo "Couldn't label ${getClusterName(node)} as a gateway. Has it joined the cluster?" >&2; exit 1; }`,
        ];
      });
    },
    output: OutputType.Raw,
  },

  /**
   * Create the pool the addresses come from.
   *
   * The manifest goes over standard input rather than being written to
   * a file on the control plane, so nothing is left behind and the
   * cluster is the only record of what was applied.
   */
  {
    name: "apply-lb-ip-pool",
    description: "Create the pool a LoadBalancer Service takes its address from",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    skipWhen: (config: CloudConfig) => !hasGateway(config),
    command: "kubectl apply -f -",
    stdin: (config: CloudConfig) => buildIPPool(config),
    output: OutputType.Raw,
  },

  /**
   * Make a gateway node answer for the addresses.
   *
   * Only for the port-forward case. In the floating case the node
   * already holds the address and announcing it again would be a
   * second machine claiming something that isn't its own.
   */
  {
    name: "apply-l2-announcement",
    description: "Have the gateway nodes announce the addresses on the LAN",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    skipWhen: (config: CloudConfig) => !hasGateway(config) || !announcesAddresses(config),
    command: "kubectl apply -f -",
    stdin: (config: CloudConfig) => buildL2Policy(config),
    output: OutputType.Raw,
  },

  /**
   * Check the cluster agrees.
   *
   * A pool is accepted asynchronously, and a pool whose addresses
   * overlap another one's is rejected with a condition rather than an
   * error at apply time. Reading the status back is the only way to
   * know the addresses are actually available to be handed out.
   */
  {
    name: "verify-gateway",
    description: "Check the pool is accepted and has addresses to hand out",
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    skipWhen: (config: CloudConfig) => !hasGateway(config),
    command: (config: CloudConfig) => {
      const name = quoteForShell(getName(config));

      return [
        `for attempt in $(seq ${POOL_TIMEOUT_SECONDS}); do [ -n "$(kubectl get ciliumloadbalancerippool ${name} -o jsonpath='{.status.conditions}' 2>/dev/null)" ] && break; sleep 1; done`,
        `kubectl get ciliumloadbalancerippool ${name} -o json || { echo "The pool ${getName(config)} never appeared, so nothing will be given an address" >&2; exit 1; }`,
      ];
    },
    output: OutputType.Json,
    saveToContext: (output: any, _context: any, config: CloudConfig) => {
      const pool = output.parsed;
      const conditions = pool?.status?.conditions;

      const byType: Record<string, any> = {};
      for (const condition of Array.isArray(conditions) ? conditions : []) {
        byType[condition.type] = condition;
      }

      // Cilium reports what it made of the pool through conditions
      // whose names are namespaced to it. It renamed them along the
      // way — "io.cilium/ips-available" became "cilium.io/IPsAvailable"
      // — so both are read rather than tying this to one release.
      const conflict = readCondition(byType, "cilium.io/PoolConflict", "io.cilium/conflict");
      const available = readCondition(byType, "cilium.io/IPsAvailable", "io.cilium/ips-available");
      const used = readCondition(byType, "cilium.io/IPsUsed", "io.cilium/ips-used");

      if (conflict !== undefined && conflict.status === "True") {
        throw new Error(
          `The pool "${getName(config)}" overlaps another one, so it won't hand out anything: ${conflict.message}`,
        );
      }

      // The count is in the message rather than the status, which for
      // these is always "Unknown"
      const free = readCount(available, "unknown");
      const taken = readCount(used, "0");
      console.log(`  Addresses available: ${free}, in use: ${taken}`);

      if (announcesAddresses(config)) {
        console.log(
          `  The gateway nodes answer for these on the LAN. Point the router's port forwarding at ${getAddresses(config).join(" or ")}.`,
        );
      }
      else {
        console.log(
          "  These are held by the gateway nodes themselves, so nothing else has to announce them.",
        );
      }

      console.log(
        `\n  A Gateway can now be created against the "${GATEWAY_CLASS}" GatewayClass, e.g.\n    community-cloud run-template embed://networking/gateway/Gateway.yaml cc.config.json`,
      );

      return {
        gatewayPool: getName(config),
        gatewayAddressesAvailable: free,
      };
    },
  },
];
