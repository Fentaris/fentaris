import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EDGE_PROTOCOL_VERSION,
  compileLaunchRecipe,
  createSetupSchema,
} from "@fentaris/core";
import {
  defaultEdgePaths,
  EdgeAgent,
  EdgeEnrollmentService,
  HttpDeviceAuthorizationProvider,
  ProtectedJsonStore,
  WebSocketEdgeConnectionClient,
  runEdgeCli,
  type CredentialStore,
  type DeviceAuthorizationProvider,
  type EdgeConnectionClient,
  type EdgeEnrollmentClient,
  type EdgeLocalConfig,
  type EdgePlatform,
  type JsonStore,
  type StoredDeviceKeyPair,
} from "../src/index.js";
import path from "node:path";

class FakeWebSocket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  throwOnClose = false;
  readonly sent: string[] = [];
  send(frame: string) { this.sent.push(frame); }
  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  receive(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  close(code = 1000, reason = "") {
    if (this.throwOnClose) throw new Error("close failed");
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    const event = new Event("close");
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
  }
}

class MemoryStore<T> implements JsonStore<T> {
  value?: T;
  async load() { return this.value; }
  async save(value: T) { this.value = structuredClone(value); }
  async delete() { this.value = undefined; }
}

class MemoryCredentials implements CredentialStore {
  readonly values = new Map<string, string>();
  async get(name: string) { return this.values.get(name); }
  async set(name: string, value: string) { this.values.set(name, value); }
  async delete(name: string) { this.values.delete(name); }
}

function platform(overrides: {
  config?: JsonStore<EdgeLocalConfig>;
  keys?: JsonStore<StoredDeviceKeyPair>;
  credentials?: CredentialStore;
} = {}): EdgePlatform {
  return {
    paths: {
      dataDir: "/private/user/path",
      configFile: "/private/user/path/config.json",
      deviceKeyFile: "/private/user/path/key.json",
      credentialFile: "/private/user/path/credentials.json",
    },
    configStore: overrides.config ?? new MemoryStore(),
    deviceKeyStore: overrides.keys ?? new MemoryStore(),
    credentialStore: overrides.credentials ?? new MemoryCredentials(),
    processSupervisor: { start: vi.fn() },
  };
}

function authorization(now: number): DeviceAuthorizationProvider {
  return {
    begin: vi.fn(async () => ({
      deviceCode: "device-code",
      userCode: "USER-CODE",
      verificationUri: "https://auth.example/activate",
      expiresIn: 600,
      interval: 1,
    })),
    poll: vi.fn(async () => ({
      status: "authorized" as const,
      tokens: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: now + 3_600_000,
      },
    })),
    refresh: vi.fn(async () => ({
      accessToken: "refreshed-token",
      refreshToken: "refreshed-refresh",
      expiresAt: now + 7_200_000,
    })),
  };
}

function enrollment(): EdgeEnrollmentClient {
  return {
    enroll: vi.fn(async (request) => {
      expect(verify(
        null,
        Buffer.from(`${request.deviceCode}.${request.nonce}`),
        request.publicKey,
        Buffer.from(request.proof, "base64url"),
      )).toBe(true);
      return {
        edgeNodeId: "node-random",
        tenantId: "tenant-1",
        gatewayUrl: "wss://edge.example/connect",
        deviceCredential: "device-credential",
      };
    }),
    revoke: vi.fn(async () => undefined),
  };
}

function service(input: {
  platform?: EdgePlatform;
  authorization?: DeviceAuthorizationProvider;
  enrollment?: EdgeEnrollmentClient;
  now?: number;
  hostname?: string;
  controlPlaneUrl?: string;
} = {}) {
  const now = input.now ?? 1_000;
  const edgePlatform = input.platform ?? platform();
  const auth = input.authorization ?? authorization(now);
  const client = input.enrollment ?? enrollment();
  const verification = vi.fn();
  return {
    platform: edgePlatform,
    auth,
    client,
    verification,
    service: new EdgeEnrollmentService({
      platform: edgePlatform,
      authorization: auth,
      enrollment: client,
      callbacks: { onVerification: verification },
      ...(input.controlPlaneUrl ? { controlPlaneUrl: input.controlPlaneUrl } : {}),
      now: () => now,
      sleep: async () => undefined,
      hostnameLabel: () => input.hostname ?? "laptop",
    }),
  };
}

