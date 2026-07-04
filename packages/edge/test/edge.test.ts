import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EdgeAgent,
  EdgeEnrollmentService,
  ProtectedJsonStore,
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
      now: () => now,
      sleep: async () => undefined,
      hostnameLabel: () => input.hostname ?? "laptop",
    }),
  };
}

describe("edge enrollment", () => {
  it("creates a random key, proves possession, enrolls, and reuses identity on repeat login", async () => {
    const fixture = service();
    const first = await fixture.service.login();
    expect(first.repeated).toBe(false);
    expect(first.config.edgeNodeId).toBe("node-random");
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
});

describe("edge agent and CLI", () => {
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

