/**
 * @file
 * Set up a Nebula network through the
 * [Defined Networking API](https://docs.defined.net/api/defined-networking-api/).
 *
 * This is the once-per-cluster half: find the network and make sure
 * the roles exist on it. Enrolling a node is the other half and lives
 * in Nebula.ts, which reuses the lookups here.
 *
 * A note on scope: the API has no endpoint that creates a network.
 * Networks can be listed, edited, deleted and given another CIDR, but
 * making one happens in the admin console at admin.defined.net. So
 * this finds the network named in the configuration and fails with a
 * clear message when it isn't there, rather than pretending it can
 * conjure one.
 *
 * Requires:
 * - an API key with the roles:create, roles:list and networks:list scopes
 */
import { CommandSpec, WebCommandSpec } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";

// Where the API lives
export const DEFINED_API_URL = "https://api.defined.net";

// Read when the configuration doesn't carry an API key itself, so a
// key doesn't have to be written into a file to be used
export const API_KEY_ENV = "DEFINED_API_KEY";

// Listings are paginated. Roles and networks come in tens, not
// thousands, so one large page saves following cursors.
const PAGE_SIZE = 500;

// The role a node joins under unless it's told otherwise. Nodes are
// nearly always being added to the cluster.
export const DEFAULT_ROLE = "Cluster Access";

/**
 * A firewall rule on a role, as the configuration writes it.
 *
 * This is the API's own shape with one change: a rule names the role
 * it allows rather than carrying its ID, since a configuration file
 * has no way of knowing an ID the API hasn't issued yet.
 */
interface NebulaFirewallRule {
  protocol: "ANY" | "TCP" | "UDP" | "ICMP";
  description?: string;
  allowedRole?: string;
  allowedTags?: string[];
  portRange?: { from: number; to: number };
}

/**
 * A role to create on the network.
 */
interface NebulaRole {
  name: string;
  description?: string;
  firewallRules?: NebulaFirewallRule[];
}

/**
 * The nebula section of a Community Cloud configuration.
 *
 * - apiKey: a Defined Networking API key. Falls back to the
 *   DEFINED_API_KEY environment variable when it isn't set here.
 * - network / networkID: which network to use, by name or by ID
 * - defaultRole: the role nodes are enrolled under
 * - roles: the roles to create on the network
 */
export interface NebulaConfig {
  apiKey?: string;
  network?: string;
  networkID?: string;
  defaultRole?: string;
  roles?: NebulaRole[];
}

/**
 * Read the nebula section of the configuration.
 *
 * @param config
 * @returns
 */
export function getNebulaConfig(config: CloudConfig): NebulaConfig {
  const { network } = config.getConfig();
  const nebula = network !== undefined && network !== null ? network.nebula : undefined;

  return nebula !== undefined && nebula !== null ? nebula : {};
}

/**
 * The headers every request to the API carries.
 *
 * Built as a function so the key is read at the moment it's needed and
 * travels in a header rather than on a command line, where it would
 * show up in a process listing on the node.
 *
 * @param config
 * @returns
 */
export function buildApiHeaders(config: CloudConfig): Record<string, string> {
  const { apiKey } = getNebulaConfig(config);
  const key = apiKey !== undefined && apiKey !== "" ? apiKey : process.env[API_KEY_ENV];

  if (key === undefined || key === "") {
    throw new Error(
      `No Defined Networking API key. Set one under "network.nebula.apiKey" or in the ${API_KEY_ENV} environment variable.`,
    );
  }

  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
}

/**
 * Find the network the cluster runs on.
 *
 * Shared with the enrolment bundle, which needs the network's ID
 * before it can create a host on it.
 */
export const findNetworkCommand: WebCommandSpec = {
  name: "find-nebula-network",
  description: "Find the Defined Networking network for the cluster",
  url: `${DEFINED_API_URL}/v2/networks`,
  query: { pageSize: PAGE_SIZE },
  headers: buildApiHeaders,
  saveToContext: (output: any, context: any, config: CloudConfig) => {
    const { network, networkID } = getNebulaConfig(config);
    const networks = output.parsed !== undefined && output.parsed !== null
      ? output.parsed.data
      : undefined;

    if (!Array.isArray(networks) || networks.length === 0) {
      throw new Error(
        "The Defined Networking account has no networks. Create one at https://admin.defined.net, then set its name under \"network.nebula.network\".",
      );
    }

    // Either identifier will do, so a configuration can pin an ID or
    // stay readable and use the name
    const match = networks.find((candidate: any) => {
      return networkID !== undefined
        ? candidate.id === networkID
        : candidate.name === network;
    });

    if (match === undefined) {
      const wanted = networkID !== undefined ? networkID : network;
      throw new Error(
        `Couldn't find a Defined Networking network matching "${wanted}". Networks on this account: ${networks.map((n: any) => n.name).join(", ")}.`,
      );
    }

    return {
      nebulaNetworkID: match.id,
      nebulaNetworkName: match.name,
      nebulaNetworkCidrs: match.cidrs,
    };
  },
};

/**
 * Read the roles that already exist, keyed by name.
 *
 * Everything after this works in names, because that's what a
 * configuration can meaningfully hold, and looks the ID up here.
 */
