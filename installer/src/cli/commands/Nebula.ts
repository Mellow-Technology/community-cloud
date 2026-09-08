/**
 * @file
 * Join a node to the cluster's Nebula network.
 *
 * Three things happen here: the API is asked for an enrolment code,
 * dnclient is installed on the node, and the node enrols with that
 * code. The first is an API call and the rest are shell commands,
 * which is why they sit in one bundle together — the code has to get
 * from the response to the node.
 *
 * How the code is obtained depends on whether the network has heard of
 * this host before:
 *
 * - a host it has never seen is created along with its first code, in
 *   one call to /v2/host-and-enrollment-code
 * - a host that is already registered can't be created again, so it's
 *   issued a fresh code instead through /v1/hosts/{id}/enrollment-code
 *
 * That second case is the normal one for a node being rebuilt, or for
 * any node whose local dnclient state was lost while the network still
 * has its registration.
 *
 * Setting the network up in the first place is NebulaNetwork.ts, and
 * the network and role lookups from there are reused so both bundles
 * agree on what they're pointing at.
 *
 * Requires:
 * - an API key with the hosts:create, hosts:enroll, hosts:list,
 *   roles:list and networks:list scopes
 * - a Debian or Ubuntu node, since dnclient comes from an apt repository
 * - sudo
 */
import { CommandSpec, OutputType, WebCommandSpec } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { quoteForShell } from "../../util/shell.ts";
import {
  DEFINED_API_URL,
  buildApiHeaders,
  findNetworkCommand,
  getDefaultRoleName,
  getRoleID,
  listRolesCommand,
} from "./NebulaNetwork.ts";

// Where the dnclient packages come from
const APT_KEY_URL = "https://dl.defined.net/gpg.asc";
const APT_KEYRING = "/etc/apt/keyrings/defined-net.asc";
const APT_LIST = "/etc/apt/sources.list.d/defined-net.list";
const APT_REPO = "https://dl.defined.net/stable/apt stable main";

// The systemd unit the package installs
const SERVICE = "dnclient";

// How long to wait for the mesh interface to come up after enrolling
const READY_TIMEOUT_SECONDS = 60;

// How many hosts to ask for when looking for an existing registration.
// This is the API's maximum, and a network with more hosts than this
// would need the listing to be followed across pages.
const HOST_PAGE_SIZE = 500;

/**
 * Per-node Nebula settings, read from the node in the configuration.
 *
 * Most nodes need none of this: Defined Networking runs managed
 * lighthouses, so an ordinary node just enrols and is reachable.
 *
 * - role: enrol under something other than the default role
 * - listenPort: the UDP port nebula uses. Required for a lighthouse
 *   or a relay, and picked automatically otherwise.
 * - staticAddresses: how other hosts reach this one, as host:port.
 *   Required for a lighthouse.
 * - isLighthouse / isRelay: a host can be one or the other, not both
 */
interface NodeNebulaConfig {
  role?: string;
  listenPort?: number;
  staticAddresses?: string[];
  isLighthouse?: boolean;
  isRelay?: boolean;
}

/**
 * Read the nebula settings off the node being worked on.
 *
 * @param context
 * @returns
 */
function getNodeNebulaConfig(context: any): NodeNebulaConfig {
  const node = context.node !== undefined && context.node !== null ? context.node : {};
  return node.nebula !== undefined && node.nebula !== null ? node.nebula : {};
}

/**
 * The name the host is registered under.
 *
 * @param context
 * @returns
 */
function getHostName(context: any): string {
  const node = context.node !== undefined && context.node !== null ? context.node : {};

  for (const candidate of [node.name, node.address, context.nodeName]) {
    if (typeof candidate === "string" && candidate !== "") {
      return candidate;
    }
  }

  throw new Error("Couldn't work out a name to register the host under.");
}

/**
 * Look for a registration this host already has.
 *
 * The API rejects a host whose name is already on the network, so we
 * have to know before we ask rather than after. There's no filter for
 * a name, so the network's hosts are listed and matched here.
 */
