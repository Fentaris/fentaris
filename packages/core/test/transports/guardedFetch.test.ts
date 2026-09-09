import { describe, expect, it, vi } from "vitest";
import { guardedUpstreamFetch } from "../../src/transports/client/guardedFetch.js";

function response(status: number, location?: string): Response {
  return new Response(status === 204 ? null : "body", {
    status,
    headers: location ? { location } : {},
  });
}

describe("guarded upstream fetch", () => {
  it("blocks a redirect that leaves a public host for a private address", async () => {
    const inner = vi.fn(async (input: unknown) =>
      String(input).startsWith("https://auth.example.com")
        ? response(302, "http://169.254.169.254/latest/meta-data/")
        : response(200),
    );
    const guarded = guardedUpstreamFetch({ resolveDns: false }, inner as never);

    await expect(guarded("https://auth.example.com/token", { method: "POST" })).rejects.toThrow(
      /Blocked upstream URL .*169\.254\.169\.254/,
    );
    expect(inner).toHaveBeenCalledTimes(1);
    expect(String(inner.mock.calls[0]?.[0])).toContain("auth.example.com");
  });

  it("follows an allowed redirect and drops credentials across origins", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; method?: string }> = [];
    const inner = vi.fn(async (input: unknown, init?: RequestInit) => {
      seen.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        method: init?.method,
      });
      return String(input).includes("first") ? response(302, "https://other.example.com/second") : response(200);
    });
    const guarded = guardedUpstreamFetch({ resolveDns: false }, inner as never);

    const result = await guarded("https://auth.example.com/first", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: "grant_type=authorization_code",
    });

    expect(result.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers.authorization).toBe("Bearer secret");
    expect(seen[1]?.url).toBe("https://other.example.com/second");
    expect(seen[1]?.headers.authorization).toBeUndefined();
    expect(seen[1]?.method).toBe("GET");
  });

  it("keeps credentials on a same-origin redirect", async () => {
    const seen: Array<Record<string, string>> = [];
    const inner = vi.fn(async (input: unknown, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return String(input).includes("first") ? response(307, "https://auth.example.com/second") : response(200);
    });
    const guarded = guardedUpstreamFetch({ resolveDns: false }, inner as never);

    await guarded("https://auth.example.com/first", { headers: { authorization: "Bearer secret" } });

    expect(seen[1]?.authorization).toBe("Bearer secret");
  });

  it("refuses an endless redirect chain", async () => {
    const inner = vi.fn(async () => response(302, "https://auth.example.com/loop"));
    const guarded = guardedUpstreamFetch({ resolveDns: false }, inner as never);

    await expect(guarded("https://auth.example.com/loop")).rejects.toThrow(/too many redirects/);
  });

  it("leaves manual redirect handling to the caller", async () => {
    const inner = vi.fn(async () => response(302, "http://127.0.0.1/private"));
    const guarded = guardedUpstreamFetch({ resolveDns: false }, inner as never);

    const result = await guarded("https://auth.example.com/authorize", { redirect: "manual" });

    expect(result.status).toBe(302);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
