/**
 * @file
 * WebApplication changes, as server-sent events, for LiveRefresh. See
 * src/lib/webapp/live.ts.
 */
import type { NextRequest } from "next/server";

import { getKube } from "@/lib/kube";
import { liveStream, watchScopes } from "@/lib/webapp/live";

/**
 * @param request
 * @returns
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl;
  const kube = await getKube();
  const scopes = await watchScopes(kube, {
    namespace: searchParams.get("namespace") ?? undefined,
    name: searchParams.get("name") ?? undefined,
  });
  if (scopes.length === 0) {
    return new Response(null, { status: 204 });
  }
  return new Response(liveStream(kube, scopes, request.signal), {
    headers: {
      "Content-Type": "text/event-stream",
      // "no-transform" so nothing compresses it, which would hold
      // events back until a buffer filled
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
