/**
 * @file
 * Signs out: forgets the session here, and ends it at Authentik too
 * when Authentik offers a way, so the next sign-in asks again.
 *
 * A POST, so that a link on some other site can't sign people out.
 */
import { NextResponse, type NextRequest } from "next/server";

import { logoutUrl } from "@/lib/auth/oidc";
import { SESSION_COOKIE, unsealSession } from "@/lib/auth/session";
import { getOidcSettings, signsIn } from "@/lib/config";

/**
 * @param request
 * @returns
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!signsIn()) {
    return NextResponse.redirect(new URL("/", request.url), 303);
  }
  const session = await unsealSession(request.cookies.get(SESSION_COOKIE)?.value);
  const destination = (await logoutUrl(session).catch(() => undefined)) ?? new URL("/", getOidcSettings().publicUrl);
  const response = NextResponse.redirect(destination, 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
