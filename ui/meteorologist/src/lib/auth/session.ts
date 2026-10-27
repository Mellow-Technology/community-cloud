/**
 * @file
 * A signed-in person's tokens, kept in an encrypted cookie.
 *
 * Meteorologist calls the Kubernetes API with the ID token Authentik
 * gave the person, so it needs that token on every request. Keeping it
 * in the cookie itself, encrypted with a key only the server has,
 * means there's no session store to run and nothing to lose when the
 * pod restarts; the cost is a cookie of two or three kilobytes, which
 * is within what browsers allow.
 *
 * The browser can neither read nor change what's inside: the cookie is
 * httpOnly, and it's a JWE (direct AES-256-GCM), so a changed one
 * doesn't decrypt.
 *
 * This module is shared by the proxy, the route handlers and the pages,
 * so it reads and writes cookie values and leaves where they come from
 * to its callers.
 */
import { EncryptJWT, jwtDecrypt, decodeJwt } from "jose";

import { getSessionSecret } from "../config";

// The cookie holding the session, and the one holding a sign-in in
// progress (PKCE verifier, state and nonce) between leaving for
// Authentik and coming back
export const SESSION_COOKIE = "meteorologist_session";
export const LOGIN_COOKIE = "meteorologist_login";

// How long someone stays signed in without coming back. Each refresh
// starts the clock again; Authentik's refresh token lifetime is the
// real limit.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

// A sign-in that hasn't come back in this long is abandoned
export const LOGIN_MAX_AGE_SECONDS = 60 * 10;

/**
 * What's kept for a signed-in person.
 *
 * - idToken: what the API server is handed
 * - refreshToken: for a new ID token when this one runs out
 * - expiresAt: when the ID token runs out, in seconds since the epoch
 */
export interface Session {
  idToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/**
 * A sign-in in progress.
 */
export interface PendingLogin {
  codeVerifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

/**
 * The key cookies are encrypted with, from the configured secret.
 *
 * Hashed to the 32 bytes AES-256 wants, so the secret can be any
 * string long enough to be hard to guess.
 *
 * @returns
 */
async function getKey(): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(getSessionSecret()));
  return new Uint8Array(digest);
}

/**
 * A value, encrypted for a cookie.
 *
 * @param payload
 * @param maxAgeSeconds
 * @returns
 */
async function seal(payload: Record<string, unknown>, maxAgeSeconds: number): Promise<string> {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${maxAgeSeconds}s`)
    .encrypt(await getKey());
}

/**
 * A cookie's value, decrypted, or nothing when it's missing, expired
 * or was made with another key.
 *
 * @param value
 * @returns
 */
async function unseal(value: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!value) {
    return undefined;
  }
  try {
    const { payload } = await jwtDecrypt(value, await getKey());
    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * A session, as a cookie value.
 *
 * @param session
 * @returns
 */
export function sealSession(session: Session): Promise<string> {
  return seal({ ...session }, SESSION_MAX_AGE_SECONDS);
}

/**
 * A session from its cookie value.
 *
 * @param value
 * @returns
 */
export async function unsealSession(value: string | undefined): Promise<Session | undefined> {
  const payload = await unseal(value);
  if (typeof payload?.idToken !== "string" || typeof payload.expiresAt !== "number") {
    return undefined;
  }
  return {
    idToken: payload.idToken,
    refreshToken: typeof payload.refreshToken === "string" ? payload.refreshToken : undefined,
    expiresAt: payload.expiresAt,
  };
}

/**
 * A sign-in in progress, as a cookie value.
 *
 * @param login
 * @returns
 */
export function sealLogin(login: PendingLogin): Promise<string> {
  return seal({ ...login }, LOGIN_MAX_AGE_SECONDS);
}

/**
 * A sign-in in progress from its cookie value.
 *
 * @param value
 * @returns
 */
export async function unsealLogin(value: string | undefined): Promise<PendingLogin | undefined> {
  const payload = await unseal(value);
  const fields = ["codeVerifier", "state", "nonce", "returnTo"] as const;
  if (payload === undefined || fields.some((field) => typeof payload[field] !== "string")) {
    return undefined;
  }
  return payload as unknown as PendingLogin;
}

/**
 * Who a session is for, as Authentik says, for showing on the page.
 *
 * Read from the ID token without checking its signature: the token was
 * checked when it was issued to us, and the API server checks it again
 * on every call, so nothing here is trusted for anything but display.
 *
 * @param session
 * @returns
 */
export function sessionIdentity(session: Session): { username: string; groups: string[] } {
  const claims = decodeJwt(session.idToken);
  const username =
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    (typeof claims.email === "string" && claims.email) ||
    (typeof claims.sub === "string" && claims.sub) ||
    "unknown";
  const groups = Array.isArray(claims.groups) ? claims.groups.filter((group) => typeof group === "string") : [];
  return { username, groups };
}

/**
 * Whether the ID token has run out, or will within a minute — soon
 * enough that a request started now could be refused partway.
 *
 * @param session
 * @param now seconds since the epoch
 * @returns
 */
export function needsRefresh(session: Session, now = Date.now() / 1000): boolean {
  return session.expiresAt - 60 <= now;
}

/**
 * Settings for the session and sign-in cookies.
 *
 * @param maxAge seconds
 * @returns
 */
export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    // Only over HTTPS, except on a developer's own machine
    secure: process.env.NODE_ENV === "production",
    // Lax, so the cookie comes back on the redirect from Authentik
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}
