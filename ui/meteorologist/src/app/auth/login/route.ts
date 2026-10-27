/**
 * @file
 * Starts signing in: off to Authentik, remembering how to finish.
 */
import { NextResponse, type NextRequest } from "next/server";

import { beginLogin } from "@/lib/auth/oidc";
import { LOGIN_COOKIE, LOGIN_MAX_AGE_SECONDS, cookieOptions, sealLogin } from "@/lib/auth/session";
import { getOidcSettings, signsIn } from "@/lib/config";
import { setupProblem, textResponse } from "@/lib/setupError";

/**
 * @param request
 * @returns
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const problem = setupProblem();
  if (problem !== undefined) {
    return problem;
  }
  if (!signsIn()) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  let started;
  try {
    started = await beginLogin(request.nextUrl.searchParams.get("returnTo") ?? "/");
  } catch (error) {
    // Most often Authentik unreachable, or the issuer URL wrong
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Signing in through ${getOidcSettings().issuer} failed: ${reason}`);
    return textResponse(502, `Couldn't start signing in through ${getOidcSettings().issuer}: ${reason}`);
  }
  const { url, login } = started;
  const response = NextResponse.redirect(url);
  response.cookies.set(LOGIN_COOKIE, await sealLogin(login), cookieOptions(LOGIN_MAX_AGE_SECONDS));
  return response;
}
