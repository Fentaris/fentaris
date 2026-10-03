import type { ProxyRuntime } from "../../types/proxy.js";
import type { ProxyExposureHttpRoute } from "./routeRegistry.js";
import { normalizeExposurePath } from "./routeRegistry.js";

/** Public RFC 9728 routes on the exposure listener. */
export function oauthResourceMetadataRoutes(runtime: ProxyRuntime, mcpPath: string): ProxyExposureHttpRoute[] {
  if (!runtime.protectedResourceMetadata) return [];
  const resourcePath = new URL(runtime.protectedResourceMetadata().resource).pathname;
  const paths = [mcpPath, resourcePath].map((value) => normalizeExposurePath(value) === "/" ? "" : normalizeExposurePath(value));
  return [...new Set(["/.well-known/oauth-protected-resource", ...paths.map((suffix) => `/.well-known/oauth-protected-resource${suffix}`)])].map((path) => ({
    method: "GET" as const,
    path,
    handler(_req, res) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(runtime.protectedResourceMetadata!()));
    },
  }));
}
