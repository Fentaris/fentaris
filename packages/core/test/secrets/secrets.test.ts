import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  it("unsets credentials", async () => {
    const dir = await createDir("fentaris-secrets-unset-");
    const backend = await LocalSecretsBackend.open({ dir, key });
    await backend.initEmpty();
    await backend.set("github.token", "secret", { kind: "default" });
    expect(await backend.has("github.token", { kind: "default" })).toBe(true);
    await backend.unset("github.token", { kind: "default" });
    expect(await backend.has("github.token", { kind: "default" })).toBe(false);
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
  });
});
