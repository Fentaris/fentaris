import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { MaybePromise } from "../../types/shared.js";

/**
 * Private-network guardrails for upstream HTTP-family transports.
 * @pk
 */
export type UpstreamHttpNetworkOptions = {
  allowPrivateNetworkUrls?: boolean;
  allowedPrivateHosts?: string[];
  resolveDns?: boolean;
  lookup?: (hostname: string) => MaybePromise<Array<{ address: string }> | { address: string }>;
};

export class BlockedUpstreamUrlError extends Error {
  constructor(url: URL, reason: string) {
    super(`Blocked upstream URL "${url.href}": ${reason}`);
    this.name = "BlockedUpstreamUrlError";
  }
}

export async function assertAllowedUpstreamUrl(url: URL, options: UpstreamHttpNetworkOptions | undefined): Promise<void> {
  if (options?.allowPrivateNetworkUrls || isAllowedHost(url.hostname, options?.allowedPrivateHosts)) {
    return;
  }

  const normalizedHost = normalizeHostname(url.hostname);
  const literalKind = classifyIpAddress(normalizedHost);
  if (literalKind) {
    throw new BlockedUpstreamUrlError(url, `${literalKind} address ${normalizedHost}`);
  }

  if (isLocalHostname(normalizedHost)) {
    throw new BlockedUpstreamUrlError(url, `local hostname ${normalizedHost}`);
  }

  const records = await resolveHost(normalizedHost, options);
  for (const record of records) {
    const kind = classifyIpAddress(record.address);
    if (kind) {
      throw new BlockedUpstreamUrlError(url, `${kind} address ${record.address}`);
    }
  }
}

async function resolveHost(hostname: string, options: UpstreamHttpNetworkOptions | undefined): Promise<Array<{ address: string }>> {
  if (!options?.lookup && !options?.resolveDns) {
    return [];
  }

  try {
    const records = await (options?.lookup?.(hostname) ?? dnsLookup(hostname, { all: true }));
    return Array.isArray(records) ? records : [records];
  } catch {
    return [];
  }
}

function isAllowedHost(hostname: string, allowedHosts: string[] | undefined): boolean {
  if (!allowedHosts?.length) {
    return false;
  }

  const normalizedHost = normalizeHostname(hostname);
  return allowedHosts.some((allowed) => normalizeHostname(allowed) === normalizedHost);
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function classifyIpAddress(address: string): string | undefined {
  const family = isIP(address);
  if (family === 4) {
    return classifyIpv4(address);
  }
  if (family === 6) {
    return classifyIpv6(address);
  }
  return undefined;
}

function classifyIpv4(address: string): string | undefined {
  const octets = address.split(".").map((part) => Number(part));
  const [a, b] = octets;
  if (address === "169.254.169.254") {
    return "metadata";
  }
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "private";
  }
  if (a === 127) {
    return "loopback";
  }
  if (a === 169 && b === 254) {
    return "link-local";
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return "carrier-grade NAT";
  }
  if (a === 0) {
    return "unspecified";
  }
  return undefined;
}

function classifyIpv6(address: string): string | undefined {
  const normalized = address.toLowerCase();
  const mappedIpv4 = ipv4MappedAddress(normalized);
  if (mappedIpv4) {
    return classifyIpv4(mappedIpv4);
  }

  if (normalized === "::1") {
    return "loopback";
  }
  if (normalized === "::" || normalized.startsWith("::ffff:0:")) {
    return "unspecified";
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return "private";
  }
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return "link-local";
  }
  return undefined;
}

function ipv4MappedAddress(address: string): string | undefined {
  if (!address.startsWith("::ffff:")) {
    return undefined;
  }

  const suffix = address.slice("::ffff:".length);
  if (isIP(suffix) === 4) {
    return suffix;
  }

  const groups = suffix.split(":");
  if (groups.length !== 2) {
    return undefined;
  }

  if (!groups.every((group) => /^[0-9a-f]{1,4}$/u.test(group))) {
    return undefined;
  }

  const [high, low] = groups.map((group) => Number.parseInt(group, 16));
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) {
    return undefined;
  }

  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}
