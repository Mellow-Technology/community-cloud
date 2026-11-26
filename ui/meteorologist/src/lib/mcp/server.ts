/**
 * @file
 * The MCP protocol, as far as these tools need it: JSON-RPC over
 * Streamable HTTP, without sessions or streams.
 *
 * Every request is a POST, and nothing is kept between requests: each
 * one comes with its token, and the namespace and client are worked
 * out from that afresh (../../app/mcp/route.ts). So there's no session
 * to resume and nothing for the server to send unasked, and GET, which
 * would open a stream for that, is refused.
 *
 * Most POSTs are answered with JSON. A tool call that waits for a
 * rollout is answered as a stream of server-sent events instead, on
 * that request alone: its progress notifications, if the client gave
 * a progressToken to send them with, and then its result. That's the
 * transport's own way for one request to say things before it
 * answers, and it needs no session.
 *
 * Only tools are offered. Anything else the protocol has (resources,
 * prompts, sampling) a client finds isn't there from the capabilities
 * initialize returns.
 */
import packageJson from "../../../package.json";
import { INSTRUCTIONS } from "./instructions";
import { readCapabilities } from "./capabilities";
import { callTool, listTools, waits, type ToolContext } from "./tools";

// Newest first: what's offered to a client asking for a version this
// doesn't know
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

/**
 * What a message is handled with besides the agent's context: where
 * to send notifications while it runs, and whether the client has gone.
 */
export interface HandleOptions {
  notify?: (notification: JsonRpcNotification) => void;
  signal?: AbortSignal;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// JSON-RPC's own error codes
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

/**
 * Whether something is a JSON-RPC request or notification.
 *
 * @param message
 * @returns
 */
function isRequest(message: unknown): message is JsonRpcRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as JsonRpcRequest).jsonrpc === "2.0" &&
    typeof (message as JsonRpcRequest).method === "string"
  );
}

/**
 * The token a client asked for progress to be sent with, if it did.
 *
 * @param params
 * @returns
 */
function progressTokenOf(params: Record<string, unknown>): string | number | undefined {
  const meta = params._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const token = (meta as { progressToken?: unknown }).progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

/**
 * Whether a message is a tool call that will wait, and so is answered
 * as a stream.
 *
 * @param message
 * @returns
 */
export function isWaitingCall(message: unknown): boolean {
  if (!isRequest(message) || message.method !== "tools/call" || typeof message.params?.name !== "string") {
    return false;
  }
  const args = message.params.arguments;
  return waits(message.params.name, typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {});
}

/**
 * A failure, as JSON-RPC says it.
 *
 * @param id
 * @param code
 * @param message
 * @returns
 */
export function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * The answer to one message, or nothing for a notification, which
 * isn't answered.
 *
 * @param message
 * @param context the agent's client and namespace, made only when a
 *   tool is called
 * @param options
 * @returns
 */
export async function handleMessage(
  message: unknown,
  context: () => Promise<ToolContext>,
  options: HandleOptions = {},
): Promise<JsonRpcResponse | undefined> {
  if (!isRequest(message)) {
    return rpcError(null, INVALID_REQUEST, "Not a JSON-RPC 2.0 request.");
  }
  if (message.id === undefined) {
    // notifications/initialized, notifications/cancelled and the like:
    // there's nothing here they'd change
    return undefined;
  }
  const id = message.id;
  const params = message.params ?? {};

  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: asked !== undefined && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "meteorologist", title: "Community Cloud", version: packageJson.version },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": {
      const { kube, namespace } = await context();
      return { jsonrpc: "2.0", id, result: { tools: listTools(await readCapabilities(kube, namespace)) } };
    }
    case "tools/call": {
      if (typeof params.name !== "string") {
        return rpcError(id, INVALID_PARAMS, "Say which tool to call.");
      }
      const args =
        typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const progressToken = progressTokenOf(params);
      let step = 0;
      const progress =
        options.notify !== undefined && progressToken !== undefined
          ? (text: string) => {
              step += 1;
              options.notify?.({
                jsonrpc: "2.0",
                method: "notifications/progress",
                // No total: how many steps a rollout takes isn't known
                params: { progressToken, progress: step, message: text },
              });
            }
          : undefined;
      const result = await callTool({ ...(await context()), progress, signal: options.signal }, params.name, args);
      return result === undefined
        ? rpcError(id, INVALID_PARAMS, `There's no tool called ${params.name}.`)
        : { jsonrpc: "2.0", id, result };
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `${message.method} isn't something this server does.`);
  }
}
