import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EdgeLocalAuthorityStore,
  EdgeLocalOperatorClient,
  EdgeLocalOperatorServer,
  compareSecretHash,
  createEdgeLocalOperatorEndpoint,
  edgeError,
  hashSecret,
  normalizeUserCode,
  redactEdgeAuthorityValue,
  type EdgeApprovalService,
  type EdgeAuthorizationSession,
  type EdgeControlPlaneService,
} from "../../src/index.js";

const openStores: EdgeLocalAuthorityStore[] = [];
const openServers: EdgeLocalOperatorServer[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()?.close();
  }
  while (openStores.length > 0) {
    await openStores.pop()?.close();
  }
});

describe("local Edge authority store", () => {
  it("recovers a lock left by a terminated process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-authority-stale-"));
    await writeFile(path.join(directory, "authority.lock"), "99999999\n", { mode: 0o600 });
    const store = new EdgeLocalAuthorityStore({ directory, protectionKey: "test-protection-key", lockTimeoutMs: 100 });
    openStores.push(store);

    await expect(store.open()).resolves.toMatchObject({ schemaVersion: 1 });
    expect(await readFile(store.lockPath, "utf8")).toBe(`${process.pid}\n`);
  });

  it("persists server identity across reopen with owner-only files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-authority-"));
    const first = new EdgeLocalAuthorityStore({ directory, protectionKey: "test-protection-key" });
    openStores.push(first);
    const created = await first.open();
    const signingKey = first.decryptSigningKey();
    await first.close();
    openStores.pop();

    const second = new EdgeLocalAuthorityStore({ directory, protectionKey: "test-protection-key" });
    openStores.push(second);
    const reloaded = await second.open();
    expect(reloaded.server.serverId).toBe(created.server.serverId);
    expect(second.decryptSigningKey().equals(signingKey)).toBe(true);

    if (process.platform !== "win32") {
      const stateMode = (await stat(second.statePath)).mode & 0o777;
      expect(stateMode).toBe(0o600);
      const dirMode = (await stat(directory)).mode & 0o777;
      expect(dirMode).toBe(0o700);
    }
  });

  it("rejects a second concurrent writer while the lock is held", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-authority-"));
    const first = new EdgeLocalAuthorityStore({ directory, protectionKey: "test-protection-key", lockTimeoutMs: 100 });
    openStores.push(first);
    await first.open();

    const second = new EdgeLocalAuthorityStore({ directory, protectionKey: "test-protection-key", lockTimeoutMs: 100 });
    await expect(second.open()).rejects.toThrow(/locked by another process/i);
  });

  it("hashes credentials at rest, rotates refresh tokens, and revokes durably", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-authority-"));
    const store = new EdgeLocalAuthorityStore({ directory, protectionKey: "test-protection-key" });
    openStores.push(store);
    await store.open();

    const session: EdgeAuthorizationSession = {
      tenantId: "tenant-a",
      clientId: "fentaris-edge",
      deviceCodeHash: hashSecret("device-code"),
      userCodeHash: hashSecret(normalizeUserCode("ABCD-EFGH")),
      createdAt: 1,
      expiresAt: 1_000_000,
      intervalSeconds: 5,
      pollAttempts: 0,
      status: "pending",
    };
    await store.putAuthorizationSession(session);
    await store.putRefreshCredential({
      tenantId: "tenant-a",
      edgeNodeId: "node-1",
      subjectId: "alice",
      refreshTokenHash: hashSecret("refresh-1"),
      expiresAt: Date.now() + 60_000,
      rotatedAt: 10,
    });
    await store.putEnrolledDevice({
      tenantId: "tenant-a",
      edgeNodeId: "node-1",
      subjectId: "alice",
      publicKey: "-----BEGIN PUBLIC KEY-----\nMAkw\n-----END PUBLIC KEY-----",
      credentialId: "cred-1",
      credentialHash: hashSecret("device-credential"),
      enrolledAt: 20,
      revoked: false,
      connectionGeneration: 1,
    });

    const raw = await readFile(store.statePath, "utf8");
    expect(raw).not.toContain("refresh-1");
    expect(raw).not.toContain("device-credential");
    expect(raw).toContain(hashSecret("refresh-1"));
    expect(compareSecretHash(hashSecret("refresh-1"), "refresh-1")).toBe(true);

    const consumed = await store.consumeRefreshCredential("refresh-1");
    expect(consumed?.edgeNodeId).toBe("node-1");
    expect(await store.consumeRefreshCredential("refresh-1")).toBeUndefined();

    const revoked = await store.revokeDevice("tenant-a", "node-1", 50);
    expect(revoked?.revoked).toBe(true);
    expect(store.snapshot().refreshCredentials).toHaveLength(0);
    expect(store.snapshot().desiredAssignments).toHaveLength(0);
  });

  it("fails closed on corrupted authority JSON", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-authority-"));
    await writeFile(path.join(directory, "authority.json"), "{not-json", { mode: 0o600 });
    const store = new EdgeLocalAuthorityStore({ directory, protectionKey: "test-protection-key" });
    await expect(store.open()).rejects.toThrow(/corrupted/i);
  });

  it("redacts secrets from authority values", () => {
    expect(redactEdgeAuthorityValue({
      refreshToken: "super-secret-refresh-token-value",
      edgeNodeId: "node-1",
    })).toEqual({
      refreshToken: "[redacted]",
      edgeNodeId: "node-1",
    });
  });
});