describe("edge enrollment", () => {
  it("creates a random key, proves possession, enrolls, and reuses identity on repeat login", async () => {
    const fixture = service({ controlPlaneUrl: "https://control.example" });
    const first = await fixture.service.login();
    expect(first.repeated).toBe(false);
    expect(first.config.edgeNodeId).toBe("node-random");
    expect(first.config.controlPlaneUrl).toBe("https://control.example");
    expect(await fixture.platform.deviceKeyStore.load()).toMatchObject({
      publicKey: expect.stringContaining("BEGIN PUBLIC KEY"),
      privateKey: expect.stringContaining("BEGIN PRIVATE KEY"),
    });
    expect(fixture.verification).toHaveBeenCalledOnce();
    expect(fixture.client.enroll).toHaveBeenCalledOnce();

    const second = await fixture.service.login();
    expect(second.repeated).toBe(true);
    expect(second.config.edgeNodeId).toBe("node-random");
    expect(fixture.client.enroll).toHaveBeenCalledOnce();
  });

  it("adds the control-plane URL to an existing enrollment", async () => {
    const sharedPlatform = platform();
    await service({ platform: sharedPlatform }).service.login();
    const repeated = await service({ platform: sharedPlatform, controlPlaneUrl: "https://control.example" }).service.login();
    expect(repeated.repeated).toBe(true);
    expect(repeated.config.controlPlaneUrl).toBe("https://control.example");
    expect((await sharedPlatform.configStore.load())?.controlPlaneUrl).toBe("https://control.example");
  });

  it("refreshes expired authorization and rejects copied non-secret config without protected identity", async () => {
    const original = service({ now: 1_000 });
    await original.service.login();
    const credentials = original.platform.credentialStore as MemoryCredentials;
    credentials.values.set("access-expires-at", "1");
    await expect(original.service.validAccessToken()).resolves.toBe("refreshed-token");
    expect(original.auth.refresh).toHaveBeenCalledOnce();

    const copiedConfig = await original.platform.configStore.load();
    const copiedPlatform = platform({
      config: Object.assign(new MemoryStore<EdgeLocalConfig>(), { value: copiedConfig }),
    });
    const copied = service({ platform: copiedPlatform });
    await expect(copied.service.connectionCredentials()).rejects.toThrow(/not enrolled/);
  });

  it("retains random identity across hostname changes and clears credentials on revoke", async () => {
    const sharedPlatform = platform();
    const first = service({ platform: sharedPlatform, hostname: "old-name" });
    await first.service.login();
    const second = service({ platform: sharedPlatform, hostname: "new-name" });
    const repeated = await second.service.login();
    expect(repeated.config.edgeNodeId).toBe("node-random");
    expect(repeated.config.hostnameLabel).toBe("old-name");

    await second.service.revokeRemote();
    await second.service.clearLocalIdentity();
    expect(await sharedPlatform.configStore.load()).toBeUndefined();
    expect(await sharedPlatform.deviceKeyStore.load()).toBeUndefined();
    expect(second.client.revoke).toHaveBeenCalledWith("node-random", "access-token");
  });

  it("classifies a rejected refresh token as terminal authorization failure", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: "invalid_grant" }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    try {
      const provider = new HttpDeviceAuthorizationProvider("https://control.example");
      await expect(provider.refresh("revoked-refresh-token")).rejects.toMatchObject({
        code: "EDGE_UNAUTHORIZED_TARGET",
        details: { status: 401 },
      });
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("edge local paths", () => {
  it("uses an explicit state directory on every platform", () => {
    const configured = defaultEdgePaths(
      "/Users/example",
      "darwin",
      { FENTARIS_EDGE_STATE_DIR: "/tmp/isolated-edge-state" },
    );
    expect(configured.dataDir).toBe("/tmp/isolated-edge-state");
    expect(configured.configFile).toBe(path.join(configured.dataDir, "config.json"));
  });

  it("rejects a relative explicit state directory", () => {
    expect(() => defaultEdgePaths("/Users/example", "darwin", {
      FENTARIS_EDGE_STATE_DIR: "./relative-edge-state",
    })).toThrow(/must be an absolute path/i);
  });

  it("keeps the native macOS default without an explicit override", () => {
    expect(defaultEdgePaths("/Users/example", "darwin", {}).dataDir)
      .toBe("/Users/example/Library/Application Support/Fentaris/edge");
  });
});

describe("edge agent and CLI", () => {
  it("maps join to enrollment metadata and the persistent service workflow", async () => {
    const fixture = service();
    const agent = new EdgeAgent({
      enrollment: fixture.service,
      platform: fixture.platform,
      connection: { connect: async () => ({ connectedAt: 2_000, close: async () => undefined }) },
    });
    const installService = vi.fn(async () => ({
      operation: "install" as const,
      persistent: true,
      adapter: "launchd" as const,
      nextActions: [],
    }));
    const output: string[] = [];
    await expect(runEdgeCli([
      "join", "https://control.example", "--name", "Mac Studio", "--description", "Build machine", "--tag", "xcode", "--tag", "development", "--json",
    ], agent, { out: (value) => output.push(value), error: () => undefined }, {
      installService,
      service: installService,
      run: async () => undefined,
    })).resolves.toBe(0);
    expect(installService).toHaveBeenCalledOnce();
    expect(fixture.client.enroll).toHaveBeenCalledWith(expect.objectContaining({
      name: "Mac Studio",
      description: "Build machine",
      tags: ["xcode", "development"],
    }));
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: true,
      data: { device: { name: "Mac Studio" }, service: { persistent: true } },
      pagination: null,
    });
  });

  it("connects on login, reports safe status, disconnects, and exposes no add command", async () => {
    const fixture = service();
    let closeCount = 0;
    const connection: EdgeConnectionClient = {
      connect: vi.fn(async () => ({
        connectedAt: 2_000,
        close: async () => { closeCount += 1; },
      })),
    };
    const agent = new EdgeAgent({
      enrollment: fixture.service,
      connection,
      platform: fixture.platform,
      runtimeSummary: {
        summary: async () => ({ desiredDeployments: 2, readyDeployments: 1, blockedDeployments: 1 }),
      },
    });
    const out: string[] = [];
    const errors: string[] = [];
    const io = { out: (value: string) => out.push(value), error: (value: string) => errors.push(value) };

    await expect(runEdgeCli(["login"], agent, io)).resolves.toBe(0);
    expect(JSON.parse(out.at(-1)!).warnings[0]).toContain("deprecated");
    await expect(runEdgeCli(["status"], agent, io)).resolves.toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      enrolled: true,
      connected: true,
      desiredDeployments: 2,
      edgeNodeId: "node-random",
    });
    expect(out.join("\n")).not.toContain("device-credential");
    expect(out.join("\n")).not.toContain("/private/user/path");

    await expect(runEdgeCli(["disconnect"], agent, io)).resolves.toBe(0);
    expect(closeCount).toBe(1);
    expect((await agent.status()).connected).toBe(false);
    await expect(runEdgeCli(["add"], agent, io)).resolves.toBe(2);
    expect(errors.at(-1)).toContain("managed by Fentaris");
  });

  it("redacts sensitive error content", async () => {
    const fixture = service();
    const agent = new EdgeAgent({
      enrollment: fixture.service,
      platform: fixture.platform,
      connection: {
        connect: async () => {
          throw new Error("token=abc path=/Users/alice/private credential=xyz");
        },
      },
    });
    const errors: string[] = [];
    await expect(runEdgeCli(["login"], agent, {
      out: () => undefined,
      error: (value) => errors.push(value),
    })).resolves.toBe(1);
    expect(errors[0]).not.toContain("abc");
    expect(errors[0]).not.toContain("/Users/alice/private");
    expect(errors[0]).not.toContain("xyz");
  });

  it("keeps processing control-plane frames after the WebSocket handshake", async () => {
    const keyPair = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const socket = new FakeWebSocket();
    const runtime = {
      connected: vi.fn(),
      handle: vi.fn(),
      disconnected: vi.fn(),
      summary: async () => ({ desiredDeployments: 0, readyDeployments: 0, blockedDeployments: 0 }),
    };
    const client = new WebSocketEdgeConnectionClient(() => socket as unknown as WebSocket);
    const pending = client.connect({
      gatewayUrl: "ws://127.0.0.1:4001/edge",
      edgeNodeId: "node-1",
      tenantId: "tenant-1",
      deviceCredential: "credential",
      accessToken: "token",
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      runtime,
    });
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.receive({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.hello.ack",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 2,
      protocolVersion: EDGE_PROTOCOL_VERSION,
      serverTime: 100,
    });
    const connection = await pending;
    expect(runtime.connected).toHaveBeenCalledOnce();
    const hello = JSON.parse(socket.sent[0]!) as { supportedVersions: number[] };
    expect(hello.supportedVersions).toEqual([3, 2, 1]);
    const report = JSON.parse(socket.sent[1]!) as Record<string, unknown>;
    expect(report).toMatchObject({ kind: "edge.presence", version: 3 });
    expect(JSON.stringify((report as { observed?: unknown }).observed)).not.toContain("node-1");

    const schema = createSetupSchema({});
    socket.receive({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.desired-state",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 2,
      desiredVersion: 1,
      deployments: [{
        deploymentId: "fixture",
        serverName: "fixture",
        recipe: compileLaunchRecipe({ command: "fixture" }, schema),
        setupSchema: schema,
      }],
    });
    await vi.waitFor(() => expect(runtime.handle).toHaveBeenCalledOnce());
    await connection.close();
    expect(runtime.disconnected).toHaveBeenCalledOnce();
  });

  it("reports gateway revocation as a terminal connection error", async () => {
    const keyPair = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const socket = new FakeWebSocket();
    const client = new WebSocketEdgeConnectionClient(() => socket as unknown as WebSocket);
    const pending = client.connect({
      gatewayUrl: "ws://127.0.0.1:4001/edge",
      edgeNodeId: "node-1",
      tenantId: "tenant-1",
      deviceCredential: "credential",
      accessToken: "token",
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    });
    socket.open();
    socket.receive({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.hello.ack",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 2,
      protocolVersion: EDGE_PROTOCOL_VERSION,
      serverTime: 100,
    });
    const connection = await pending;
    socket.close(4403, "revoked");
    await expect(connection.closed).rejects.toMatchObject({ code: "EDGE_UNAUTHORIZED_TARGET" });
  });

  it("preserves a terminal gateway close code during authentication", async () => {
    const keyPair = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const socket = new FakeWebSocket();
    const client = new WebSocketEdgeConnectionClient(() => socket as unknown as WebSocket);
    const pending = client.connect({
      gatewayUrl: "ws://127.0.0.1:4001/edge",
      edgeNodeId: "node-1",
      tenantId: "tenant-1",
      deviceCredential: "revoked-credential",
      accessToken: "token",
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    });
    socket.open();
    socket.dispatchEvent(new Event("error"));
    socket.close(4403, "revoked");
    await expect(pending).rejects.toMatchObject({ code: "EDGE_UNAUTHORIZED_TARGET" });
  });

  it("keeps the WebSocket frame queue resolved after a frame handler failure", async () => {
    const keyPair = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const socket = new FakeWebSocket();
    const runtime = {
      connected: vi.fn(),
      handle: vi.fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(undefined),
      disconnected: vi.fn(),
      summary: async () => ({ desiredDeployments: 0, readyDeployments: 0, blockedDeployments: 0 }),
    };
    const client = new WebSocketEdgeConnectionClient(() => socket as unknown as WebSocket);
    const pending = client.connect({
      gatewayUrl: "ws://127.0.0.1:4001/edge",
      edgeNodeId: "node-1",
      tenantId: "tenant-1",
      deviceCredential: "credential",
      accessToken: "token",
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      runtime,
    });
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.receive({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.hello.ack",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 2,
      protocolVersion: EDGE_PROTOCOL_VERSION,
      serverTime: 100,
    });
    await pending;

    const schema = createSetupSchema({});
    const recipe = compileLaunchRecipe({ command: "fixture" }, schema);
    socket.throwOnClose = true;
    socket.receive({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.desired-state",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 2,
      desiredVersion: 1,
      deployments: [{
        deploymentId: "first",
        serverName: "first",
        recipe,
        setupSchema: schema,
      }],
    });
    socket.receive({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.desired-state",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 2,
      desiredVersion: 2,
      deployments: [{
        deploymentId: "second",
        serverName: "second",
        recipe,
        setupSchema: schema,
      }],
    });

    await vi.waitFor(() => expect(runtime.handle).toHaveBeenCalledTimes(2));
  });
});

describe("protected file storage", () => {
  it("writes sensitive JSON with restrictive permissions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-"));
    try {
      const file = path.join(directory, "secret.json");
      const store = new ProtectedJsonStore<{ token: string }>(file);
      await store.save({ token: "secret" });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ token: "secret" });
      if (process.platform !== "win32") {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
