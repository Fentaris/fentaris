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
  if (options?.resolveDns === false) {
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
  const mappedIpv4 = mappedIpv4FromIpv6(normalized);
  if (mappedIpv4) {
    return classifyIpv4(mappedIpv4);
  }

  if (normalized === "::1") {
    return "loopback";
  }
  if (normalized === "::") {
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

function mappedIpv4FromIpv6(address: string): string | undefined {
  const groups = parseIpv6Groups(address);
  if (!groups) {
    return undefined;
  }

  if (groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) {
    return undefined;
  }

  const high = groups[6];
  const low = groups[7];
  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join(".");
}

function parseIpv6Groups(address: string): number[] | undefined {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(lastColon + 1);
    if (lastColon === -1 || isIP(ipv4) !== 4) {
      return undefined;
    }

    const octets = ipv4.split(".").map((part) => Number(part));
    normalized = `${normalized.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const parts = normalized.split("::");
  if (parts.length > 2) {
    return undefined;
  }

  const head = splitIpv6Part(parts[0]);
  const tail = parts.length === 2 ? splitIpv6Part(parts[1]) : [];
  if (!head || !tail) {
    return undefined;
  }

  const missing = 8 - head.length - tail.length;
  if ((parts.length === 2 && missing < 1) || (parts.length === 1 && missing !== 0)) {
    return undefined;
  }

  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

function splitIpv6Part(part: string): number[] | undefined {
  if (!part) {
    return [];
  }

  const groups = part.split(":").map((group) => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return Number.NaN;
    }
    return Number.parseInt(group, 16);
  });
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}
