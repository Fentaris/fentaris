import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  LocalOAuthTokenStore,
  MemoryOAuthTokenStore,
  oauthTokens,
  type OAuthStoreRecord,
} from "../../src/auth/oauth/store.js";
import { FentarisAuth } from "../../src/auth/auth.js";

const key = "test-oauth-store-key";

function record(overrides: Partial<OAuthStoreRecord> = {}): OAuthStoreRecord {
  return {
    tokens: { access_token: "at-1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1", obtainedAt: 1_000 },
    clientInformation: { client_id: "client-1", redirect_uris: ["http://127.0.0.1:9999/callback"] },
    updatedAt: 1_000,
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fentaris-oauth-store-"));
}

describe("MemoryOAuthTokenStore", () => {
  it("round-trips, deletes, and lists records without token values", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set("github", "user:alice", record());

    expect((await store.get("github", "user:alice"))?.tokens?.access_token).toBe("at-1");
    expect(await store.get("github", "user:bob")).toBeUndefined();

    const entries = await store.list();
    expect(entries).toEqual([
      {
        server: "github",
        session: "user:alice",
        hasTokens: true,
        hasClientInformation: true,
        expiresAt: 1_000 + 3_600_000,
        updatedAt: 1_000,
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("at-1");

    await store.delete("github", "user:alice");
    expect(await store.list()).toEqual([]);
  });
});

describe("LocalOAuthTokenStore", () => {
  it("persists records encrypted with owner-only permissions", async () => {
    const dir = await tempDir();
    const store = oauthTokens.local({ dir, key });
    await store.set("linear", "shared", record());

    const raw = await readFile(store.filePath, "utf8");
    expect(raw).not.toContain("at-1");
    expect(JSON.parse(raw)).toMatchObject({ version: 2, algorithm: "aes-256-gcm" });
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);

    const reopened = oauthTokens.local({ dir, key });
    expect((await reopened.get("linear", "shared"))?.tokens?.refresh_token).toBe("rt-1");
  });

  it("observes another process's write without restart", async () => {
    const dir = await tempDir();
    const proxySide = oauthTokens.local({ dir, key });
    const cliSide = oauthTokens.local({ dir, key });

    await proxySide.set("linear", "user:alice", record());
    expect((await proxySide.get("linear", "user:alice"))?.tokens?.access_token).toBe("at-1");

    await cliSide.set("linear", "user:alice", record({ tokens: { access_token: "at-2", token_type: "Bearer", obtainedAt: 2_000 } }));

    expect((await proxySide.get("linear", "user:alice"))?.tokens?.access_token).toBe("at-2");
  });

  it("keeps both records when two writers interleave", async () => {
    const dir = await tempDir();
    const first = oauthTokens.local({ dir, key });
    const second = oauthTokens.local({ dir, key });

    await Promise.all([
      first.set("github", "user:alice", record()),
      second.set("github", "user:bob", record({ tokens: { access_token: "at-bob", token_type: "Bearer", obtainedAt: 3_000 } })),
    ]);

    const fresh = oauthTokens.local({ dir, key });
    expect((await fresh.get("github", "user:alice"))?.tokens?.access_token).toBe("at-1");
    expect((await fresh.get("github", "user:bob"))?.tokens?.access_token).toBe("at-bob");
  });

  it("fails closed on a wrong key without overwriting the file", async () => {
    const dir = await tempDir();
    const store = oauthTokens.local({ dir, key });
    await store.set("github", "shared", record());
    const before = await readFile(store.filePath, "utf8");

    const wrong = oauthTokens.local({ dir, key: "not-the-key" });
    await expect(wrong.get("github", "shared")).rejects.toThrow(/Unable to decrypt OAuth token store/);
    await expect(wrong.set("github", "shared", record())).rejects.toThrow(/Unable to decrypt OAuth token store/);

    expect(await readFile(store.filePath, "utf8")).toBe(before);
    expect((await oauthTokens.local({ dir, key }).get("github", "shared"))?.tokens?.access_token).toBe("at-1");
  });

  it("requires an encryption key", async () => {
    const dir = await tempDir();
    const previous = process.env.FENTARIS_AUTH_KEY;
    delete process.env.FENTARIS_AUTH_KEY;
    try {
      expect(() => new LocalOAuthTokenStore({ dir })).toThrow(/requires an encryption key/);
    } finally {
      if (previous !== undefined) {
        process.env.FENTARIS_AUTH_KEY = previous;
      }
    }
  });

  it("never touches the credentials store", async () => {
    const dir = await tempDir();
    const credentialsPath = join(dir, "credentials.enc.json");
    await writeFile(
      credentialsPath,
      JSON.stringify(FentarisAuth.encryptCredentials({ users: {}, groups: {}, defaults: { "github.token": "secret" } }, key)),
      "utf8",
    );
    const before = await readFile(credentialsPath, "utf8");

    const store = oauthTokens.local({ dir, key });
    await store.set("github", "shared", record());
    await store.delete("github", "shared");

    expect(await readFile(credentialsPath, "utf8")).toBe(before);
    expect(existsSync(join(dir, "oauth-tokens.enc.json"))).toBe(true);
  });
});
