/**
 * @file
 * Meteorologist's settings, read from the environment in one place.
 *
 * The important one is how the Kubernetes API is reached. In the
 * cluster, Meteorologist is a go-between and nothing more: it signs
 * people in through Authentik and calls the API with each person's
 * own token, so what they can do here is exactly what RBAC lets them
 * do anywhere else. It holds no access of its own worth stealing.
 *
 * The two other ways are for working on Meteorologist itself, and
 * both have to be asked for by name. A kubeconfig is read only from
 * the file METEOROLOGIST_KUBECONFIG names. It's never picked up from
 * KUBECONFIG or ~/.kube/config by itself, so a developer whose shell
 * points at a real cluster can't reach it by accident; naming that
 * file is fine, and deliberate. A production build refuses the
 * kubeconfig mode unless told it's a local test, since in a deployed
 * one it would let everyone who can reach the page act as whoever the
 * kubeconfig names. Fixtures reach no cluster at all.
 *
 * A kubeconfig can also just say where the API server is, while people
 * still sign in and act as themselves. That's how the real sign-in is
 * tried from a laptop against a cluster that trusts Authentik.
 */
import { homedir } from "node:os";

/**
 * - user: each request is made with the signed-in person's ID token
 * - kubeconfig: every request is made as the kubeconfig's user
 * - fixtures: an in-memory cluster, for development and screenshots
 */
export type KubeMode = "user" | "kubeconfig" | "fixtures";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  // Where people are sent back to, and what links are built from
  publicUrl: string;
  scopes: string;
}

// What's asked of Authentik. "profile" carries the username and the
// groups, which the API server reads; "offline_access" gets a refresh
// token, so a session outlives the ID token's few minutes.
const DEFAULT_SCOPES = "openid profile email offline_access";

/**
 * A required setting, or a clear error naming it.
 *
 * @param name
 * @returns
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} isn't set. See ui/meteorologist/README.md for what Meteorologist needs.`);
  }
  return value.trim();
}

/**
 * How the Kubernetes API is reached.
 *
 * @returns
 */
export function getKubeMode(): KubeMode {
  const mode = process.env.METEOROLOGIST_KUBE_MODE?.trim() || "user";
  if (mode !== "user" && mode !== "kubeconfig" && mode !== "fixtures") {
    throw new Error(`METEOROLOGIST_KUBE_MODE is "${mode}"; it should be user, kubeconfig or fixtures.`);
  }
  if (
    mode === "kubeconfig" &&
    process.env.NODE_ENV === "production" &&
    process.env.METEOROLOGIST_ALLOW_KUBECONFIG_IN_PRODUCTION !== "true"
  ) {
    throw new Error(
      "METEOROLOGIST_KUBE_MODE=kubeconfig is for development, and is refused in a production build unless " +
        "METEOROLOGIST_ALLOW_KUBECONFIG_IN_PRODUCTION=true says it's a local test.",
    );
  }
  return mode;
}

/**
 * Whether people sign in at all. Only when requests are made as them.
 *
 * @returns
 */
export function signsIn(): boolean {
  return getKubeMode() === "user";
}

/**
 * A path with a leading ~ made absolute, since a value in a .env file
 * isn't expanded by any shell.
 *
 * @param path
 * @returns
 */
function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

/**
 * The kubeconfig file for development, and the context in it to use.
 *
 * @returns
 */
export function getDevKubeconfig(): { path: string; context?: string } {
  return {
    path: expandHome(required("METEOROLOGIST_KUBECONFIG")),
    context: process.env.METEOROLOGIST_KUBECONFIG_CONTEXT?.trim() || undefined,
  };
}

/**
 * Whether a development kubeconfig has been named at all. In user mode
 * one only says where the API server is; nobody acts as its user.
 *
 * @returns
 */
export function hasDevKubeconfig(): boolean {
  return (process.env.METEOROLOGIST_KUBECONFIG?.trim() ?? "") !== "";
}

/**
 * The Kubernetes API server's address and CA, when they're not the
 * in-cluster ones a pod is given.
 *
 * @returns
 */
export function getApiServerOverride(): { server?: string; caFile?: string; insecure: boolean } {
  return {
    server: process.env.KUBE_API_SERVER?.trim() || undefined,
    caFile: process.env.KUBE_CA_FILE?.trim() || undefined,
    insecure: process.env.KUBE_INSECURE_SKIP_TLS_VERIFY === "true",
  };
}

/**
 * Everything needed to sign people in through Authentik.
 *
 * @returns
 */
export function getOidcSettings(): OidcSettings {
  return {
    issuer: required("OIDC_ISSUER"),
    clientId: required("OIDC_CLIENT_ID"),
    clientSecret: process.env.OIDC_CLIENT_SECRET?.trim() || undefined,
    publicUrl: required("METEOROLOGIST_URL").replace(/\/+$/, ""),
    scopes: process.env.OIDC_SCOPES?.trim() || DEFAULT_SCOPES,
  };
}

/**
 * The secret session cookies are encrypted with.
 *
 * @returns
 */
export function getSessionSecret(): string {
  const secret = required("SESSION_SECRET");
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET should be at least 32 characters; `openssl rand -base64 48` makes one.");
  }
  return secret;
}