export const listRolesCommand: WebCommandSpec = {
  name: "list-nebula-roles",
  description: "List the roles already on the network",
  url: `${DEFINED_API_URL}/v1/roles`,
  query: { pageSize: PAGE_SIZE },
  headers: buildApiHeaders,
  saveToContext: (output: any) => {
    const roles = output.parsed !== undefined && output.parsed !== null
      ? output.parsed.data
      : undefined;

    return {
      nebulaRoleIDs: Object.fromEntries(
        (Array.isArray(roles) ? roles : []).map((role: any) => [role.name, role.id]),
      ),
    };
  },
};

/**
 * Build the command that creates one role.
 *
 * @param role
 * @returns
 */
function buildCreateRoleCommand(role: NebulaRole): WebCommandSpec {
  return {
    name: `create-nebula-role-${toSlug(role.name)}`,
    description: `Create the "${role.name}" role`,
    url: `${DEFINED_API_URL}/v1/roles`,
    method: "POST",
    headers: buildApiHeaders,

    // A role that's already there is the state we wanted, so there's
    // nothing to do and nothing to report
    skipWhen: (config: CloudConfig, context: any) =>
      getRoleID(context, role.name) !== undefined,

    body: (config: CloudConfig, context: any) => ({
      name: role.name,
      description: role.description !== undefined ? role.description : "",
      firewallRules: buildFirewallRules(role, context),
    }),

    // Keep the new role's ID to hand, both for the rules of roles
    // created after it and for the enrolment that follows
    saveToContext: (output: any, context: any) => {
      const created = output.parsed.data;
      return {
        nebulaRoleIDs: {
          ...(context.nebulaRoleIDs !== undefined ? context.nebulaRoleIDs : {}),
          [created.name]: created.id,
        },
      };
    },
  };
}

/**
 * Turn the configured firewall rules into what the API expects.
 *
 * The only difference is the allowed role, which a configuration
 * names and the API wants as an ID. A rule that names no role allows
 * every role, which is what the API does with a null.
 *
 * @param role
 * @param context
 * @returns
 */
function buildFirewallRules(role: NebulaRole, context: any) {
  const rules = role.firewallRules !== undefined ? role.firewallRules : [];

  return rules.map((rule) => {
    const { allowedRole, ...rest } = rule;

    let allowedRoleID = null;
    if (allowedRole !== undefined) {
      allowedRoleID = getRoleID(context, allowedRole);

      if (allowedRoleID === undefined) {
        throw new Error(
          `The "${role.name}" role has a rule allowing "${allowedRole}", which doesn't exist yet. List it before "${role.name}" in the configuration so it's created first.`,
        );
      }
    }

    return { ...rest, allowedRoleID };
  });
}

/**
 * Look a role's ID up by name, from whatever's been found or created
 * so far.
 *
 * @param context
 * @param name
 * @returns
 */
export function getRoleID(context: any, name: string): string | undefined {
  const roleIDs = context.nebulaRoleIDs;
  return roleIDs !== undefined && roleIDs !== null ? roleIDs[name] : undefined;
}

/**
 * Check every configured role made it onto the network.
 */
const verifyRolesCommand: WebCommandSpec = {
  name: "verify-nebula-roles",
  description: "Verify the configured roles exist on the network",
  url: `${DEFINED_API_URL}/v1/roles`,
  query: { pageSize: PAGE_SIZE },
  headers: buildApiHeaders,
  saveToContext: (output: any, context: any, config: CloudConfig) => {
    const roles = output.parsed.data;
    const byName = Object.fromEntries(roles.map((role: any) => [role.name, role.id]));

    const wanted = getConfiguredRoles(config).map((role) => role.name);
    const missing = wanted.filter((name) => byName[name] === undefined);

    if (missing.length > 0) {
      throw new Error(
        `These roles still aren't on the network: ${missing.join(", ")}.`,
      );
    }

    // The role nodes enrol under has to be there, whether or not this
    // configuration is the thing that created it
    const defaultRole = getDefaultRoleName(config);
    if (byName[defaultRole] === undefined) {
      throw new Error(
        `The default role "${defaultRole}" isn't on the network. Add it to "network.nebula.roles" or point "network.nebula.defaultRole" at one of: ${Object.keys(byName).join(", ")}.`,
      );
    }

    console.log(`Roles on ${context.nebulaNetworkName}: ${Object.keys(byName).join(", ")}`);

    return { nebulaRoleIDs: byName };
  },
};

/**
 * The roles a configuration asks for.
 *
 * @param config
 * @returns
 */
export function getConfiguredRoles(config: CloudConfig): NebulaRole[] {
  const { roles } = getNebulaConfig(config);
  return Array.isArray(roles) ? roles : [];
}

/**
 * The role nodes are enrolled under.
 *
 * @param config
 * @returns
 */
export function getDefaultRoleName(config: CloudConfig): string {
  const { defaultRole } = getNebulaConfig(config);
  return defaultRole !== undefined && defaultRole !== "" ? defaultRole : DEFAULT_ROLE;
}

/**
 * Build the bundle that prepares the network.
 *
 * A role is a command of its own rather than one command looping, so
 * that each shows up in the results under its own name and a failure
 * says which role it was.
 *
 * @param config
 * @returns
 */
export function NebulaNetworkCommands(config: CloudConfig): CommandSpec[] {
  return [
    findNetworkCommand,
    listRolesCommand,
    ...getConfiguredRoles(config).map(buildCreateRoleCommand),
    verifyRolesCommand,
  ];
}

/**
 * Make a name safe to use as a command name.
 *
 * @param value
 * @returns
 */
function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
