import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { assertAllowedUpstreamUrl, type UpstreamHttpNetworkOptions } from "./upstreamUrlGuardrails.js";

/**
 * Wrap a fetch implementation so every outbound URL, including authorization-server
 * requests made by the OAuth client provider, passes the upstream network guardrails.
 * @pk
 */
export function guardedUpstreamFetch(network: UpstreamHttpNetworkOptions | undefined, base?: FetchLike): FetchLike {
  const inner: FetchLike = base ?? ((input, init) => fetch(input as RequestInfo, init as RequestInit));

  return async (input, init) => {
    await assertAllowedUpstreamUrl(new URL(urlOf(input)), network);
    return inner(input, init);
  };
}

/**
 * Whether an upstream failure means the current authorization is definitively rejected.
 * @pk
 */
export function isDefinitiveUnauthorized(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current instanceof UnauthorizedError) {
      return true;
    }

    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}

function urlOf(input: Parameters<FetchLike>[0]): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return (input as Request).url;
}
