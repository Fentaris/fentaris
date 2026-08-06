/**
 * HTTP and WebSocket route handlers for the integrated Edge control plane.
 * @pk
 */

import { EDGE_CONTROL_PLANE_ERROR_CODES, edgeControlPlaneError } from "../../edge/integratedProtocol.js";
import type { IntegratedEdgeAuthServices } from "../../edge/integratedAuthServices.js";
import type {
  ProxyExposureHttpRoute,
} from "./routeRegistry.js";
import { normalizeExposurePath } from "./routeRegistry.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export type EdgeControlPlaneRouteOptions = {
  readonly basePath: string;
  readonly auth: IntegratedEdgeAuthServices;
  readonly maxRequestBytes: number;
};

/** Build the reserved Edge HTTP routes under the configured base path. @pk */
export function createEdgeControlPlaneRoutes(
  options: EdgeControlPlaneRouteOptions,
): {
  readonly httpRoutes: readonly ProxyExposureHttpRoute[];
} {
  const base = normalizeExposurePath(options.basePath);
  const httpRoutes: ProxyExposureHttpRoute[] = [
    {
      method: "POST",
      path: `${base}/device/authorize`,
      handler: async (req, res) => {
        await handleJson(req, res, options.maxRequestBytes, async (body) => {
          const result = await options.auth.begin({
            clientId: stringField(body, "clientId") ?? "fentaris-edge",
            ...(stringField(body, "tenantId") ? { tenantId: stringField(body, "tenantId") } : {}),
          });
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: "POST",
      path: `${base}/device/token`,
      handler: async (req, res) => {
        await handleJson(req, res, options.maxRequestBytes, async (body) => {
          const result = await options.auth.poll({
            clientId: stringField(body, "clientId") ?? "fentaris-edge",
            deviceCode: requiredString(body, "deviceCode"),
          });
          if (result.status === "authorized") {
            sendJson(res, 200, result.tokens);
            return;
          }
          if (result.status === "pending") {
            sendJson(res, 400, edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES.authorization_pending, undefined, {
              interval: result.interval,
            }));
            return;
          }
          if (result.status === "slow-down") {
            sendJson(res, 400, edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES.slow_down, undefined, {
              interval: result.interval,
            }));
            return;
          }
          if (result.status === "denied") {
            sendJson(res, 400, edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES.access_denied));
            return;
          }
          sendJson(res, 400, edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES.expired_token));
        });
      },
    },
    {
      method: "POST",
      path: `${base}/token/refresh`,
      handler: async (req, res) => {
        await handleJson(req, res, options.maxRequestBytes, async (body) => {
          const tokens = await options.auth.refresh({
            clientId: stringField(body, "clientId") ?? "fentaris-edge",
            refreshToken: requiredString(body, "refreshToken"),
          });
          sendJson(res, 200, tokens);
        });
      },
    },
    {
      method: "POST",
      path: `${base}/edge/enroll`,
      handler: async (req, res) => {
        await handleJson(req, res, options.maxRequestBytes, async (body) => {
          const accessToken = bearerToken(req) ?? requiredString(body, "accessToken");
          const enrolled = await options.auth.enroll({
            accessToken,
            publicKey: requiredString(body, "publicKey"),
            deviceCode: requiredString(body, "deviceCode"),
            nonce: requiredString(body, "nonce"),
            proof: requiredString(body, "proof"),
            ...(stringField(body, "hostnameLabel") ? { hostnameLabel: stringField(body, "hostnameLabel") } : {}),
            ...(stringField(body, "name") ? { name: stringField(body, "name") } : {}),
            ...(stringField(body, "description") ? { description: stringField(body, "description") } : {}),
            ...(Array.isArray(body.tags) ? { tags: body.tags.filter((entry): entry is string => typeof entry === "string") } : {}),
          });
          sendJson(res, 200, enrolled);
        });
      },
    },
    {
      method: "POST",
      path: `${base}/edge/revoke`,
      handler: async (req, res) => {
        await handleJson(req, res, options.maxRequestBytes, async (body) => {
          const accessToken = bearerToken(req);
          if (!accessToken) {
            sendJson(res, 401, edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized));
            return;
          }
          await options.auth.revoke({ edgeNodeId: requiredString(body, "edgeNodeId") }, accessToken);
          sendJson(res, 200, { ok: true });
        });
      },
    },
    {
      method: "GET",
      path: `${base}/device/verify`,
      handler: async (_req, res, url) => {
        const userCode = url.searchParams.get("user_code") ?? "";
        sendText(
          res,
          200,
          [
            "Fentaris Edge device authorization",
            "",
            userCode ? `User code: ${userCode}` : "Provide the user code shown by your Edge agent.",
            "Approve with: fentaris edge approve <user-code>",
            "This page never auto-approves enrollment requests.",
          ].join("\n"),
          "text/plain; charset=utf-8",
        );
      },
    },
  ];

  return { httpRoutes };
}

async function handleJson(
  req: IncomingMessage,
  res: ServerResponse,
  maxRequestBytes: number,
  handler: (body: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  try {
    const raw = await readBody(req, maxRequestBytes);
    const body = raw.length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES.invalid_request));
      return;
    }
    await handler(body);
  } catch (error) {
    const code = (error as { controlPlaneCode?: string }).controlPlaneCode;
    if (code === EDGE_CONTROL_PLANE_ERROR_CODES.payload_too_large) {
      sendJson(res, 413, edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES.payload_too_large));
      return;
    }
    if (code === EDGE_CONTROL_PLANE_ERROR_CODES.rate_limited) {
      sendJson(res, 429, edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES.rate_limited));
      return;
    }
    if (code === EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized || code === EDGE_CONTROL_PLANE_ERROR_CODES.invalid_grant) {
      sendJson(res, 401, edgeControlPlaneError(code));
      return;
    }
    if (error instanceof SyntaxError) {
      sendJson(res, 400, edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES.invalid_request));
      return;
    }
    sendJson(res, 500, edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES.server_error));
  }
}

function readBody(req: IncomingMessage, maxRequestBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxRequestBytes) {
        reject(Object.assign(new Error("payload too large"), {
          controlPlaneCode: EDGE_CONTROL_PLANE_ERROR_CODES.payload_too_large,
        }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key);
  if (!value) {
    throw Object.assign(new Error(`Missing ${key}`), {
      controlPlaneCode: EDGE_CONTROL_PLANE_ERROR_CODES.invalid_request,
    });
  }
  return value;
}
