/**
 * @file
 * Starts signing in: off to Authentik, remembering how to finish.
 */
import { NextResponse, type NextRequest } from "next/server";

import { beginLogin } from "@/lib/auth/oidc";
import { LOGIN_COOKIE, LOGIN_MAX_AGE_SECONDS, cookieOptions, sealLogin } from "@/lib/auth/session";
import { signsIn } from "@/lib/config";

/**
 * @param request
 * @returns
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!signsIn()) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  const { url, login } = await beginLogin(request.nextUrl.searchParams.get("returnTo") ?? "/");
  const response = NextResponse.redirect(url);
  response.cookies.set(LOGIN_COOKIE, await sealLogin(login), cookieOptions(LOGIN_MAX_AGE_SECONDS));
  return response;
}
