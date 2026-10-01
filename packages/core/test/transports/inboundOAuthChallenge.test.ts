import { afterEach, describe, expect, it } from "vitest";
import { fentaris } from "../../src/proxy/McpProxy.js";
import { oauthIdentityStrategy } from "../../src/identity/oauthIdentityStrategy.js";
import { SseProxyExposureTransport } from "../../src/transports/exposure/SseProxyExposureTransport.js";
import { validateFentarisConfig } from "../../src/config/validation.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const issuer = "https://auth.example";
async function start(kind: "http" | "sse", configured = true) {
  let resource = "";
  const app = fentaris({ port: 0, ...(configured ? { identity: oauthIdentityStrategy({ issuer, scopes: ["mcp"], verify: (token) => ({ iss: issuer, aud: resource, sub: token, exp: Date.now() / 1000 + 3600, scope: token === "no-scope" ? "profile" : "mcp" }) }) } : { identity: { strategy: { name: "none", resolve: () => null }, required: true } }) });
  const server = kind === "http" ? await app.start() : (await app.listen(new SseProxyExposureTransport({ port: 0 }))).server;
  closes.push(() => app.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  resource = `${base}/${kind === "http" ? "mcp" : "sse"}`;
  return { base, resource };
}

describe("inbound OAuth exposure", () => {
  it.each(["http", "sse"] as const)("serves public metadata and challenges on %s", async (kind) => {
    const { base, resource } = await start(kind);
    for (const path of ["/.well-known/oauth-protected-resource", `/.well-known/oauth-protected-resource/${kind === "http" ? "mcp" : "sse"}`]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ resource, authorization_servers: [issuer], scopes_supported: ["mcp"], bearer_methods_supported: ["header"] });
    }
    const missing = await fetch(resource);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/${kind === "http" ? "mcp" : "sse"}"`);
    for (const [header, error] of [["Bearer no-scope", "insufficient_scope"], ["Basic nope", "invalid_token"]]) {
      const response = await fetch(resource, { headers: { authorization: header! } });
      expect(response.status).toBe(401); expect(response.headers.get("www-authenticate")).toContain(`error="${error}"`);
    }
    for (const path of ["/.well-known/oauth-authorization-server", "/authorize", "/token", "/register"]) expect((await fetch(`${base}${path}`)).status).toBe(404);
  });
  it.each(["http", "sse"] as const)("keeps non-OAuth %s behavior unchanged", async (kind) => {
    const { base, resource } = await start(kind, false);
    expect((await fetch(`${base}/.well-known/oauth-protected-resource`)).status).toBe(404);
    const response = await fetch(resource); expect(response.status).toBe(401); expect(response.headers.get("www-authenticate")).toBeNull();
  });
  it("derives the public resource with custom path and start overrides", async () => {
    const app = fentaris({ identity: oauthIdentityStrategy({ issuer }), oauth: { publicUrl: "https://proxy.example/prefix" } });
    closes.push(() => app.close());
    const server = await app.start({ port: 0, path: "/custom" });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/custom`)).json();
    expect(metadata).toMatchObject({ resource: "https://proxy.example/prefix/custom" });
    const challenge = (await fetch(`${base}/custom`)).headers.get("www-authenticate")!;
    const publicPath = new URL(challenge.match(/resource_metadata="([^"]+)"/)![1]!).pathname;
    expect((await fetch(`${base}${publicPath}`)).status).toBe(200);
  });
  it("rejects non-loopback startup overrides before binding a listener", async () => {
    const app = fentaris({ identity: oauthIdentityStrategy({ issuer }) });
    await expect(app.start({ host: "0.0.0.0", port: 0 })).rejects.toThrow();
    closes.push(() => app.close());
  });
  it("rejects HTTP session rebinding with invalid_token", async () => {
    const { resource } = await start("http");
    const headers = { authorization: "Bearer alice", "content-type": "application/json", accept: "application/json, text/event-stream" };
    const initialized = await fetch(resource, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
    const session = initialized.headers.get("mcp-session-id"); expect(session).toBeTruthy(); await initialized.text();
    const response = await fetch(resource, { method: "POST", headers: { ...headers, authorization: "Bearer bob", "mcp-session-id": session! }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    expect(response.status).toBe(401); expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
  it("rejects SSE message rebinding and missing identity", async () => {
    const { base, resource } = await start("sse");
    const abort = new AbortController();
    const stream = await fetch(resource, { headers: { authorization: "Bearer alice" }, signal: abort.signal });
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const endpoint = first.match(/data: (.*)/)?.[1]?.trim(); expect(endpoint).toBeTruthy();
    for (const authorization of ["Bearer bob", ""]) {
      const response = await fetch(`${base}${endpoint}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(401); expect(response.headers.get("www-authenticate")).toContain("Bearer resource_metadata=");
    }
    abort.abort(); await reader.cancel().catch(() => undefined);
  });
});

describe("OAuth configuration diagnostics", () => {
  const codes = (options: Parameters<typeof oauthIdentityStrategy>[0], config = {}) => validateFentarisConfig({ ...config, identity: oauthIdentityStrategy(options) }).errors.map((item) => item.code);
  it.each(["not-a-url", "https://auth.example?bad=1", "https://auth.example/#bad", "http://auth.example"])("rejects issuer %s", (issuer) => {
    expect(codes({ issuer })).toContain("FENTARIS_CONFIG_OAUTH_RESOURCE_ISSUER_INVALID");
  });
  it("validates derivation, verification conflicts, scopes and HTTPS", () => {
    expect(codes({ issuer }, { host: "0.0.0.0" })).toContain("FENTARIS_CONFIG_OAUTH_RESOURCE_MISSING");
    expect(codes({ issuer, resource: "http://proxy.example/mcp" })).toContain("FENTARIS_CONFIG_OAUTH_RESOURCE_HTTPS_REQUIRED");
    expect(codes({ issuer, jwks: { url: "https://auth.example/jwks" }, verify: () => ({}) })).toContain("FENTARIS_CONFIG_OAUTH_RESOURCE_VERIFY_CONFLICT");
    expect(codes({ issuer, scopes: ["bad scope"] })).toContain("FENTARIS_CONFIG_OAUTH_RESOURCE_SCOPES_INVALID");
    expect(codes({ issuer }, { host: "0.0.0.0", oauth: { publicUrl: "https://proxy.example" } })).toEqual([]);
  });
});
