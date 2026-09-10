import { describe, expect, it, vi } from "vitest";
import { OAuthManager } from "../../src/auth/oauth/manager.js";
import { MemoryOAuthTokenStore } from "../../src/auth/oauth/store.js";
import { oauth } from "../../src/auth/oauth/dsl.js";
import { deriveOAuthCallbackUrl } from "../../src/proxy/oauthRuntime.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

describe("OAuthManager custom providers", () => {
  it("completes the hosted callback with the caller's custom provider", async () => {
    const marker = new Error("custom-provider-was-used");
    const custom = {
      get redirectUrl() {
        return "http://127.0.0.1:4000/_fentaris/oauth/callback";
      },
      get clientMetadata() {
        return { client_name: "custom", redirect_uris: [] };
      },
      clientInformation: vi.fn(() => {
        throw marker;
      }),
      tokens: () => undefined,
      saveTokens: () => undefined,
      redirectToAuthorization: () => undefined,
      saveCodeVerifier: () => undefined,
      codeVerifier: () => "verifier",
    } as unknown as OAuthClientProvider;

    const factory = vi.fn(() => custom);
    const manager = new OAuthManager({ store: new MemoryOAuthTokenStore(), callbackUrl: "http://127.0.0.1:4000/_fentaris/oauth/callback" });
    manager.register("custom", { auth: oauth({ provider: factory }), serverUrl: "https://mcp.example.com/mcp" });

    expect(manager.providerFor("custom", { id: "alice" })).toBe(custom);

    const state = manager.pending.register("custom", "user:alice");
    // The exchange must run through the same custom provider, not a freshly built
    // Fentaris one, otherwise the escape hatch can never complete a login.
    await expect(manager.completeCallback({ state, code: "abc" })).rejects.toBe(marker);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reuses one custom provider instance per server and session", () => {
    const factory = vi.fn(() => ({ redirectUrl: undefined, clientMetadata: { client_name: "c", redirect_uris: [] } }) as unknown as OAuthClientProvider);
    const manager = new OAuthManager({ store: new MemoryOAuthTokenStore() });
    manager.register("custom", { auth: oauth({ provider: factory, tokens: "per-user" }), serverUrl: "https://mcp.example.com/mcp" });

    manager.providerFor("custom", { id: "alice" });
    manager.providerFor("custom", { id: "alice" });
    manager.providerFor("custom", { id: "bob" });

    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe("hosted callback URL derivation", () => {
  it("keeps the path prefix of a public URL", () => {
    expect(deriveOAuthCallbackUrl({ publicUrl: "https://gw.example.com/fentaris" }, { port: 4000 })).toBe(
      "https://gw.example.com/fentaris/_fentaris/oauth/callback",
    );
    expect(deriveOAuthCallbackUrl({ publicUrl: "https://gw.example.com/fentaris/" }, { port: 4000 })).toBe(
      "https://gw.example.com/fentaris/_fentaris/oauth/callback",
    );
    expect(deriveOAuthCallbackUrl({ publicUrl: "https://gw.example.com" }, { port: 4000 })).toBe(
      "https://gw.example.com/_fentaris/oauth/callback",
    );
  });

  it("derives a loopback URL from the listener when no public URL is configured", () => {
    expect(deriveOAuthCallbackUrl(undefined, { host: "0.0.0.0", port: 4100 })).toBe(
      "http://localhost:4100/_fentaris/oauth/callback",
    );
    expect(deriveOAuthCallbackUrl({ callbackPath: "/cb" }, { host: "127.0.0.1", port: 4100 })).toBe("http://127.0.0.1:4100/cb");
  });
});
