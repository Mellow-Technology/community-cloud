/**
 * @file
 * Finishes signing in, when Authentik sends someone back.
 *
 * The address Authentik redirected to is rebuilt from METEOROLOGIST_URL
 * rather than taken from the request. Behind the Gateway the request
 * arrives as plain HTTP on the pod's own address, and the token
 * exchange has to quote the redirect URI exactly as it was sent.
 */
import { NextResponse, type NextRequest } from "next/server";

import { callbackUrl, completeLogin } from "@/lib/auth/oidc";
import {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  cookieOptions,
  sealSession,
  unsealLogin,
} from "@/lib/auth/session";
import { getOidcSettings } from "@/lib/config";

/**
 * @param request
 * @returns
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const login = await unsealLogin(request.cookies.get(LOGIN_COOKIE)?.value);
  if (login === undefined) {
    // Too slow, or a callback nobody here started: begin again
    return NextResponse.redirect(new URL("/auth/login", getOidcSettings().publicUrl));
  }

  const callback = new URL(callbackUrl());
  callback.search = request.nextUrl.search;

  try {
    const session = await completeLogin(callback, login);
    const response = NextResponse.redirect(new URL(login.returnTo, getOidcSettings().publicUrl));
    response.cookies.set(SESSION_COOKIE, await sealSession(session), cookieOptions(SESSION_MAX_AGE_SECONDS));
    response.cookies.delete(LOGIN_COOKIE);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new NextResponse(`Signing in didn't work: ${message}`, {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
