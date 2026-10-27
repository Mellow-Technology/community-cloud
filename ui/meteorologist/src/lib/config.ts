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
 * The two other ways are for working on Meteorologist itself. With
 * nothing set up it uses fixtures, which reach no cluster at all, so
 * `bun run dev` always starts. A real cluster has to be asked for by
 * name: a kubeconfig is read only from the file
 * METEOROLOGIST_KUBECONFIG names. It's never picked up from KUBECONFIG
 * or ~/.kube/config by itself, so a developer whose shell points at a
 * real cluster can't reach it by accident; naming that file is fine,
 * and deliberate. A production build refuses the
 * kubeconfig mode unless told it's a local test, since in a deployed
 * one it would let everyone who can reach the page act as whoever the
 * kubeconfig names.
 *
 * A kubeconfig can also just say where the API server is, while people
 * still sign in and act as themselves. That's how the real sign-in is
 * tried from a laptop against a cluster that trusts Authentik.
 */
import { existsSync } from "node:fs";
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

// The address `next dev` serves on unless told otherwise, so a local
// sign-in works without METEOROLOGIST_URL
const DEFAULT_DEV_PORT = "3000";

/**
 * Meteorologist isn't set up for the mode it's in. Says everything
 * that's missing at once, rather than one setting per restart.
 */
export class ConfigError extends Error {
  constructor(
    readonly mode: KubeMode,
    readonly problems: string[],
  ) {
    super(
      `Meteorologist isn't set up for the "${mode}" mode:\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        "\nSee ui/meteorologist/README.md, or run `bun run dev:fixtures` for a pretend cluster.",
    );
    this.name = "ConfigError";
  }
}

/**
 * A setting, trimmed, or undefined when it's empty.
 *
 * @param name
 * @returns
 */
function setting(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * A required setting, or a clear error naming it.
 *
 * @param name
 * @returns
 */
function required(name: string): string {
  const value = setting(name);
  if (value === undefined) {
    throw new ConfigError(getKubeMode(), [`${name} isn't set`]);
  }
  return value;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * The mode when METEOROLOGIST_KUBE_MODE doesn't say. A deployment
 * always signs people in. Working on Meteorologist, the mode follows
 * from what's been set up: an OIDC issuer means the real sign-in, a
 * named kubeconfig means acting as its user, and nothing at all means
 * the pretend cluster — so `bun run dev` with no settings starts
 * rather than failing on the first sign-in setting it looks for.
 *
 * @returns
 */
function inferredMode(): KubeMode {
  if (isProduction() || setting("OIDC_ISSUER") !== undefined) {
    return "user";
  }
  return setting("METEOROLOGIST_KUBECONFIG") !== undefined ? "kubeconfig" : "fixtures";
}

/**
 * How the Kubernetes API is reached.
 *
 * @returns
 */
export function getKubeMode(): KubeMode {
  const mode = setting("METEOROLOGIST_KUBE_MODE") ?? inferredMode();
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
    publicUrl: getPublicUrl(),
    scopes: process.env.OIDC_SCOPES?.trim() || DEFAULT_SCOPES,
  };
}

/**
 * The public address. A deployment has to say, since behind the
 * Gateway a request arrives at the pod's own address; locally it's
 * wherever `next dev` is listening.
 *
 * @returns
 */
export function getPublicUrl(): string {
  const url = isProduction()
    ? required("METEOROLOGIST_URL")
    : (setting("METEOROLOGIST_URL") ?? `http://localhost:${setting("PORT") ?? DEFAULT_DEV_PORT}`);
  return url.replace(/\/+$/, "");
}

/**
 * Everything the current mode needs that's missing or wrong, all at
 * once.
 *
 * @returns
 */
export function configProblems(): string[] {
  const mode = getKubeMode();
  const problems: string[] = [];
  const need = (name: string, why: string) => {
    if (setting(name) === undefined) {
      problems.push(`${name} isn't set: ${why}`);
    }
  };

  if (mode === "user") {
    need("OIDC_ISSUER", "the Authentik application's issuer URL");
    need("OIDC_CLIENT_ID", "the Authentik provider's client ID");
    need("SESSION_SECRET", "at least 32 characters, e.g. from `openssl rand -base64 48`");
    if (isProduction()) {
      need("METEOROLOGIST_URL", "the address people reach Meteorologist on");
    }
    const secret = setting("SESSION_SECRET");
    if (secret !== undefined && secret.length < 32) {
      problems.push("SESSION_SECRET is shorter than 32 characters");
    }
  }
  if (mode === "kubeconfig") {
    need("METEOROLOGIST_KUBECONFIG", "the kubeconfig whose user Meteorologist acts as");
  }
  const kubeconfig = setting("METEOROLOGIST_KUBECONFIG");
  if (mode !== "fixtures" && kubeconfig !== undefined && !existsSync(expandHome(kubeconfig))) {
    problems.push(`METEOROLOGIST_KUBECONFIG names ${kubeconfig}, which doesn't exist`);
  }
  return problems;
}

/**
 * Throws a ConfigError listing everything missing, if anything is.
 */
export function assertConfigured(): void {
  const problems = configProblems();
  if (problems.length > 0) {
    throw new ConfigError(getKubeMode(), problems);
  }
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
