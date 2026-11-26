/**
 * @file
 * Agent tokens: what lets an agent manage one namespace's applications
 * over MCP (../mcp/).
 *
 * Each agent is a ServiceAccount in the namespace, labelled as one,
 * with a RoleBinding to cirrus-webapplications-edit and nothing else,
 * so its token can read and write WebApplications and
 * ServiceOfferings there and no more. The token is the API server's
 * own (a TokenRequest), with an expiry, and Meteorologist hands it on
 * as it came, as it does a person's ID token: Meteorologist keeps no
 * token and has no cluster access of its own to lend.
 *
 * - Making one takes binding a role, which in Kubernetes is the
 *   namespace's "admin" or a cluster admin, not "edit": a team member
 *   can't give an agent more than a person who can hand out access
 *   already could.
 * - A token is shown once and kept nowhere. Another can be made for
 *   the same agent at any time, and every one stays good until it
 *   expires.
 * - Revoking is deleting the ServiceAccount: the API server stops
 *   accepting every token made for it straight away, and the
 *   RoleBinding, which it owns, goes with it.
 *
 * The RBAC allows deleting WebApplications too, which the MCP tools
 * don't offer; the token is only refused that by the tools, not by
 * the API server. cirrus-webapplications-edit is what "edit" gives a
 * person, so it's no more than a team member has.
 */

export const AGENT_LABEL = "community-cloud.technology/agent";
// Who made it, and when the newest token made for it expires
export const CREATED_BY_ANNOTATION = "community-cloud.technology/created-by";
export const EXPIRES_ANNOTATION = "community-cloud.technology/token-expires";

// What an agent's token may do: the same as "edit" for applications
export const AGENT_ROLE = "cirrus-webapplications-edit";

// How long a token can be made to last, in days
export const TOKEN_LIFETIMES = [7, 30, 90, 365] as const;
export const DEFAULT_LIFETIME = 90;

/**
 * An agent, as the Agents tab lists it.
 */
export interface Agent {
  name: string;
  createdAt?: string;
  createdBy?: string;
  // When the newest token made here expires, if one was
  tokenExpires?: string;
}

/**
 * A token, as it's shown the once.
 */
export interface AgentToken {
  token: string;
  expiresAt: string;
}

/**
 * The RoleBinding an agent's ServiceAccount has.
 *
 * @param agent
 * @returns
 */
export function bindingName(agent: string): string {
  return `${agent}-agent`;
}

// A ServiceAccount's name is a DNS subdomain; kept to a label, with
// room for the binding's suffix
const AGENT_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * What's wrong with a name for a new agent, or nothing.
 *
 * @param name
 * @returns
 */
export function agentNameProblem(name: string): string | undefined {
  if (name.trim() === "") return "Give the agent a name.";
  if (name.length > 57 || !AGENT_NAME.test(name)) {
    return "Lower-case letters, digits and hyphens, no longer than 57 characters.";
  }
  if (name === "default") return "default is the namespace's own ServiceAccount.";
  return undefined;
}

const SERVICE_ACCOUNT_PREFIX = "system:serviceaccount:";

/**
 * The namespace of a ServiceAccount's username.
 *
 * @param username as the API server gives it
 * @returns nothing for anyone who isn't a ServiceAccount
 */
export function serviceAccountNamespace(username: string): string | undefined {
  if (!username.startsWith(SERVICE_ACCOUNT_PREFIX)) return undefined;
  const [namespace, name, ...rest] = username.slice(SERVICE_ACCOUNT_PREFIX.length).split(":");
  return namespace && name && rest.length === 0 ? namespace : undefined;
}

/**
 * The bearer token in an Authorization header.
 *
 * @param header
 * @returns
 */
export function bearerToken(header: string | null): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

/**
 * What an MCP client is configured with, for the token just made.
 *
 * @param publicUrl Meteorologist's address
 * @param token
 * @returns a Claude Code command, and the JSON most other clients take
 */
export function clientSetup(publicUrl: string, token: string): { command: string; json: string } {
  const url = new URL("/mcp", publicUrl).toString();
  return {
    command: `claude mcp add --transport http community-cloud ${url} --header "Authorization: Bearer ${token}"`,
    json: JSON.stringify(
      { mcpServers: { "community-cloud": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
      null,
      2,
    ),
  };
}