describe("local Edge operator channel", () => {
  it("approves through the protected channel without exposing public routes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-operator-"));
    const endpoint = createEdgeLocalOperatorEndpoint(directory);
    const approvals: string[] = [];
    const approval: EdgeApprovalService = {
      async approve(userCode, decision) {
        approvals.push(userCode);
        return {
          tenantId: decision.tenantId,
          clientId: "fentaris-edge",
          deviceCodeHash: hashSecret("device"),
          userCodeHash: hashSecret(normalizeUserCode(userCode)),
          createdAt: 1,
          expiresAt: 100,
          intervalSeconds: 5,
          pollAttempts: 0,
          status: "approved",
          subjectId: decision.subjectId,
          actorId: decision.actorId,
          approvedAt: decision.approvedAt,
        };
      },
      async deny(userCode, decision) {
        return {
          tenantId: decision.tenantId,
          clientId: "fentaris-edge",
          deviceCodeHash: hashSecret("device"),
          userCodeHash: hashSecret(normalizeUserCode(userCode)),
          createdAt: 1,
          expiresAt: 100,
          intervalSeconds: 5,
          pollAttempts: 0,
          status: "denied",
          actorId: decision.actorId,
        };
      },
    };

    const server = new EdgeLocalOperatorServer({
      endpoint,
      approval,
      status: async () => ({
        mode: "local",
        multiInstance: false,
        pendingApprovals: 1,
        enrolledDevices: 0,
      }),
    });
    openServers.push(server);
    await server.start();

    const client = new EdgeLocalOperatorClient(endpoint);
    const approved = await client.request({
      command: "approve",
      userCode: "ABCD-EFGH",
      decision: {
        tenantId: "tenant-a",
        subjectId: "alice",
        actorId: "operator",
        approvedAt: 42,
      },
    });
    expect(approved.ok).toBe(true);
    expect(approvals).toEqual(["ABCD-EFGH"]);

    const denied = await client.request({
      command: "status",
      credential: "wrong-credential",
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("unauthorized");
  });

  it("preserves Edge error codes from local device management", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-operator-mgmt-"));
    const endpoint = createEdgeLocalOperatorEndpoint(directory);
    const approval: EdgeApprovalService = {
      async approve() {
        throw new Error("unused");
      },
      async deny() {
        throw new Error("unused");
      },
    };
    const management = {
      async list() {
        throw new Error("unused");
      },
      async get() {
        throw new Error("unused");
      },
      async join() {
        throw new Error("unused");
      },
      async update() {
        throw edgeError("EDGE_INVENTORY_CONFLICT", "Edge inventory version is stale.");
      },
      async disconnect() {
        throw new Error("unused");
      },
      async revoke() {
        throw edgeError("EDGE_UNAUTHORIZED_TARGET", "Edge device is unavailable or unauthorized.");
      },
    } as unknown as EdgeControlPlaneService;
    const server = new EdgeLocalOperatorServer({
      endpoint,
      approval,
      management,
      status: async () => ({
        mode: "local",
        multiInstance: false,
        pendingApprovals: 0,
        enrolledDevices: 0,
      }),
    });
    openServers.push(server);
    await server.start();
    const client = new EdgeLocalOperatorClient(endpoint);

    const conflict = await client.request({
      command: "device-update",
      context: { tenantId: "default" },
      deviceName: "Laptop",
      update: { expectedInventoryVersion: 1, updatedAt: Date.now() },
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "EDGE_INVENTORY_CONFLICT", message: "Edge inventory version is stale." },
    });

    const unauthorized = await client.request({
      command: "device-revoke",
      context: { tenantId: "default" },
      deviceName: "Laptop",
    });
    expect(unauthorized).toMatchObject({
      ok: false,
      error: { code: "EDGE_UNAUTHORIZED_TARGET" },
    });
  });
});
