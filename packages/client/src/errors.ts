import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode as JsonRpcErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export type ErrorCode =
  | "INVALID_ARGUMENTS" | "UNKNOWN_COMMAND" | "NOT_FOUND"
  | "NOT_LOGGED_IN" | "AUTH_REQUIRED" | "UNAUTHORIZED" | "LOGIN_FAILED" | "OAUTH_CLIENT_REQUIRED" | "UPSTREAM_AUTH_REQUIRED"
  | "POLICY_DENIED"
  | "PROXY_UNREACHABLE" | "UPSTREAM_ERROR" | "PROTOCOL_ERROR"
  | "TIMEOUT"
  | "TOOL_ERROR" | "INTERNAL_ERROR";

export type NextAction = { description: string; command: string };

/** Exit codes are part of the public contract; see README "Exit codes". */
export const EXIT_CODES: Record<ErrorCode, number> = {
  TOOL_ERROR: 1, INTERNAL_ERROR: 1,
  INVALID_ARGUMENTS: 2, UNKNOWN_COMMAND: 2, NOT_FOUND: 2,
  NOT_LOGGED_IN: 3, AUTH_REQUIRED: 3, UNAUTHORIZED: 3, LOGIN_FAILED: 3, OAUTH_CLIENT_REQUIRED: 3, UPSTREAM_AUTH_REQUIRED: 3,
  POLICY_DENIED: 4,
  PROXY_UNREACHABLE: 5, UPSTREAM_ERROR: 5, PROTOCOL_ERROR: 5,
  TIMEOUT: 6,
};

/** Fentaris proxy JSON-RPC error codes (see @fentaris/core FentarisErrorCode). */
const POLICY_DENIED = -32030;
const UNAUTHORIZED = -32040;
const UPSTREAM_ERROR = -32050;

export class ClientError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly nextActions: NextAction[] = [],
  ) {
    super(message);
    this.name = "ClientError";
  }
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

/** Map SDK, transport, and runtime failures to the stable client error contract. */
export function toClientError(error: unknown, context: { url?: string } = {}): ClientError {
  if (error instanceof ClientError) return error;
  if (error instanceof McpError) {
    const message = error.message.replace(/^MCP error -?\d+: /, "");
    if (error.code === POLICY_DENIED) return new ClientError("POLICY_DENIED", message);
    if (error.code === UNAUTHORIZED) return new ClientError("UNAUTHORIZED", message);
    if (error.code === UPSTREAM_ERROR) return new ClientError("UPSTREAM_ERROR", message);
    if (error.code === JsonRpcErrorCode.RequestTimeout) return new ClientError("TIMEOUT", "The request timed out.");
    if (error.code === JsonRpcErrorCode.InvalidParams) return new ClientError("INVALID_ARGUMENTS", message);
    if (error.code === JsonRpcErrorCode.MethodNotFound) return new ClientError("NOT_FOUND", message);
    return new ClientError("PROTOCOL_ERROR", message, { jsonRpcCode: error.code });
  }
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) return new ClientError("AUTH_REQUIRED", "The proxy rejected the credentials.", { status: 401 });
    if (error.code === 403) return new ClientError("POLICY_DENIED", "The proxy refused access.", { status: 403 });
    if (error.code === 404) return new ClientError("PROXY_UNREACHABLE", `No MCP endpoint was found at ${context.url ?? "the configured URL"}.`, { status: 404 });
    return new ClientError("PROXY_UNREACHABLE", error.message, { status: error.code });
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return new ClientError("TIMEOUT", "The request timed out.");
  const networkCode = findNetworkCode(error);
  if (networkCode) return new ClientError("PROXY_UNREACHABLE", `Cannot reach the Fentaris proxy${context.url ? ` at ${context.url}` : ""} (${networkCode}).`, { cause: networkCode });
  if (error instanceof TypeError && error.message === "fetch failed") return new ClientError("PROXY_UNREACHABLE", `Cannot reach the Fentaris proxy${context.url ? ` at ${context.url}` : ""}.`);
  return new ClientError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
}

function findNetworkCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && (NETWORK_CODES.has(code) || code.startsWith("CERT_") || code.startsWith("ERR_TLS"))) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
