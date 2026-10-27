/**
 * @file
 * Makes sure every page is seen by someone signed in, with an ID token
 * that's still good.
 *
 * Authentik's ID tokens last minutes, and the API server refuses one a
 * second past its expiry. Refreshing has to happen before a page
 * starts rendering, since it means writing a new cookie and pages
 * can't; this is the one place that runs first and can. The new cookie
 * goes both to the browser and on to the page being rendered, so the
 * page sees the fresh token on this same request.
 *
 * Only when people sign in at all. In the development modes there's no
 * one to sign in, and this lets everything through.
 */
import { NextResponse, type NextRequest } from "next/server";

import { refreshSession } from "./lib/auth/oidc";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  cookieOptions,
  needsRefresh,
  sealSession,
  unsealSession,
} from "./lib/auth/session";
import { getOidcSettings, signsIn } from "./lib/config";

/**
 * Sends someone to sign in, and back here afterwards.
 *
 * @param request
 * @returns
 */
function toLogin(request: NextRequest): NextResponse {
  // The public address, not the request's: behind the Gateway that's
  // the pod's own, over plain HTTP
  const login = new URL("/auth/login", getOidcSettings().publicUrl);
  login.searchParams.set("returnTo", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  const response = NextResponse.redirect(login);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

/**
 * @param request
 * @returns
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (!signsIn()) {
    return NextResponse.next();
  }

  const session = await unsealSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (session === undefined) {
    return toLogin(request);
  }
  if (!needsRefresh(session)) {
    return NextResponse.next();
  }

  try {
    const sealed = await sealSession(await refreshSession(session));
    // For the page rendering this request
    request.cookies.set(SESSION_COOKIE, sealed);
    const response = NextResponse.next({ request: { headers: request.headers } });
    // For the browser, for every request after
    response.cookies.set(SESSION_COOKIE, sealed, cookieOptions(SESSION_MAX_AGE_SECONDS));
    return response;
  } catch {
    // Refresh token gone, revoked or expired: only signing in helps
    return toLogin(request);
  }
}

export const config = {
  // Everything but sign-in itself, the health check, and Next's own
  // files
  matcher: ["/((?!auth/|healthz|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
