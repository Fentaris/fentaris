import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  lookup: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  lookup: fakes.lookup,
}));

import { assertAllowedUpstreamUrl } from "../../src/transports/client/upstreamUrlGuardrails.js";

describe("upstream URL guardrails", () => {
  beforeEach(() => {
    fakes.lookup.mockReset();
  });

  it("resolves upstream hostnames by default before allowing requests", async () => {
    fakes.lookup.mockResolvedValue([{ address: "10.0.0.8" }]);

    await expect(assertAllowedUpstreamUrl(new URL("https://mcp.example/mcp"), undefined)).rejects.toThrow(
      /private address 10\.0\.0\.8/,
    );
    expect(fakes.lookup).toHaveBeenCalledWith("mcp.example", { all: true });
  });

  it("allows DNS resolution to be disabled explicitly", async () => {
    await expect(
      assertAllowedUpstreamUrl(new URL("https://mcp.example/mcp"), { resolveDns: false }),
    ).resolves.toBeUndefined();
    expect(fakes.lookup).not.toHaveBeenCalled();
  });

  it("blocks IPv4-mapped IPv6 private and metadata literals", async () => {
    await expect(assertAllowedUpstreamUrl(new URL("http://[::ffff:127.0.0.1]/"), undefined)).rejects.toThrow(
      /loopback address/,
    );
    await expect(assertAllowedUpstreamUrl(new URL("http://[::ffff:a9fe:a9fe]/"), undefined)).rejects.toThrow(
      /metadata address/,
    );
    await expect(assertAllowedUpstreamUrl(new URL("http://[::ffff:a00:8]/"), undefined)).rejects.toThrow(
      /private address/,
    );
    expect(fakes.lookup).not.toHaveBeenCalled();
  });
});
