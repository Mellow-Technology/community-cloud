/**
 * @file
 * People signing in to the cluster itself through Authentik.
 *
 * Headlamp signs people in with OpenID Connect and then talks to the
 * Kubernetes API as them, handing the API server the ID token
 * Authentik gave them; kubectl can do the same through a plugin like
 * kubelogin. Either only works if the API server trusts Authentik to
 * vouch for people, which is a setting on the API server rather than
 * on the client.
 *
 * That setting is an AuthenticationConfiguration file on each server,
 * which K3s hands the API server with "authentication-config". It
 * takes over from the "--oidc-*" flags, which allow one client and
 * nothing else. The file allows several — one per Authentik
 * application, each with its own issuer — and it allows rules about
 * who's let in at all. The API server also rereads it when it changes,
 * so adding a client needs no restart.
 *
 * Headlamp's client has a fixed ID, "headlamp", rather than a generated
 * one, since the API server is told it when K3s is installed, which
 * may be long before Authentik is. Any other client, such as one made
 * by hand for kubectl, is listed under "k3s.signInClients".
 *
 * A person is "authentik:<their username>", and is in
 * "authentik:<group>" for each of their Authentik groups. The prefix is
 * what keeps an Authentik group from being taken for one of the
 * cluster's own: without it, a group in Authentik called
 * "system:masters" would be exactly that.
 *
 * Only people in at least one group whose name starts "k8s-" get in.
 * Authentik has groups for all sorts of reasons, and someone added to
 * one to use the CRM shouldn't find they can also sign in to the
 * cluster. What they may do once in is ordinary RBAC: the headlamp
 * package binds "k8s-admins" to cluster-admin, unless
 * values.clusterAdminGroup says otherwise, and anything finer is yours
 * to bind.
 */
import { stringify } from "yaml";

import CloudConfig from "../../util/CloudConfig.ts";

// The client in Authentik the API server accepts Headlamp's tokens
// for, and the application slug its issuer's address is made from
export const CLUSTER_CLIENT_ID = "headlamp";

// What every name from Authentik is given in front, for users and
// groups alike
export const AUTHENTIK_PREFIX = "authentik:";

// What a group's name has to start with for its members to be let in
export const CLUSTER_GROUP_PREFIX = "k8s-";

// The group bound to cluster-admin when the configuration doesn't say.
// Nothing makes it; it has to be made in Authentik, and people put in
// it, before anyone can sign in as an administrator.
export const DEFAULT_CLUSTER_ADMIN_GROUP = `${CLUSTER_GROUP_PREFIX}admins`;

// Where the API server's settings go on each server. Not in
// config.yaml.d, which K3s reads as its own configuration: a file
// there is taken for K3s flags, whatever it says it is.
export const AUTHENTICATION_CONFIG_PATH = "/etc/rancher/k3s/authentication.yaml";

/**
 * A client the API server accepts tokens for.
 *
 * - application: the application's slug in Authentik, which its
 *   issuer's address is made from
 * - clientId: the client ID of its provider, which is the audience its
 *   tokens are for
 */
export interface SignInClient {
  application: string;
  clientId: string;
}

/**
 * Whether Headlamp is to be installed.
 *
 * Read from the configuration directly rather than through the package
 * catalogue, which names this file's client ID and so can't be
 * imported by it. "true", or a selection not switched off.
 *
 * @param config
 * @returns
 */
function installsHeadlamp(config: CloudConfig): boolean {
  const headlamp = config.getConfig()?.packages?.headlamp;
  return (
    headlamp === true ||
    (typeof headlamp === "object" && headlamp !== null && headlamp.enabled !== false)
  );
}

/**
 * Every client the API server should accept tokens for: Headlamp's,
 * when it's being installed, and whatever the configuration lists.
 *
 * @param config
 * @returns
 */
export function getSignInClients(config: CloudConfig): SignInClient[] {
  const listed = config.getConfig()?.k3s?.signInClients;

  return [
    ...(installsHeadlamp(config) ? [{ application: CLUSTER_CLIENT_ID, clientId: CLUSTER_CLIENT_ID }] : []),
    ...(Array.isArray(listed) ? listed : []),
  ];
}

/**
 * Whether the API server should trust Authentik.
 *
 * When there's an Authentik to trust, and a client to trust it for.
 *
 * @param config
 * @returns
 */
export function signsInThroughAuthentik(config: CloudConfig): boolean {
  return getAuthHost(config) !== undefined && getSignInClients(config).length > 0;
}

/**
 * The issuer an application's tokens come from. Each provider in
 * Authentik is its own issuer, at its application's address.
 *
 * @param config
 * @param application the application's slug
 * @returns
 */
export function getClusterIssuer(config: CloudConfig, application = CLUSTER_CLIENT_ID): string | undefined {
  const host = getAuthHost(config);
  return host !== undefined ? `https://${host}/application/o/${application}/` : undefined;
}

/**
 * The API server's AuthenticationConfiguration, as YAML.
 *
 * One JWT authenticator per application, since that's what an issuer
 * is. Two clients of the same application are one authenticator with
 * two audiences: the API server refuses two authenticators for one
 * issuer.
 *
 * The username is the Authentik username. Kubernetes only takes an
 * email address as a name from a token that says it's verified, which
 * every client would then have to be set up to say; the username needs
 * nothing, and it's what Authentik's own "profile" scope hands over.
 *
 * @param config
 * @returns nothing, when the API server shouldn't trust Authentik
 */
export function buildAuthenticationConfig(config: CloudConfig): string | undefined {
  if (!signsInThroughAuthentik(config)) {
    return undefined;
  }

  const audiences = new Map<string, string[]>();
  for (const { application, clientId } of getSignInClients(config)) {
    const known = audiences.get(application) ?? [];
    if (!known.includes(clientId)) {
      audiences.set(application, [...known, clientId]);
    }
  }

  const jwt = [...audiences].map(([application, clients]) => ({
    issuer: {
      url: getClusterIssuer(config, application),
      audiences: clients,
      ...(clients.length > 1 ? { audienceMatchPolicy: "MatchAny" } : {}),
    },
    claimMappings: {
      username: { claim: "preferred_username", prefix: AUTHENTIK_PREFIX },
      groups: { claim: "groups", prefix: AUTHENTIK_PREFIX },
      uid: { claim: "sub" },
    },
    userValidationRules: [
      {
        expression: `user.groups.exists(g, g.startsWith('${AUTHENTIK_PREFIX}${CLUSTER_GROUP_PREFIX}'))`,
        message: `user is not in any ${CLUSTER_GROUP_PREFIX}* Authentik group`,
      },
    ],
  }));

  return stringify({
    apiVersion: "apiserver.config.k8s.io/v1",
    kind: "AuthenticationConfiguration",
    jwt,
  });
}

/**
 * The API server's arguments for trusting it, as K3s takes them.
 *
 * @param config
 * @returns nothing, when the API server shouldn't trust Authentik
 */
export function buildApiServerAuthArgs(config: CloudConfig): string[] {
  return signsInThroughAuthentik(config)
    ? [`--kube-apiserver-arg=authentication-config=${AUTHENTICATION_CONFIG_PATH}`]
    : [];
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
