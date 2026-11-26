/**
 * @file
 * Who an MCP request is from, and so which namespace it works in.
 *
 * An agent's token is a ServiceAccount's (../agents/tokens.ts), and
 * it's handed to the API server as it came, the way a person's ID
 * token is: Meteorologist acts as the agent and RBAC decides what it
 * may do. The namespace is the ServiceAccount's own, from what the API
 * server says the token is, not from anything the request claims. A
 * person's token is refused, since it belongs to no one namespace.
 *
 * In the development modes there's no token to read: the namespace
 * comes from the address instead (/mcp?namespace=team-shop), and the
 * client is the one the pages get.
 */
import { bearerToken, serviceAccountNamespace } from "../agents/tokens";
import { getKubeMode, getPublicUrl } from "../config";
import { apiServerClientForDevKubeconfig, apiServerClientForToken } from "../kube/apiServer";
import { KubeError } from "../kube/client";
import { fixtureClient } from "../kube/fixtures";
import type { ToolContext } from "./tools";

/**
 * Why a request can't be served, as the status to answer with.
 */
export class Unauthorised extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The client and namespace for a request.
 *
 * @param request
 * @returns
 * @throws Unauthorised when there's no token, the API server doesn't
 *   accept it, or it isn't a ServiceAccount's
 */
export async function contextFor(request: Request): Promise<ToolContext> {
  const publicUrl = getPublicUrl();
  const mode = getKubeMode();
  if (mode !== "user") {
    const namespace = new URL(request.url).searchParams.get("namespace");
    if (!namespace) {
      throw new Unauthorised(403, "In development, say which namespace in the address: /mcp?namespace=<name>.");
    }
    return { kube: mode === "fixtures" ? fixtureClient() : apiServerClientForDevKubeconfig(), namespace, publicUrl };
  }

  const token = bearerToken(request.headers.get("authorization"));
  if (token === undefined) {
    throw new Unauthorised(401, "Send an agent token from the namespace's Agents tab as a bearer token.");
  }
  const kube = apiServerClientForToken(token);
  let username: string;
  try {
    ({ username } = await kube.whoAmI());
  } catch (error) {
    if (error instanceof KubeError && error.status === 401) {
      throw new Unauthorised(401, "The token wasn't accepted. It may have expired or been revoked.");
    }
    throw error;
  }
  const namespace = serviceAccountNamespace(username);
  if (namespace === undefined) {
    throw new Unauthorised(403, "Only an agent token, made on a namespace's Agents tab, can be used here.");
  }
  return { kube, namespace, publicUrl };
}
