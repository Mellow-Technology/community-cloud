/**
 * @file
 * The keys in GitLab CI build URLs: made and checked only on the
 * server, apart from builds.ts, which the pages' own code uses too. See
 * builds.ts for what they're for.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A key no one could guess: 32 characters, safe in a URL path.
 *
 * @returns
 */
export function newKey(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Whether the key a URL carries is the namespace's, taking as long to
 * say no whichever character is wrong.
 *
 * @param given
 * @param expected
 * @returns
 */
export function keyMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return expected !== "" && a.length === b.length && timingSafeEqual(a, b);
}