const findHostCommand: WebCommandSpec = {
  name: "find-nebula-host",
  description: "Check whether the node is already registered on the network",
  url: `${DEFINED_API_URL}/v2/hosts`,
  query: (config: CloudConfig, context: any) => ({
    "filter.networkID": context.nebulaNetworkID,
    pageSize: HOST_PAGE_SIZE,
  }),
  headers: buildApiHeaders,

  // Nothing to look up for a node that's already on the mesh
  skipWhen: (config: CloudConfig, context: any) => context.dnclientEnrolled === true,

  saveToContext: (output: any, context: any) => {
    const hosts = output.parsed !== undefined && output.parsed !== null
      ? output.parsed.data
      : undefined;

    const wanted = getHostName(context);
    const existing = (Array.isArray(hosts) ? hosts : []).find(
      (host: any) => host.name === wanted,
    );

    if (existing === undefined) {
      return {};
    }

    // A blocked host can't be enrolled at all, and the API says so
    // only once we've asked it for a code
    if (existing.isBlocked === true) {
      throw new Error(
        `The host "${wanted}" is blocked on this network, so it can't be enrolled. Unblock it at https://admin.defined.net and run this again.`,
      );
    }

    console.log(`"${wanted}" is already registered as ${existing.id}, so it will be issued a fresh enrollment code`);

    return {
      nebulaHostID: existing.id,
      nebulaHostName: existing.name,
      nebulaIPAddresses: existing.ipAddresses,
    };
  },
};

/**
 * Ask the API for a host and an enrolment code.
 *
 * One call rather than two, so there's no window where a host exists
 * with no way to enrol it.
 */
const createHostCommand: WebCommandSpec = {
  name: "create-nebula-host",
  description: "Create the host and its enrollment code",
  url: `${DEFINED_API_URL}/v2/host-and-enrollment-code`,
  method: "POST",
  headers: buildApiHeaders,

  // Enrolling a node that's already on the mesh would register a
  // second host for it and orphan the first, and a host the network
  // already knows about can't be created a second time at all
  skipWhen: (config: CloudConfig, context: any) =>
    context.dnclientEnrolled === true || context.nebulaHostID !== undefined,

  body: (config: CloudConfig, context: any) => {
    const roleName = getNodeRoleName(config, context);
    const roleID = getRoleID(context, roleName);

    if (roleID === undefined) {
      throw new Error(
        `There's no Nebula role named "${roleName}" on the network. Run the "nebula-network" bundle first, or point "network.nebula.defaultRole" at a role that exists.`,
      );
    }

    const { listenPort, staticAddresses, isLighthouse, isRelay } = getNodeNebulaConfig(context);

    // Only send what the node actually asked for, so the API keeps
    // applying its own defaults to the rest
    return {
      name: getHostName(context),
      networkID: context.nebulaNetworkID,
      roleID,
      ...(listenPort !== undefined ? { listenPort } : {}),
      ...(staticAddresses !== undefined ? { staticAddresses } : {}),
      ...(isLighthouse !== undefined ? { isLighthouse } : {}),
      ...(isRelay !== undefined ? { isRelay } : {}),
    };
  },

  saveToContext: {
    nebulaHostID: "parsed.data.host.id",
    nebulaHostName: "parsed.data.host.name",
    nebulaIPAddresses: "parsed.data.host.ipAddresses",
    nebulaEnrollmentCode: "parsed.data.enrollmentCode.code",
  },
};

/**
 * The role this particular node enrols under.
 *
 * @param config
 * @param context
 * @returns
 */
function getNodeRoleName(config: CloudConfig, context: any): string {
  const { role } = getNodeNebulaConfig(context);
  return role !== undefined && role !== "" ? role : getDefaultRoleName(config);
}

/**
 * Issue a fresh enrolment code for a host that already exists.
 *
 * Codes are single use and expire, so a host that has been registered
 * before needs a new one every time it enrols again.
 */
const createEnrollmentCodeCommand: WebCommandSpec = {
  name: "create-nebula-enrollment-code",
  description: "Issue a fresh enrollment code for an already registered host",
  url: (config: CloudConfig, context: any) =>
    `${DEFINED_API_URL}/v1/hosts/${context.nebulaHostID}/enrollment-code`,
  method: "POST",
  headers: buildApiHeaders,

  // Only needed when the host wasn't just created, since creating one
  // hands back a code of its own
  skipWhen: (config: CloudConfig, context: any) =>
    context.dnclientEnrolled === true || context.nebulaEnrollmentCode !== undefined,

  saveToContext: {
    nebulaEnrollmentCode: "parsed.data.code",
  },
};

