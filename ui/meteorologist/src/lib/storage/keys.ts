/**
 * @file
 * A user's access keys: S3Credentials, each a key pair SeaweedFS's
 * operator makes and writes into a Secret.
 *
 * A user can have several, so one can be replaced without a moment
 * when nothing works: make a new key, move whatever uses the old one
 * over, then delete the old one.
 */
import type { S3CredentialsSummary } from "./types";

/**
 * What a new key's S3Credentials and Secret are called: the user's
 * name, then -2, -3 and so on, as the first key Cirrus and the
 * installer make is named for the user, with the Secret "-s3" after.
 *
 * @param identity the S3Identity's resource name
 * @param existing the namespace's S3Credentials
 * @param takenSecrets the namespace's Secrets' names, so a new Secret
 *   doesn't land on one that's there
 * @returns
 */
export function newKeyNames(
  identity: string,
  existing: S3CredentialsSummary[],
  takenSecrets: string[] = [],
): { name: string; secretName: string } {
  const names = new Set(existing.map((each) => each.name));
  const secrets = new Set([...takenSecrets, ...existing.map((each) => each.secretName ?? "")]);
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? identity : `${identity}-${n}`;
    const secretName = `${name}-s3`;
    if (!names.has(name) && !secrets.has(secretName)) {
      return { name: name.slice(0, 253), secretName: secretName.slice(0, 253) };
    }
  }
}

// Secret names are DNS subdomains
const SECRET_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/**
 * What's wrong with a Secret's name for a new key, or nothing. Blank
 * is fine: it means the one suggested.
 *
 * @param name
 * @param taken names already used in the namespace
 * @returns
 */
export function secretNameProblem(name: string, taken: string[] = []): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (trimmed.length > 253 || !SECRET_NAME.test(trimmed)) {
    return "Lower-case letters, digits, hyphens and dots, starting and ending with a letter or digit.";
  }
  if (taken.includes(trimmed)) {
    return `There's already a Secret called ${trimmed}.`;
  }
  return undefined;
}

/**
 * What deleting a key does, said before it's done.
 *
 * @param credentials
 * @returns
 */
export function keyDeletion(credentials: S3CredentialsSummary): string {
  return credentials.reclaimPolicy === "Retain"
    ? "The S3Credentials goes, but the key stays in SeaweedFS and keeps working, since its reclaim policy is Retain."
    : "The key is taken out of SeaweedFS, so anything still using it is refused, and its Secret goes with it.";
}
