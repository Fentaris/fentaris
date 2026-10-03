import { constants, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oauthIdentityStrategy } from "../../src/identity/oauthIdentityStrategy.js";
import { fentaris } from "../../src/proxy/McpProxy.js";
import { headerIdentityStrategy } from "../../src/identity/identity.js";
import { startAuthorizationServer } from "../fixtures/oauth/authorizationServer.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const resource = "https://proxy.example/mcp";
const issuer = "https://auth.example";
const claims = () => ({ iss: issuer, aud: resource, sub: "alice", exp: Date.now() / 1000 + 3600, scope: "mcp profile" });
const request = (token = "opaque") => ({ headers: { authorization: `Bearer ${token}` } });

describe("OAuth claims and identity", () => {
  it.each([
    { aud: "wrong" }, { iss: "wrong" }, { exp: Date.now() / 1000 - 120 },
    { nbf: Date.now() / 1000 + 120 }, { exp: undefined }, { exp: NaN }, { sub: "" },
  ])("fails closed for invalid claims %j", async (override) => {
    const strategy = oauthIdentityStrategy({ issuer, resource, verify: () => ({ ...claims(), ...override }) });
    expect(await strategy.resolve(request())).toBeNull();
  });
  it("checks audience arrays, scp, skew and async mapping", async () => {
    const strategy = oauthIdentityStrategy({ issuer, resource, scopes: ["mcp"], verify: () => ({ ...claims(), aud: ["other", resource], scope: undefined, scp: ["mcp"], nbf: Date.now() / 1000 + 30 }), mapUser: async () => ({ id: "mapped", metadata: { team: "test" } }) });
    expect(await strategy.resolve(request())).toEqual({ id: "mapped", metadata: { team: "test", scopes: ["mcp"] } });
  });
  it("isolates challenge reasons across concurrent requests", async () => {
    const strategy = oauthIdentityStrategy({ issuer, resource, scopes: ["mcp"], verify: async (token) => token === "no-scope" ? { ...claims(), scope: "profile" } : { ...claims(), aud: "wrong" } });
    const a = request("no-scope"), b = request("bad");
    await Promise.all([strategy.resolve(a), strategy.resolve(b)]);
    expect(strategy.challengeReason?.(a)).toBe("insufficient_scope");
    expect(strategy.challenge(strategy.challengeReason?.(a))).toContain('scope="mcp"');
    expect(strategy.challengeReason?.(b)).toBe("invalid_token");
    expect(strategy.challenge()).not.toContain("error=");
  });
  it("contains verifier and mapper failures", async () => {
    for (const options of [{ verify: () => { throw new Error("secret"); } }, { verify: claims, mapUser: () => { throw new Error("secret"); } }]) {
      expect(await oauthIdentityStrategy({ issuer, resource, ...options }).resolve(request())).toBeNull();
    }
  });
  it("verifies opaque tokens through fixture introspection", async () => {
    const as = await startAuthorizationServer(); cleanup.push(() => as.close());
    as.preregister({ client_id: "svc", client_secret: "test", redirect_uris: [], grant_types: ["client_credentials"] });
    const response = await fetch(`${as.url}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: "svc", client_secret: "test", resource }) });
    const { access_token } = await response.json() as { access_token: string };
    const strategy = oauthIdentityStrategy({ issuer: as.url, resource, verify: async (token) => {
      const r = await fetch(`${as.url}/introspect`, { method: "POST", body: new URLSearchParams({ token }) });
      const result = await r.json() as ReturnType<typeof claims> & { active: boolean };
      if (!result.active) throw new Error("inactive"); return result;
    } });
    expect(await strategy.resolve(request(access_token))).toMatchObject({ id: "service:svc" });
    expect(await strategy.resolve(request("unknown"))).toBeNull();
  });
  it("discovers fixture signing keys and checks RFC 8707 audience", async () => {
    const as = await startAuthorizationServer({ jwtAccessTokens: true }); cleanup.push(() => as.close());
    as.preregister({ client_id: "jwt-svc", redirect_uris: [], grant_types: ["client_credentials"] });
    const response = await fetch(`${as.url}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: "jwt-svc", resource }) });
    const { access_token } = await response.json() as { access_token: string };
    expect(await oauthIdentityStrategy({ issuer: as.url, resource }).resolve(request(access_token))).toMatchObject({ id: "service:jwt-svc" });
    expect(await oauthIdentityStrategy({ issuer: as.url, resource: "https://other.example/mcp" }).resolve(request(access_token))).toBeNull();
  });
  it("resolves ordered fallback and records the winning strategy", async () => {
    const app = fentaris({ identity: [oauthIdentityStrategy({ issuer, resource, verify: claims }), headerIdentityStrategy({ userIdHeader: "x-fentaris-api-key", name: "api-key" })] });
    const req = (headers: Record<string, string>) => ({ headers }) as Parameters<typeof app.resolveHttpUser>[0];
    expect(await app.resolveHttpUser(req({ "x-fentaris-api-key": "bob" }))).toMatchObject({ user: { id: "bob" }, identity: { strategy: "api-key", authenticated: true } });
    expect(await app.resolveHttpUser(req({ authorization: "Bearer valid", "x-fentaris-api-key": "bob" }))).toMatchObject({ user: { id: "alice" }, identity: { strategy: "oauth", metadata: { scopes: ["mcp", "profile"] } } });
  });
});