export const NebulaCommands: CommandSpec[] = [
  /**
   * Find out whether this node is already on the mesh, before
   * anything is created for it.
   *
   * dnclient exits non-zero when it has nothing to report, which is
   * the answer rather than a failure, so this always succeeds and
   * says what it found.
   */
  {
    name: "check-nebula-enrollment",
    description: "Check whether the node is already enrolled",
    command: [
      `if command -v ${SERVICE} > /dev/null 2>&1 && sudo ${SERVICE} info > /dev/null 2>&1`,
      'then echo "enrolled"',
      'else echo "not-enrolled"',
      "fi",
    ].join("; "),
    output: OutputType.Raw,
    saveToContext: (output: any) => ({
      dnclientEnrolled: output.parsed.trim() === "enrolled",
    }),
  },

  // Which network, and what roles are on it
  findNetworkCommand,
  listRolesCommand,

  // A code to enrol with, by whichever of the two routes applies
  findHostCommand,
  createHostCommand,
  createEnrollmentCodeCommand,

  /**
   * Install dnclient from the Defined Networking apt repository.
   *
   * The repository is added afresh each run, which costs nothing and
   * means a node with a half-finished setup is put right rather than
   * left alone. Installing the package is skipped when it's there,
   * since that's the slow part.
   */
  {
    name: "install-dnclient",
    description: "Install dnclient from the Defined Networking repository",
    command: [
      `sudo install -m 0755 -d /etc/apt/keyrings || { echo "Couldn't create /etc/apt/keyrings" >&2; exit 1; }`,
      `sudo curl -fsSL ${APT_KEY_URL} -o ${APT_KEYRING} || { echo "Couldn't download the Defined Networking signing key from ${APT_KEY_URL}" >&2; exit 1; }`,
      `sudo chmod 0644 ${APT_KEYRING}`,
      `echo "deb [signed-by=${APT_KEYRING}] ${APT_REPO}" | sudo tee ${APT_LIST} > /dev/null`,
      `if command -v ${SERVICE} > /dev/null 2>&1`,
      `then echo "${SERVICE} is already installed"`,
      `else sudo apt-get update -o Dir::Etc::sourcelist=${APT_LIST} -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${SERVICE} || { echo "Couldn't install ${SERVICE}" >&2; exit 1; }`,
      "fi",
      `sudo systemctl enable --now ${SERVICE} || { echo "Couldn't start ${SERVICE}" >&2; exit 1; }`,
      // dnclient has no version subcommand, so we ask the package
      `dpkg-query -W -f='\${Version}\\n' ${SERVICE} 2>/dev/null || true`,
    ].join("; "),
    output: OutputType.Raw,
  },

  /**
   * Enrol with the code the API just issued.
   *
   * The code goes on the command line because that's the only way
   * dnclient takes it, so it's visible in a process listing on the
   * node for as long as the command runs. It's single use and
   * short-lived, but worth knowing.
   */
  {
    name: "enroll-nebula-host",
    description: "Enroll the node into the Nebula network",
    skipWhen: (config: CloudConfig, context: any) => context.dnclientEnrolled === true,
    command: (config: CloudConfig, context: any) => {
      const { nebulaEnrollmentCode } = context;

      if (typeof nebulaEnrollmentCode !== "string" || nebulaEnrollmentCode === "") {
        throw new Error(
          "No enrollment code to enroll with. Neither creating the host nor issuing a code for the existing one produced one, so there's nothing to join the network with.",
        );
      }

      return `sudo ${SERVICE} enroll -code ${quoteForShell(nebulaEnrollmentCode)}`;
    },
    output: OutputType.Raw,
  },

  /**
   * Check the node is actually on the mesh.
   *
   * The service being up says nothing about whether enrolment worked,
   * so this waits for the address the API assigned to appear on an
   * interface. That only happens once dnclient has its certificate
   * and has brought the tunnel up.
   */
  {
    name: "verify-nebula-host",
    description: "Verify the node is on the Nebula network",
    command: (config: CloudConfig, context: any) => {
      const addresses = Array.isArray(context.nebulaIPAddresses)
        ? context.nebulaIPAddresses
        : [];

      const checks = [
        `sudo systemctl is-active --quiet ${SERVICE} || { echo "${SERVICE} isn't running" >&2; exit 1; }`,
      ];

      // On a node that was already enrolled we have no address to look
      // for, so we ask dnclient what it thinks it is instead
      if (addresses.length === 0) {
        checks.push(
          `sudo ${SERVICE} info || { echo "${SERVICE} couldn't report its status, so the node isn't enrolled" >&2; exit 1; }`,
        );

        return checks.join("; ");
      }

      const address = quoteForShell(addresses[0]);
      checks.push(
        `for attempt in $(seq ${READY_TIMEOUT_SECONDS}); do ip -o addr show | grep -q ${address} && break; sleep 1; done`,
        `ip -o addr show | grep -q ${address} || { echo "The address ${addresses[0]} the network assigned never appeared on an interface, so the tunnel isn't up" >&2; exit 1; }`,
        `echo "on the mesh at ${addresses[0]}"`,
        `ip -o addr show | grep ${address}`,
        `sudo ${SERVICE} info || true`,
      );

      return checks.join("; ");
    },
    output: OutputType.Raw,
  },
];
