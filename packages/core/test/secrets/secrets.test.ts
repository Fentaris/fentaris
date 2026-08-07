import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FentarisAuth, LocalSecretsBackend, credentialsToRefs, diffManifest, encodeSecretScope, manifestFromSecretRefs, manifestsEqual, parseManifest, serializeManifest } from "@fentaris/core";

describe("secrets", () => {
  const key = "test-key";
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("lists credential refs without values", async () => {
    const dir = await createDir("fentaris-secrets-test-");
    const backend = await LocalSecretsBackend.open({ dir, key });
    await backend.initEmpty();
    await backend.set("github.token", "secret-value", { kind: "default" });
    await backend.set("stripe.apiKey", "stripe-secret", { kind: "group", id: "support" });

    const refs = await backend.listRefs();
    expect(refs).toEqual(
      expect.arrayContaining([
        { ref: "github.token", scope: { kind: "default" }, kind: "credential", count: 1 },
        { ref: "stripe.apiKey", scope: { kind: "group", id: "support" }, kind: "credential", count: 1 },
      ]),
    );
    expect(JSON.stringify(refs)).not.toContain("secret-value");
  });

  it("diffs manifest against stored refs", () => {
    const stored = credentialsToRefs({
      users: {},
      groups: {},
      defaults: { "github.token": "x" },
    });
    const diff = diffManifest(
      [
        { ref: "github.token", scope: "default" },
        { ref: "stripe.apiKey", scope: "group:support" },
      ],
      stored,
    );
    expect(diff.missing).toEqual([{ ref: "stripe.apiKey", scope: "group:support" }]);
    expect(diff.extra).toEqual([]);
  });

  it("round-trips manifest serialization", () => {
    const manifest = manifestFromSecretRefs(
      [
        { ref: "b.ref", scope: { kind: "default" }, kind: "credential", count: 1 },
        { ref: "a.ref", scope: { kind: "group", id: "support" }, kind: "credential", count: 1 },
      ],
      ["GITHUB_TOKEN"],
    );
    const parsed = parseManifest(JSON.parse(serializeManifest(manifest)));
    expect(manifestsEqual(manifest, parsed)).toBe(true);
    expect(parsed.envVars).toEqual(["GITHUB_TOKEN"]);
  });

  it("round-trips source metadata and API-key requirements", () => {
    const parsed = parseManifest(JSON.parse(serializeManifest({
      version: 1,
      references: [
        { ref: "github.token", scope: "default", source: { type: "local" } },
        { ref: "linear.token", scope: "user:alice", source: { type: "env", name: "LINEAR_TOKEN" } },
      ],
      apiKeys: [
        { userId: "operator", source: { type: "env", name: "OPERATOR_API_KEY" } },
        { userId: "admin", source: { type: "local" }, count: 2 },
      ],
    })));

    expect(parsed.references).toEqual([
      { ref: "github.token", scope: "default", source: { type: "local" } },
      { ref: "linear.token", scope: "user:alice", source: { type: "env", name: "LINEAR_TOKEN" } },
    ]);
    expect(parsed.apiKeys).toEqual([
      { userId: "admin", source: { type: "local" }, count: 2 },
      { userId: "operator", source: { type: "env", name: "OPERATOR_API_KEY" } },
    ]);
  });

  it("keeps legacy version 1 manifest entries as implicit local credentials", () => {
    expect(parseManifest({
      version: 1,
      references: [{ ref: "github.token", scope: "default" }],
    })).toEqual({
      version: 1,
      references: [{ ref: "github.token", scope: "default" }],
    });
    expect(manifestsEqual(
      { version: 1, references: [{ ref: "github.token", scope: "default" }] },
      { version: 1, references: [{ ref: "github.token", scope: "default", source: { type: "local" } }] },
    )).toBe(true);
  });

  it("unsets credentials", async () => {
    const dir = await createDir("fentaris-secrets-unset-");
    const backend = await LocalSecretsBackend.open({ dir, key });
    await backend.initEmpty();
    await backend.set("github.token", "secret", { kind: "default" });
    expect(await backend.has("github.token", { kind: "default" })).toBe(true);
    await expect(backend.unset("github.token", { kind: "default" })).resolves.toBe(true);
    expect(await backend.has("github.token", { kind: "default" })).toBe(false);
    await expect(backend.unset("github.token", { kind: "default" })).resolves.toBe(false);
  });

  it("does not treat user API keys as arbitrary user credentials", async () => {
    const dir = await createDir("fentaris-secrets-api-key-");
    const backend = await LocalSecretsBackend.open({ dir, key });
    await writeFile(
      join(dir, "credentials.enc.json"),
      JSON.stringify(
        FentarisAuth.encryptCredentials(
          {
            users: { alice: { apiKeys: ["api-key"], credentials: {} } },
            groups: {},
            defaults: {},
          },
          key,
        ),
      ),
    );

    expect(await backend.has("github.token", { kind: "user", id: "alice" })).toBe(false);
  });

  it("adds, deduplicates, and removes hashed user API keys", async () => {
    const dir = await createDir("fentaris-secrets-api-key-manage-");
    const backend = await LocalSecretsBackend.open({ dir, key });
    await backend.initEmpty();

    await expect(backend.addUserApiKey("alice", "api-key")).resolves.toBe(true);
    await expect(backend.addUserApiKey("alice", "api-key")).resolves.toBe(false);

    const afterAdd = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, "credentials.enc.json"), "utf8")) as unknown, key);
    expect(afterAdd.users.alice?.apiKeys).toHaveLength(1);
    expect(afterAdd.users.alice?.apiKeys[0]).toMatch(/^sha256:/);
    expect(afterAdd.users.alice?.apiKeys[0]).not.toBe("api-key");
    expect(FentarisAuth.compareApiKey(afterAdd.users.alice?.apiKeys[0] ?? "", "api-key")).toBe(true);

    await expect(backend.removeUserApiKey("alice", "wrong-key")).resolves.toBe(false);
    await expect(backend.removeUserApiKey("alice", "api-key")).resolves.toBe(true);

    const afterRemove = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, "credentials.enc.json"), "utf8")) as unknown, key);
    expect(afterRemove.users.alice).toBeUndefined();
  });

  it("encrypts through FentarisAuth compatibility", async () => {
    const dir = await createDir("fentaris-secrets-compat-");
    const backend = await LocalSecretsBackend.open({ dir, key });
    await backend.initEmpty();
    await backend.set("github.token", "value", { kind: "default" });
    const decrypted = FentarisAuth.decryptCredentials(
      JSON.parse(await readFile(join(dir, "credentials.enc.json"), "utf8")) as unknown,
      key,
    );
    expect(decrypted.defaults["github.token"]).toBe("value");
    expect(encodeSecretScope({ kind: "group", id: "support" })).toBe("group:support");
    const envelope = JSON.parse(await readFile(join(dir, "credentials.enc.json"), "utf8")) as { version: number; kdf?: { name: string; iterations: number } };
    expect(envelope.version).toBe(2);
    expect(envelope.kdf?.name).toBe("pbkdf2-sha256");
    expect(envelope.kdf?.iterations).toBeGreaterThan(100_000);
  });

  it("reads legacy SHA-256 encrypted credentials and writes migrated envelopes", async () => {
    const dir = await createDir("fentaris-secrets-legacy-");
    await writeFile(
      join(dir, "credentials.enc.json"),
      JSON.stringify(legacyEncryptCredentials({ users: {}, groups: {}, defaults: { "github.token": "legacy" } }, key)),
    );
    const backend = await LocalSecretsBackend.open({ dir, key });

    expect(await backend.has("github.token", { kind: "default" })).toBe(true);
    await backend.set("stripe.apiKey", "new", { kind: "default" });

    const envelope = JSON.parse(await readFile(join(dir, "credentials.enc.json"), "utf8")) as { version: number };
    expect(envelope.version).toBe(2);
    const decrypted = FentarisAuth.decryptCredentials(envelope, key);
    expect(decrypted.defaults["github.token"]).toBe("legacy");
    expect(decrypted.defaults["stripe.apiKey"]).toBe("new");
  });

  it("rejects wrong local credential keys", async () => {
    const dir = await createDir("fentaris-secrets-wrong-key-");
    const backend = await LocalSecretsBackend.open({ dir, key });
    await backend.initEmpty();

    const wrongKeyBackend = await LocalSecretsBackend.open({ dir, key: "wrong-key" });
    await expect(wrongKeyBackend.listRefs()).rejects.toThrow("Unable to decrypt local credentials");
  });

  it("writes owner-only credential file modes on Unix", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await createDir("fentaris-secrets-mode-");
    const backend = await LocalSecretsBackend.open({ dir, key });
    await backend.initEmpty();
    await chmod(join(dir, "credentials.enc.json"), 0o644);
    await backend.set("github.token", "value", { kind: "default" });

    expect((await stat(join(dir, "credentials.enc.json"))).mode & 0o777).toBe(0o600);
  });
});

function legacyEncryptCredentials(credentials: unknown, key: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(key).update(salt).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
