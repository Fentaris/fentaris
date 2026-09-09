import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { assertAllowedUpstreamUrl, BlockedUpstreamUrlError, type UpstreamHttpNetworkOptions } from "./upstreamUrlGuardrails.js";

const maxRedirects = 10;

/**
 * Wrap a fetch implementation so every outbound URL, including authorization-server
 * requests made by the OAuth client provider, passes the upstream network guardrails.
 *
 * Redirects are followed manually: the platform `fetch` would otherwise follow them
 * itself, letting a public host redirect to a private or link-local address that the
 * guardrails never see.
 * @pk
 */
export function guardedUpstreamFetch(network: UpstreamHttpNetworkOptions | undefined, base?: FetchLike): FetchLike {
  const inner: FetchLike = base ?? ((input, init) => fetch(input as RequestInfo, init as RequestInit));

  return async (input, init) => {
    const requested = (init?.redirect ?? "follow") as RequestRedirect;
    let currentUrl = new URL(urlOf(input));
    let currentInit: RequestInit | undefined = init as RequestInit | undefined;

    for (let hop = 0; ; hop += 1) {
      await assertAllowedUpstreamUrl(currentUrl, network);

      // A caller that asked for manual or error handling keeps that behavior; only the
      // implicit "follow" mode needs to be taken over so every hop stays guarded.
      const response = await inner(currentUrl.toString(), {
        ...currentInit,
        redirect: requested === "follow" ? "manual" : requested,
      } as RequestInit);

      if (requested !== "follow" || !isRedirect(response.status)) {
        return response;
      }

      const location = response.headers.get("location");
      if (!location) {
        return response;
      }

      if (hop >= maxRedirects) {
        throw new BlockedUpstreamUrlError(currentUrl, `too many redirects (${maxRedirects})`);
      }

      const next = new URL(location, currentUrl);
      currentInit = redirectInit(currentInit, response.status, currentUrl, next);
      currentUrl = next;
    }
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

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Build the request init for the next hop, following the fetch redirect rules: 303 (and
 * 301/302 on POST) degrade to GET without a body, and credentials are dropped when the
 * origin changes.
 */
function redirectInit(init: RequestInit | undefined, status: number, from: URL, to: URL): RequestInit {
  const next: RequestInit = { ...init };
  const method = (init?.method ?? "GET").toUpperCase();

  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    next.method = "GET";
    delete next.body;
  }

  if (from.origin !== to.origin) {
    const headers = new Headers(next.headers as HeadersInit | undefined);
    headers.delete("authorization");
    headers.delete("cookie");
    next.headers = headers;
  }

  return next;
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
