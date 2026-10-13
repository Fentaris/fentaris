/** Discoverable browser entrypoints for downstream and upstream authentication. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { UserContext } from "../../types/shared.js";
import { normalizeExposurePath, type ProxyExposureHttpRoute } from "./routeRegistry.js";

export const DEFAULT_FENTARIS_LOGIN_PATH = "/_fentaris/login";
export const DEFAULT_UPSTREAM_AUTH_PATH = "/_fentaris/auth";

export type UpstreamAuthEntry = {
  server: string;
  account?: string;
  status: "authenticated" | "requires-login" | "setup-required";
  loginUrl?: string;
  guidance?: string;
};

export type AuthEntrypointRouteOptions = {
  downstreamLoginUrl?: string;
  downstreamPath?: string;
  upstreamPath?: string;
  publicBaseUrl?: string;
  resolveCaller(request: IncomingMessage): Promise<{ user: UserContext; authenticated: boolean }>;
  setUnauthorizedChallenge?(request: IncomingMessage, response: ServerResponse): void;
  catalog(user: UserContext, baseUrl: string): Promise<UpstreamAuthEntry[]>;
  beginLogin(server: string, account: string | undefined, user: UserContext): Promise<{ authorizationUrl?: string; status: string; guidance?: string }>;
};

/** Build side-effect-free discovery routes and an explicit OAuth initiation route. */
export function createAuthEntrypointRoutes(options: AuthEntrypointRouteOptions): { httpRoutes: readonly ProxyExposureHttpRoute[] } {
  const downstreamPath = normalizeExposurePath(options.downstreamPath ?? DEFAULT_FENTARIS_LOGIN_PATH);
  const upstreamPath = normalizeExposurePath(options.upstreamPath ?? DEFAULT_UPSTREAM_AUTH_PATH);
  const routes: ProxyExposureHttpRoute[] = [];
  routes.push({ method: "GET", path: upstreamPath, async handler(req, res) {
    const baseUrl = options.publicBaseUrl ?? `http://${req.headers.host ?? "localhost"}`;
    const caller = await options.resolveCaller(req);
    if (!caller.authenticated) { options.setUnauthorizedChallenge?.(req, res); json(res, 401, { error: "authentication_required", login: options.downstreamLoginUrl ? absolute(baseUrl, downstreamPath) : undefined }); return; }
    json(res, 200, { servers: await options.catalog(caller.user, baseUrl) });
  } });
  routes.push({ method: "POST", path: `${upstreamPath}/login`, async handler(req, res, url) {
    const caller = await options.resolveCaller(req);
    if (!caller.authenticated) { options.setUnauthorizedChallenge?.(req, res); json(res, 401, { error: "authentication_required" }); return; }
    const server = url.searchParams.get("server")?.trim(); const account = url.searchParams.get("account")?.trim() || undefined;
    if (!server) { json(res, 400, { error: "server_required" }); return; }
    try {
      const started = await options.beginLogin(server, account, caller.user);
      if (!started.authorizationUrl) { json(res, 200, { server, ...(account ? { account } : {}), status: started.status, ...(started.guidance ? { guidance: started.guidance } : {}) }); return; }
      res.writeHead(303, { location: started.authorizationUrl, "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end();
    } catch (error) { json(res, 400, { error: "login_unavailable", message: error instanceof Error ? error.message : "Login could not be started." }); }
  } });
  return { httpRoutes: routes };
}

function absolute(base: string, path: string): string { return `${base.replace(/\/$/, "")}${normalizeExposurePath(path)}`; }
function json(res: ServerResponse, status: number, value: unknown): void { const body = JSON.stringify(value); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end(body); }