describe("JWT signature verification", () => {
  it.each(["RS256", "PS256", "ES256", "EdDSA"])("verifies %s and rejects signature and algorithm tampering", async (alg) => {
    const pair = alg === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : alg === "EdDSA" ? generateKeyPairSync("ed25519") : generateKeyPairSync("rsa", { modulusLength: 2048 });
    let kid = "first", fetches = 0, unavailable = false;
    const server = createServer((_req, res) => { fetches++; res.writeHead(unavailable ? 503 : 200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid, alg, use: "sig" }] })); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const strategy = oauthIdentityStrategy({ issuer, resource, jwks: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/jwks` } });
    const token = (algorithm = alg) => {
      const input = [Buffer.from(JSON.stringify({ alg: algorithm, kid })).toString("base64url"), Buffer.from(JSON.stringify(claims())).toString("base64url")].join(".");
      return `${input}.${sign(alg === "EdDSA" ? null : "sha256", Buffer.from(input), { key: pair.privateKey, ...(alg === "ES256" ? { dsaEncoding: "ieee-p1363" as const } : {}), ...(alg === "PS256" ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : {}) }).toString("base64url")}`;
    };
    expect(await strategy.resolve(request(token()))).toMatchObject({ id: "alice" });
    expect(fetches).toBe(1);
    kid = "rotated";
    expect(await strategy.resolve(request(token()))).toMatchObject({ id: "alice" });
    expect(fetches).toBe(2);
    expect(await strategy.resolve(request(token("HS256")))).toBeNull();
    expect(await strategy.resolve(request(`${token().split(".").slice(0, 2).join(".")}.AAAA`))).toBeNull();
    unavailable = true;
    expect(await strategy.resolve(request(token()))).toMatchObject({ id: "alice" });
    kid = "missing";
    expect(await strategy.resolve(request(token()))).toBeNull();
    expect(fetches).toBe(2);
  });
  it("bounds unknown-kid refreshes and outage retries for fresh, expired and empty caches", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const pair = generateKeyPairSync("ed25519");
    let fetches = 0, kid = "first", unavailable = false;
    const server = createServer((_req, res) => {
      fetches++;
      res.writeHead(unavailable ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid, alg: "EdDSA" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const strategy = oauthIdentityStrategy({ issuer, resource, jwks: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/jwks` } });
    const token = (kid: string) => {
      const input = [Buffer.from(JSON.stringify({ alg: "EdDSA", kid })).toString("base64url"), Buffer.from(JSON.stringify(claims())).toString("base64url")].join(".");
      return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString("base64url")}`;
    };
    expect(await strategy.resolve(request(token("first")))).toMatchObject({ id: "alice" });
    expect(fetches).toBe(1);
    expect(await Promise.all(["missing", "different", "another"].map((kid) => strategy.resolve(request(token(kid)))))).toEqual([null, null, null]);
    for (const kid of ["missing", "different", "random"]) expect(await strategy.resolve(request(token(kid)))).toBeNull();
    expect(fetches).toBe(2);
    expect(await strategy.resolve(request(token("first")))).toMatchObject({ id: "alice" });
    now += 30_000;
    unavailable = true;
    expect(await strategy.resolve(request(token("missing")))).toBeNull();
    expect(await strategy.resolve(request(token("different")))).toBeNull();
    expect(fetches).toBe(3);
    expect(await strategy.resolve(request(token("first")))).toMatchObject({ id: "alice" });
    now += 30_000;
    unavailable = false;
    kid = "rotated";
    expect(await strategy.resolve(request(token(kid)))).toMatchObject({ id: "alice" });
    expect(fetches).toBe(4);
    now += 300_000;
    kid = "expired-cache-rotation";
    expect(await strategy.resolve(request(token(kid)))).toMatchObject({ id: "alice" });
    expect(fetches).toBe(5);
    now += 300_000;
    unavailable = true;
    expect(await strategy.resolve(request(token(kid)))).toMatchObject({ id: "alice" });
    expect(fetches).toBe(6);
    for (let i = 0; i < 5; i++) expect(await strategy.resolve(request(token(kid)))).toMatchObject({ id: "alice" });
    expect(await strategy.resolve(request(token("missing")))).toBeNull();
    expect(fetches).toBe(6);
    const cold = oauthIdentityStrategy({ issuer, resource, jwks: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/jwks` } });
    for (let i = 0; i < 5; i++) expect(await cold.resolve(request(token(kid)))).toBeNull();
    expect(fetches).toBe(7);
    now += 30_000;
    unavailable = false;
    kid = "recovered";
    expect(await strategy.resolve(request(token(kid)))).toMatchObject({ id: "alice" });
    expect(await cold.resolve(request(token(kid)))).toMatchObject({ id: "alice" });
    expect(fetches).toBe(9);
  });
});
