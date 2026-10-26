/**
 * @file
 * People signing in to the cluster itself through Authentik.
 *
 * Headlamp signs people in with OpenID Connect and then talks to the
 * Kubernetes API as them, handing the API server the ID token
 * Authentik gave them. That only works if the API server trusts
 * Authentik to vouch for people, which is a setting on the API server
 * rather than on Headlamp: K3s is started with the issuer and the
 * client the tokens are for, and which claims say who someone is and
 * which groups they're in.
 *
 * So the client has a fixed ID, "headlamp", rather than a generated
 * one. The API server is told it when K3s is installed, which may be
 * long before Authentik is, and it only accepts tokens issued to it.
 *
 * Who gets to do what is then ordinary RBAC, against names with
 * "oidc:" in front: a person is "oidc:<their email>", and is in
 * "oidc:<group>" for each of their Authentik groups. The headlamp
 * package binds one group to cluster-admin — "authentik Admins" unless
 * values.clusterAdminGroup says otherwise — and anything finer is
 * yours to bind.
 *
 * The prefix is what keeps an Authentik group from being taken for one
 * of the cluster's own. Without it, a group in Authentik called
 * "system:masters" would be exactly that.
 */
import CloudConfig from "../../util/CloudConfig.ts";

// The client in Authentik the API server accepts tokens for, and the
// application slug the issuer's address is made from
export const CLUSTER_CLIENT_ID = "headlamp";

// What every name from Authentik is given in front, for users and
// groups alike
export const OIDC_PREFIX = "oidc:";

// The group bound to cluster-admin when the configuration doesn't say.
// Authentik makes it as it's first set up, for its own administrators.
export const DEFAULT_CLUSTER_ADMIN_GROUP = "authentik Admins";

/**
 * Whether the API server should trust Authentik.
 *
 * When Headlamp is to be installed and there's an Authentik for it to
 * sign in through.
 *
 * @param config
 * @returns
 */
export function signsInThroughAuthentik(config: CloudConfig): boolean {
  // Read from the configuration directly rather than through the
  // package catalogue, which names this file's client ID and so can't
  // be imported by it. "true", or a selection not switched off.
  const headlamp = config.getConfig()?.packages?.headlamp;
  const enabled =
    headlamp === true ||
    (typeof headlamp === "object" && headlamp !== null && headlamp.enabled !== false);

  return enabled && getAuthHost(config) !== undefined;
}

/**
 * The issuer Headlamp's tokens come from: Authentik's, for the
 * application.
 *
 * @param config
 * @returns
 */
export function getClusterIssuer(config: CloudConfig): string | undefined {
  const host = getAuthHost(config);
  return host !== undefined ? `https://${host}/application/o/${CLUSTER_CLIENT_ID}/` : undefined;
}

/**
 * The API server's arguments for trusting it, as K3s takes them.
 *
 * The username is the email address, which Kubernetes only takes from
 * a token that says it's verified. Headlamp's client in Authentik
 * says so; see Headlamp.blueprint.yaml for why that's safe.
 *
 * @param config
 * @returns nothing, when the API server shouldn't trust Authentik
 */
export function buildApiServerOidcArgs(config: CloudConfig): string[] {
  const issuer = getClusterIssuer(config);

  if (!signsInThroughAuthentik(config) || issuer === undefined) {
    return [];
  }

  return [
    `oidc-issuer-url=${issuer}`,
    `oidc-client-id=${CLUSTER_CLIENT_ID}`,
    "oidc-username-claim=email",
    `oidc-username-prefix=${OIDC_PREFIX}`,
    "oidc-groups-claim=groups",
    `oidc-groups-prefix=${OIDC_PREFIX}`,
  ].map((arg) => `--kube-apiserver-arg=${arg}`);
}

/**
 * Authentik's hostname, from the configuration's values.
 *
 * @param config
 * @returns
 */
function getAuthHost(config: CloudConfig): string | undefined {
  const host = config.getConfig()?.values?.domain?.auth;
  return typeof host === "string" && host.trim() !== "" ? host.trim() : undefined;
}
