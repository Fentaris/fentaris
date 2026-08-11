import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EdgeLocalAuthorityStore,
  IntegratedEdgeAuthServices,
  edgeError,
  normalizeEdgeControlPlaneConfig,
} from "../../src/index.js";

const openStores: EdgeLocalAuthorityStore[] = [];

afterEach(async () => {
  while (openStores.length > 0) {
    await openStores.pop()?.close();
  }
});

async function createServices() {
  const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-auth-"));
  const store = new EdgeLocalAuthorityStore({ directory, protectionKey: "test-protection-key" });
  openStores.push(store);
  await store.open();
  const config = normalizeEdgeControlPlaneConfig({
    enabled: true,
    mode: "local",
    publicOrigin: "http://127.0.0.1:4000",
    rateLimitPerMinute: 30,
  });
  if (!config) throw new Error("expected normalized config");
  const auth = new IntegratedEdgeAuthServices({
    store,
    config,
    publicOrigin: "http://127.0.0.1:4000",
    defaultTenantId: "tenant-a",
  });
  return { auth, store };
}

describe("integrated Edge auth services", () => {
  it("authorizes, enrolls, refreshes, and revokes a device", async () => {
    const { auth, store } = await createServices();
    const began = await auth.begin({ clientId: "fentaris-edge" });
    expect(began.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(await auth.poll({ clientId: "fentaris-edge", deviceCode: began.deviceCode })).toEqual({
      status: "pending",
      interval: 5,
    });

    await auth.approve(began.userCode, {
      tenantId: "tenant-a",
      subjectId: "alice",
      actorId: "operator",
      approvedAt: Date.now(),
    });
    const authorized = await auth.poll({ clientId: "fentaris-edge", deviceCode: began.deviceCode });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") throw new Error("expected tokens");

    const replay = await auth.poll({ clientId: "fentaris-edge", deviceCode: began.deviceCode });
    expect(replay.status).toBe("expired");

    const keys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const nonce = randomBytes(16).toString("base64url");
    const proof = sign(null, Buffer.from(`${began.deviceCode}.${nonce}`), keys.privateKey).toString("base64url");
    const enrolled = await auth.enroll({
      accessToken: authorized.tokens.accessToken,
      publicKey: keys.publicKey,
      deviceCode: began.deviceCode,
      nonce,
      proof,
      name: "Laptop",
    });
    expect(enrolled.gatewayUrl).toBe("ws://127.0.0.1:4000/_fentaris/edge/ws");
    expect(enrolled.deviceCredential.length).toBeGreaterThan(20);
    expect((await store.getEnrolledDevice("tenant-a", enrolled.edgeNodeId))?.user).toMatchObject({
      name: "Laptop",
      tags: [],
    });

    const refreshed = await auth.refresh({
      clientId: "fentaris-edge",
      refreshToken: authorized.tokens.refreshToken,
    });
    expect(refreshed.accessToken).not.toBe(authorized.tokens.accessToken);
    await expect(auth.refresh({
      clientId: "fentaris-edge",
      refreshToken: authorized.tokens.refreshToken,
    })).rejects.toThrow(/invalid or expired/i);

    const helloNonce = randomBytes(16).toString("base64url");
    const helloProof = sign(
      null,
      Buffer.from(`${enrolled.edgeNodeId}.${helloNonce}.edge.hello`),
      keys.privateKey,
    ).toString("base64url");
    const hello = await auth.authenticateHello({
      edgeNodeId: enrolled.edgeNodeId,
      tenantId: enrolled.tenantId,
      nonce: helloNonce,
      proof: helloProof,
      deviceCredential: enrolled.deviceCredential,
      protocolVersions: [2, 1],
    });
    expect(hello).toMatchObject({ status: "accepted", protocolVersion: 2 });

    await auth.revoke({ edgeNodeId: enrolled.edgeNodeId }, refreshed.accessToken);
    const rejected = await auth.authenticateHello({
      edgeNodeId: enrolled.edgeNodeId,
      tenantId: enrolled.tenantId,
      nonce: randomBytes(16).toString("base64url"),
      proof: helloProof,
      deviceCredential: enrolled.deviceCredential,
      protocolVersions: [2],
    });
    expect(rejected.status).toBe("rejected");
  });

  it("rejects proof replay and oversized authorization requests", async () => {
    const { auth } = await createServices();
    const began = await auth.begin({ clientId: "fentaris-edge" });
    await auth.approve(began.userCode, {
      tenantId: "tenant-a",
      subjectId: "alice",
      actorId: "operator",
      approvedAt: Date.now(),
    });
    const authorized = await auth.poll({ clientId: "fentaris-edge", deviceCode: began.deviceCode });
    if (authorized.status !== "authorized") throw new Error("expected tokens");

    const keys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const nonce = randomBytes(16).toString("base64url");
    const proof = sign(null, Buffer.from(`${began.deviceCode}.${nonce}`), keys.privateKey).toString("base64url");
    await auth.enroll({
      accessToken: authorized.tokens.accessToken,
      publicKey: keys.publicKey,
      deviceCode: began.deviceCode,
      nonce,
      proof,
    });
    await expect(auth.enroll({
      accessToken: authorized.tokens.accessToken,
      publicKey: keys.publicKey,
      deviceCode: began.deviceCode,
      nonce,
      proof,
    })).rejects.toThrow(/Replay detected|invalid/i);

    await expect(auth.begin({
      clientId: "fentaris-edge",
      metadata: { blob: "x".repeat(20_000) },
    })).rejects.toThrow(/size limit/i);
  });

  it("does not burn enroll nonces before proof verification succeeds", async () => {
    const { auth } = await createServices();
    const began = await auth.begin({ clientId: "fentaris-edge" });
    await auth.approve(began.userCode, {
      tenantId: "tenant-a",
      subjectId: "alice",
      actorId: "operator",
      approvedAt: Date.now(),
    });
    const authorized = await auth.poll({ clientId: "fentaris-edge", deviceCode: began.deviceCode });
    if (authorized.status !== "authorized") throw new Error("expected tokens");
    const keys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const nonce = randomBytes(16).toString("base64url");
    await expect(auth.enroll({
      accessToken: authorized.tokens.accessToken,
      publicKey: keys.publicKey,
      deviceCode: began.deviceCode,
      nonce,
      proof: "not-a-valid-proof",
    })).rejects.toThrow(/proof is invalid/i);

    const proof = sign(null, Buffer.from(`${began.deviceCode}.${nonce}`), keys.privateKey).toString("base64url");
    await expect(auth.enroll({
      accessToken: authorized.tokens.accessToken,
      publicKey: keys.publicKey,
      deviceCode: began.deviceCode,
      nonce,
      proof,
    })).resolves.toMatchObject({ tenantId: "tenant-a" });
  });

  it("rejects enrollment-token revoke against a sibling enrolled device", async () => {
    const { auth } = await createServices();
    const first = await auth.begin({ clientId: "fentaris-edge" });
    await auth.approve(first.userCode, {
      tenantId: "tenant-a",
      subjectId: "alice",
      actorId: "operator",
      approvedAt: Date.now(),
    });
    const firstTokens = await auth.poll({ clientId: "fentaris-edge", deviceCode: first.deviceCode });
    if (firstTokens.status !== "authorized") throw new Error("expected tokens");
    const keys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const nonce = randomBytes(16).toString("base64url");
    const proof = sign(null, Buffer.from(`${first.deviceCode}.${nonce}`), keys.privateKey).toString("base64url");
    const enrolled = await auth.enroll({
      accessToken: firstTokens.tokens.accessToken,
      publicKey: keys.publicKey,
      deviceCode: first.deviceCode,
      nonce,
      proof,
    });

    const second = await auth.begin({ clientId: "fentaris-edge" });
    await auth.approve(second.userCode, {
      tenantId: "tenant-a",
      subjectId: "alice",
      actorId: "operator",
      approvedAt: Date.now(),
    });
    const secondTokens = await auth.poll({ clientId: "fentaris-edge", deviceCode: second.deviceCode });
    if (secondTokens.status !== "authorized") throw new Error("expected tokens");

    await expect(auth.revoke(
      { edgeNodeId: enrolled.edgeNodeId },
      secondTokens.tokens.accessToken,
    )).rejects.toThrow(/rejected/i);

    const refreshed = await auth.refresh({
      clientId: "fentaris-edge",
      refreshToken: firstTokens.tokens.refreshToken,
    });
    await auth.revoke({ edgeNodeId: enrolled.edgeNodeId }, refreshed.accessToken);
  });

  it("consumes approved sessions once under concurrent polls", async () => {
    const { auth } = await createServices();
    const began = await auth.begin({ clientId: "fentaris-edge" });
    await auth.approve(began.userCode, {
      tenantId: "tenant-a",
      subjectId: "alice",
      actorId: "operator",
      approvedAt: Date.now(),
    });
    const results = await Promise.all([
      auth.poll({ clientId: "fentaris-edge", deviceCode: began.deviceCode }),
      auth.poll({ clientId: "fentaris-edge", deviceCode: began.deviceCode }),
      auth.poll({ clientId: "fentaris-edge", deviceCode: began.deviceCode }),
    ]);
    expect(results.filter((result) => result.status === "authorized")).toHaveLength(1);
    expect(results.filter((result) => result.status === "expired")).toHaveLength(2);
  });

  it("rejects replayed hello nonces after process-visible persistence", async () => {
    const { auth, store } = await createServices();
    const began = await auth.begin({ clientId: "fentaris-edge" });
    await auth.approve(began.userCode, {
      tenantId: "tenant-a",
      subjectId: "alice",
      actorId: "operator",
      approvedAt: Date.now(),
    });
    const authorized = await auth.poll({ clientId: "fentaris-edge", deviceCode: began.deviceCode });
    if (authorized.status !== "authorized") throw new Error("expected tokens");
    const keys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const nonce = randomBytes(16).toString("base64url");
    const proof = sign(null, Buffer.from(`${began.deviceCode}.${nonce}`), keys.privateKey).toString("base64url");
    const enrolled = await auth.enroll({
      accessToken: authorized.tokens.accessToken,
      publicKey: keys.publicKey,
      deviceCode: began.deviceCode,
      nonce,
      proof,
    });
    const helloNonce = randomBytes(16).toString("base64url");
    const helloProof = sign(
      null,
      Buffer.from(`${enrolled.edgeNodeId}.${helloNonce}.edge.hello`),
      keys.privateKey,
    ).toString("base64url");
    await expect(auth.authenticateHello({
      edgeNodeId: enrolled.edgeNodeId,
      tenantId: enrolled.tenantId,
      nonce: helloNonce,
      proof: helloProof,
      deviceCredential: enrolled.deviceCredential,
      protocolVersions: [3],
    })).resolves.toMatchObject({ status: "accepted" });
    expect(store.snapshot().usedHelloNonces.length).toBeGreaterThan(0);
    await expect(auth.authenticateHello({
      edgeNodeId: enrolled.edgeNodeId,
      tenantId: enrolled.tenantId,
      nonce: helloNonce,
      proof: helloProof,
      deviceCredential: enrolled.deviceCredential,
      protocolVersions: [3],
    })).resolves.toMatchObject({ status: "rejected" });
  });

  it("rolls back durable enrollment when onEnrolled fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-auth-rollback-"));
    const store = new EdgeLocalAuthorityStore({ directory, protectionKey: "test-protection-key" });
    openStores.push(store);
    await store.open();
    const config = normalizeEdgeControlPlaneConfig({
      enabled: true,
      mode: "local",
      publicOrigin: "http://127.0.0.1:4000",
      rateLimitPerMinute: 30,
    });
    if (!config) throw new Error("expected normalized config");
    const auth = new IntegratedEdgeAuthServices({
      store,
      config,
      publicOrigin: "http://127.0.0.1:4000",
      defaultTenantId: "tenant-a",
      onEnrolled: async () => {
        throw edgeError("EDGE_NAME_CONFLICT", "Edge device name is already in use for this tenant.");
      },
    });

    const began = await auth.begin({ clientId: "fentaris-edge" });
    await auth.approve(began.userCode, {
      tenantId: "tenant-a",
      subjectId: "alice",
      actorId: "operator",
      approvedAt: Date.now(),
    });
    const authorized = await auth.poll({ clientId: "fentaris-edge", deviceCode: began.deviceCode });
    if (authorized.status !== "authorized") throw new Error("expected tokens");
    const keys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const nonce = randomBytes(16).toString("base64url");
    const proof = sign(null, Buffer.from(`${began.deviceCode}.${nonce}`), keys.privateKey).toString("base64url");

    await expect(auth.enroll({
      accessToken: authorized.tokens.accessToken,
      publicKey: keys.publicKey,
      deviceCode: began.deviceCode,
      nonce,
      proof,
      name: "Laptop",
    })).rejects.toMatchObject({ code: "EDGE_NAME_CONFLICT" });
    expect(store.snapshot().enrolledDevices).toEqual([]);
  });
});
