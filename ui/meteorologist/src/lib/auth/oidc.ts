/**
 * @file
 * Signing in through Authentik, with OpenID Connect.
 *
 * The ordinary authorization code flow with PKCE: send the person to
 * Authentik, take the code they come back with, trade it for tokens.
 * The ID token is the one that matters here, since it's what the
 * Kubernetes API server accepts — the same arrangement Headlamp uses,
 * described in installer/src/cli/commands/ClusterSignIn.ts. The API
 * server only accepts tokens issued to clients it's been told about,
 * so Meteorologist's client has to be one of them.
 *
 * openid-client does the protocol: discovery, the token exchange, and
 * checking the ID token's signature, issuer, audience and nonce.
 */
import * as client from "openid-client";

import { getOidcSettings } from "../config";
import type { PendingLogin, Session } from "./session";

// Discovery is a round trip to Authentik; once per process is enough
let configuration: Promise<client.Configuration> | undefined;

/**
 * Authentik's endpoints and keys, and this client's credentials.
 *
 * @returns
 */
function getConfiguration(): Promise<client.Configuration> {
  if (configuration === undefined) {
    const settings = getOidcSettings();
    configuration = client
      .discovery(
        new URL(settings.issuer),
        settings.clientId,
        undefined,
        settings.clientSecret !== undefined ? client.ClientSecretBasic(settings.clientSecret) : client.None(),
      )
      .catch((error: unknown) => {
        // Try again next time rather than remembering the failure
        configuration = undefined;
        throw error;
      });
  }
  return configuration;
}

/**
 * The address Authentik sends people back to.
 *
 * @returns
 */
export function callbackUrl(): string {
  return `${getOidcSettings().publicUrl}/auth/callback`;
}

/**
 * Only paths on this site, so a crafted sign-in link can't send
 * someone elsewhere afterwards.
 *
 * @param returnTo
 * @returns
 */
export function safeReturnTo(returnTo: string | null | undefined): string {
  return returnTo && returnTo.startsWith("/") && !/^\/[/\\]/.test(returnTo) ? returnTo : "/";
}

/**
 * Where to send someone to sign in, and what to remember until they
 * come back.
 *
 * @param returnTo the page to show afterwards
 * @returns
 */
export async function beginLogin(returnTo: string): Promise<{ url: URL; login: PendingLogin }> {
  const config = await getConfiguration();
  const codeVerifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl(),
    scope: getOidcSettings().scopes,
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });

  return { url, login: { codeVerifier, state, nonce, returnTo: safeReturnTo(returnTo) } };
}

/**
 * A session, from the address Authentik sent someone back to.
 *
 * @param callback the full callback address, as the browser asked for it
 * @param login what was remembered when they left
 * @returns
 */
export async function completeLogin(callback: URL, login: PendingLogin): Promise<Session> {
  const config = await getConfiguration();
  const tokens = await client.authorizationCodeGrant(config, callback, {
    pkceCodeVerifier: login.codeVerifier,
    expectedState: login.state,
    expectedNonce: login.nonce,
    idTokenExpected: true,
  });
  return toSession(tokens);
}

/**
 * A new session from a refresh token, with a fresh ID token.
 *
 * @param session
 * @returns
 */
export async function refreshSession(session: Session): Promise<Session> {
  if (session.refreshToken === undefined) {
    throw new Error("No refresh token; signing in again is the only way to a new ID token.");
  }
  const config = await getConfiguration();
  const tokens = await client.refreshTokenGrant(config, session.refreshToken);
  return toSession(tokens, session.refreshToken);
}

/**
 * Where to send someone to sign out of Authentik too, when it says.
 *
 * @param session
 * @returns nothing, when Authentik has no end-session endpoint
 */
export async function logoutUrl(session: Session | undefined): Promise<URL | undefined> {
  const config = await getConfiguration();
  if (config.serverMetadata().end_session_endpoint === undefined) {
    return undefined;
  }
  return client.buildEndSessionUrl(config, {
    post_logout_redirect_uri: `${getOidcSettings().publicUrl}/`,
    ...(session ? { id_token_hint: session.idToken } : {}),
  });
}

/**
 * A session from a token response.
 *
 * @param tokens
 * @param previousRefreshToken kept when a refresh doesn't hand out a new one
 * @returns
 */
function toSession(
  tokens: Awaited<ReturnType<typeof client.refreshTokenGrant>>,
  previousRefreshToken?: string,
): Session {
  const claims = tokens.claims();
  if (tokens.id_token === undefined || claims === undefined) {
    throw new Error("Authentik didn't return an ID token. Is the openid scope allowed for this client?");
  }
  return {
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token ?? previousRefreshToken,
    expiresAt: claims.exp,
  };
}
