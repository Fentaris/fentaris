/**
 * Hosted OAuth redirect callback for upstream authorizations.
 * @pk
 */

import type { ServerResponse } from "node:http";
import type { OAuthManager } from "../../auth/oauth/manager.js";
import { normalizeExposurePath, type ProxyExposureHttpRoute } from "./routeRegistry.js";

export type OAuthCallbackRouteOptions = {
  readonly manager: OAuthManager;
  readonly path: string;
  readonly onError?: (message: string) => void;
};

/**
 * Build the `GET <callbackPath>` route that completes an upstream authorization.
 * Authorization codes and state values are never logged.
 * @pk
 */
export function createOAuthCallbackRoutes(options: OAuthCallbackRouteOptions): {
  readonly httpRoutes: readonly ProxyExposureHttpRoute[];
} {
  const path = normalizeExposurePath(options.path);

  return {
    httpRoutes: [
      {
        method: "GET",
        path,
        handler: async (_req, res, url) => {
          const state = url.searchParams.get("state") ?? "";
          const code = url.searchParams.get("code") ?? undefined;
          const error = url.searchParams.get("error") ?? undefined;
          const errorDescription = url.searchParams.get("error_description") ?? undefined;

          if (!state) {
            sendPage(res, 400, "Authorization failed", "The callback did not include a state parameter.");
            return;
          }

          try {
            const completed = await options.manager.completeCallback({
              state,
              ...(code ? { code } : {}),
              ...(error ? { error } : {}),
              ...(errorDescription ? { errorDescription } : {}),
            });
            sendPage(res, 200, "Signed in", `You can close this tab and return to your MCP client. Server: ${escapeHtml(completed.server)}.`);
          } catch (caught: unknown) {
            const message = caught instanceof Error ? caught.message : "Authorization could not be completed.";
            options.onError?.(message);
            const status = message.includes("Unknown or expired") ? 410 : 400;
            sendPage(res, status, "Authorization failed", message);
          }
        },
      },
    ],
  };
}

function sendPage(res: ServerResponse, status: number, title: string, message: string): void {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem;line-height:1.5}h1{font-size:1.25rem}</style>` +
    `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
