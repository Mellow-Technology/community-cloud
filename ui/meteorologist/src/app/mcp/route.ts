/**
 * @file
 * The MCP endpoint agents manage a namespace's applications through.
 * See src/lib/mcp/server.ts for the protocol and tools.ts for the
 * tools.
 *
 * It's outside the session proxy (src/proxy.ts): an agent has no
 * session, only its bearer token, which is checked by the API server
 * on every request.
 */
import { getPublicUrl } from "@/lib/config";
import { Unauthorised, contextFor } from "@/lib/mcp/identity";
import {
  INVALID_REQUEST,
  PARSE_ERROR,
  handleMessage,
  isWaitingCall,
  rpcError,
  type JsonRpcResponse,
} from "@/lib/mcp/server";
import type { ToolContext } from "@/lib/mcp/tools";

export const dynamic = "force-dynamic";

// Often enough that the Gateway doesn't take a quiet stream for a dead
// one, as for the live pages (src/lib/webapp/live.ts)
const KEEPALIVE_MS = 15_000;

/**
 * A tool call that waits, answered as server-sent events: progress
 * notifications as they come, a comment now and then so the
 * connection isn't idle, and the result last.
 *
 * @param message
 * @param resolve
 * @param signal the client going away
 * @returns
 */
function streamed(message: unknown, resolve: () => Promise<ToolContext>, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The client went away; the wait sees the abort and stops
          open = false;
        }
      };
      const event = (data: unknown) => send(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
      const keepalive = setInterval(() => send(": still waiting\n\n"), KEEPALIVE_MS);
      try {
        const answer = await handleMessage(message, resolve, { notify: event, signal });
        if (answer !== undefined) event(answer);
      } catch (error) {
        const id = (message as { id?: string | number }).id ?? null;
        event(rpcError(id, INVALID_REQUEST, error instanceof Error ? error.message : String(error)));
      } finally {
        clearInterval(keepalive);
        if (open) controller.close();
        open = false;
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
  });
}

/**
 * A JSON answer.
 *
 * @param body
 * @param status
 * @param headers
 * @returns
 */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

/**
 * @param request
 * @returns
 */
export async function POST(request: Request): Promise<Response> {
  // A page in a browser can't be made to post here for someone else:
  // MCP clients send no Origin, and a browser's must be our own
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(getPublicUrl()).origin) {
    return json(rpcError(null, INVALID_REQUEST, "Requests from other sites aren't accepted."), 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, PARSE_ERROR, "The body isn't JSON."), 400);
  }

  // Worked out once a request needs it, and then once for all of it
  let context: Promise<ToolContext> | undefined;
  const resolve = () => (context ??= contextFor(request));

  try {
    // Checked first, so a bad token is a 401 whatever was asked
    await resolve();
    // One waiting call, from a client that takes a stream (every
    // Streamable HTTP client must)
    const accepts = request.headers.get("accept") ?? "";
    if (!Array.isArray(body) && accepts.includes("text/event-stream") && isWaitingCall(body)) {
      return streamed(body, resolve, request.signal);
    }
    const messages = Array.isArray(body) ? body : [body];
    const answers = (await Promise.all(messages.map((message) => handleMessage(message, resolve)))).filter(
      (answer): answer is JsonRpcResponse => answer !== undefined,
    );
    if (answers.length === 0) {
      return new Response(null, { status: 202 });
    }
    return json(Array.isArray(body) ? answers : answers[0]);
  } catch (error) {
    if (error instanceof Unauthorised) {
      return json(
        rpcError(null, INVALID_REQUEST, error.message),
        error.status,
        error.status === 401 ? { "WWW-Authenticate": 'Bearer realm="meteorologist"' } : {},
      );
    }
    throw error;
  }
}

/**
 * No stream to open: nothing is ever sent unasked.
 *
 * @returns
 */
export function GET(): Response {
  return new Response("This endpoint answers POSTs only.", { status: 405, headers: { Allow: "POST" } });
}

/**
 * No session to end.
 *
 * @returns
 */
export function DELETE(): Response {
  return new Response("There are no sessions to end.", { status: 405, headers: { Allow: "POST" } });
}
