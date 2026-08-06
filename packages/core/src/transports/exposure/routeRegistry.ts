/**
 * Extended exposure contracts for registering HTTP routes and WebSocket
 * upgrades alongside the MCP endpoint on one owned listener.
 * @pk
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/** HTTP route handler registered on the shared exposure listener. @pk */
export type ProxyExposureHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => void | Promise<void>;

/** WebSocket upgrade handler registered on the shared exposure listener. @pk */
export type ProxyExposureUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
) => void | Promise<void>;

/** One owned HTTP route beneath the exposure listener. @pk */
export type ProxyExposureHttpRoute = {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  readonly path: string;
  readonly handler: ProxyExposureHttpRouteHandler;
};

/** One owned WebSocket upgrade path beneath the exposure listener. @pk */
export type ProxyExposureUpgradeRoute = {
  readonly path: string;
  readonly handler: ProxyExposureUpgradeHandler;
};

/** Optional route/upgrade registration surface for exposure transports. @pk */
export type ProxyExposureRouteRegistry = {
  readonly httpRoutes?: readonly ProxyExposureHttpRoute[];
  readonly upgradeRoutes?: readonly ProxyExposureUpgradeRoute[];
};

/** True when two absolute paths overlap as prefixes or exact matches. @pk */
export function exposurePathsConflict(left: string, right: string): boolean {
  const a = normalizeExposurePath(left);
  const b = normalizeExposurePath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Normalize an exposure path to a non-trailing-slash absolute form. @pk */
export function normalizeExposurePath(value: string): string {
  const trimmed = value.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || "/";
}
