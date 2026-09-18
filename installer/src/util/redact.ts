/**
 * @file
 * Taking the secrets out of a configuration.
 *
 * A Community Cloud configuration is mostly not secret — which nodes
 * there are, what they're for, which packages to install — and that
 * part is worth having somewhere you can look at it. The rest of it
 * is the cluster token, a registry password and an API key, and those
 * have no business leaving the file.
 *
 * The list of what to take out is a guess about the future, so it's
 * made two ways. Named paths catch what's in a configuration today.
 * A rule about key names catches what someone adds next year: a
 * configuration grows fields, and a deny-list that has to be updated
 * by hand is one that will one day quietly fail to be.
 *
 * Erring towards taking too much out is the right way to be wrong.
 * A path redacted because it happens to be called "keyFile" costs
 * nothing; a database password in a ConfigMap that every pod in the
 * cluster can read costs rather more.
 */

/**
 * What replaces a secret, so that the shape of the configuration
 * survives even when the value doesn't.
 *
 * Kept as a value rather than removing the key, because "a token is
 * set" and "no token is set" are different things and both are worth
 * being able to see.
 */
export const REDACTED = "<redacted>";

/**
 * Words that make a key a secret.
 *
 * Matched against the words in a key name rather than the whole
 * thing, so "apiKey" and "identity_token" are caught while
 * "authentik" and "keyboard" are not.
 */
const SECRET_WORDS = new Set([
  "auth",
  "credential",
  "credentials",
  "key",
  "keys",
  "passphrase",
  "password",
  "passwd",
  "secret",
  "secrets",
  "token",
]);

/**
 * Paths taken out whatever they're called.
 *
 * For the ones where the key name says nothing: "k3s.token" is caught
 * by its name anyway, but a section that is wholly sensitive is worth
 * naming outright rather than relying on every key inside it being
 * given a careful name.
 */
const SECRET_PATHS = [
  ["k3s", "token"],
  ["network", "nebula", "apiKey"],
];

/**
 * Split a key into the words it's made of.
 *
 * Handles the three ways a key gets written: camelCase, snake_case
 * and kebab-case.
 *
 * @param key
 * @returns
 */
function getWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== "");
}

/**
 * Whether a key's name says it holds a secret.
 *
 * @param key
 * @returns
 */
export function isSecretKey(key: string): boolean {
  return getWords(key).some((word) => SECRET_WORDS.has(word));
}

/**
 * Whether a path is one of the ones named outright.
 *
 * @param path
 * @returns
 */
function isSecretPath(path: string[]): boolean {
  return SECRET_PATHS.some(
    (secret) =>
      secret.length === path.length &&
      secret.every((segment, index) => segment === path[index]),
  );
}

/**
 * Copy a configuration with every secret replaced.
 *
 * The original is left alone: this is for handing somewhere else,
 * and quietly emptying the configuration the rest of the install is
 * reading from would be a memorable bug.
 *
 * @param value
 * @param path where we are, for the named paths
 * @returns
 */
export function redact(value: any, path: string[] = []): any {
  if (Array.isArray(value)) {
    return value.map((entry, index) => redact(entry, [...path, String(index)]));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const copy: Record<string, any> = {};

  for (const [key, entry] of Object.entries(value)) {
    const here = [...path, key];

    if (isSecretKey(key) || isSecretPath(here)) {
      // An empty or missing value isn't a secret, and saying it was
      // set when it wasn't is its own kind of wrong
      copy[key] =
        entry === undefined || entry === null || entry === "" ? entry : REDACTED;
      continue;
    }

    copy[key] = redact(entry, here);
  }

  return copy;
}

/**
 * Every path that was redacted, for saying what was left out.
 *
 * @param value
 * @param path
 * @returns
 */
export function findSecrets(value: any, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findSecrets(entry, [...path, String(index)]));
  }

  if (value === null || typeof value !== "object") {
    return [];
  }

  const found: string[] = [];

  for (const [key, entry] of Object.entries(value)) {
    const here = [...path, key];

    if (isSecretKey(key) || isSecretPath(here)) {
      if (entry !== undefined && entry !== null && entry !== "") {
        found.push(here.join("."));
      }
      continue;
    }

    found.push(...findSecrets(entry, here));
  }

  return found;
}
