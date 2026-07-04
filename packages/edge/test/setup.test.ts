import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileLaunchRecipe,
  createSetupSchema,
  edge,
  runtime,
  type LaunchRecipe,
  type SetupField,
} from "@fentaris/core";
import {
  LocalSetupManager,
  type CredentialStore,
  type DesiredSetupRequirement,
  type JsonStore,
  type LocalGrantDatabase,
  type LocalSetupProvider,
} from "../src/index.js";

class MemoryStore implements JsonStore<LocalGrantDatabase> {
  value?: LocalGrantDatabase;
  async load() { return this.value; }
  async save(value: LocalGrantDatabase) { this.value = structuredClone(value); }
  async delete() { this.value = undefined; }
}

class MemoryCredentials implements CredentialStore {
  readonly values = new Map<string, string>();
  async get(name: string) { return this.values.get(name); }
  async set(name: string, value: string) { this.values.set(name, value); }
  async delete(name: string) { this.values.delete(name); }
}

class TestProvider implements LocalSetupProvider {
  approved = true;
  readonly values = new Map<string, unknown>();
  readonly collected: string[] = [];
  approveWorkload = vi.fn(async () => this.approved);
  async collectField(field: SetupField) {
    this.collected.push(field.name);
    return this.values.has(field.name)
      ? { approved: true, value: this.values.get(field.name) }
      : { approved: false };
  }
}

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace() {
  const created = await mkdtemp(path.join(tmpdir(), "fentaris-setup-"));
  temporary.push(created);
  const root = await realpath(created);
  const granted = path.join(root, "granted");
  const nested = path.join(granted, "nested");
  const outside = path.join(root, "outside");
  await mkdir(nested, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(nested, "inside.txt"), "inside");
  await writeFile(path.join(outside, "outside.txt"), "outside");
  await symlink(outside, path.join(granted, "escape"));
  return { root, granted, nested, outside };
}

function requirement(
  workspacePath: string,
  overrides: {
    desiredStateVersion?: number;
    schemaVersion?: number;
    access?: "read" | "read-write";
    recipe?: LaunchRecipe;
  } = {},
): DesiredSetupRequirement {
  const schema = createSetupSchema({
    workspace: edge.folder({ access: overrides.access ?? "read" }),
    token: edge.secret(),
    mode: edge.select({ options: ["safe", "fast"] }),
    retries: edge.number({ min: 1, max: 5 }),
    enabled: edge.boolean(),
    label: edge.string(),
  }, overrides.schemaVersion ?? 1);
  return {
    deploymentId: "fixture",
    desiredStateVersion: overrides.desiredStateVersion ?? 1,
    schema,
    recipe: overrides.recipe ?? compileLaunchRecipe({
      command: "fixture",
      args: [
        "--workspace", runtime.input("workspace"),
        "--mode", runtime.input("mode"),
        "--retries", runtime.input("retries"),
        "--enabled", runtime.input("enabled"),
        "--label", runtime.input("label"),
      ],
      env: { TOKEN: runtime.secret("token") },
    }, schema),
  };
}

function manager(provider: TestProvider) {
  const store = new MemoryStore();
  const credentials = new MemoryCredentials();
  let nextId = 0;
  const revoked = vi.fn();
  return {
    store,
    credentials,
    revoked,
    manager: new LocalSetupManager({
      store,
      credentials,
      provider,
      grantId: () => `grant-${++nextId}`,
      now: () => 100,
      onGrantRevoked: revoked,
    }),
  };
}

describe("LocalSetupManager", () => {
  it("ingests desired setup, stores opaque grants, validates scalars, and compiles locally", async () => {
    const paths = await workspace();
    const provider = new TestProvider();
    provider.values.set("workspace", paths.granted);
    provider.values.set("token", "local-secret");
    provider.values.set("mode", "safe");
    provider.values.set("retries", 3);
    provider.values.set("enabled", true);
    provider.values.set("label", "local");
    const fixture = manager(provider);
    const desired = requirement(paths.granted);

    const state = await fixture.manager.ingest(desired);
    expect(state.status).toBe("ready");
    expect(state.grantRefs).toEqual({
      workspace: "grant-1",
      token: "grant-2",
      mode: "grant-3",
      retries: "grant-4",
      enabled: "grant-5",
      label: "grant-6",
    });
    expect(JSON.stringify(state)).not.toContain(paths.granted);
    expect(JSON.stringify(fixture.store.value)).not.toContain("local-secret");
    expect([...fixture.credentials.values.values()]).toContain("local-secret");

    await expect(fixture.manager.compileLaunchPlan(desired)).resolves.toEqual({
      deploymentId: "fixture",
      recipeDigest: desired.recipe.digest,
      command: "fixture",
      args: [
        "--workspace", paths.granted,
        "--mode", "safe",
        "--retries", "3",
        "--enabled", "true",
        "--label", "local",
      ],
      env: { TOKEN: "local-secret" },
    });
  });

  it("rejects stale setup, invalid scalar values, denied consent, and code payloads", async () => {
    const paths = await workspace();
    const provider = new TestProvider();
    provider.values.set("workspace", paths.granted);
    provider.values.set("token", "secret");
    provider.values.set("mode", "invalid");
    provider.values.set("retries", 3);
    provider.values.set("enabled", true);
    provider.values.set("label", "local");
    const fixture = manager(provider);
    await expect(fixture.manager.ingest(requirement(paths.granted))).rejects.toMatchObject({ code: "EDGE_GRANT" });

    provider.values.set("mode", "safe");
    const desired = requirement(paths.granted);
    await fixture.manager.ingest(desired);
    await expect(fixture.manager.compileLaunchPlan({
      ...desired,
      desiredStateVersion: 2,
    })).rejects.toMatchObject({ code: "EDGE_SETUP_REQUIRED" });

    const deniedProvider = new TestProvider();
    deniedProvider.approved = false;
    const denied = manager(deniedProvider);
    await expect(denied.manager.ingest(desired)).resolves.toMatchObject({ status: "denied" });

    const malicious = {
      ...desired.recipe,
      executable: () => "payload",
    } as LaunchRecipe;
    await expect(fixture.manager.ingest({ ...desired, recipe: malicious })).rejects.toMatchObject({ code: "EDGE_PROTOCOL" });
  });

  it("reuses unaffected grants, invalidates changed fields, and revocation blocks dependent workloads", async () => {
    const paths = await workspace();
    const provider = new TestProvider();
    provider.values.set("workspace", paths.granted);
    provider.values.set("token", "secret");
    provider.values.set("mode", "safe");
    provider.values.set("retries", 3);
    provider.values.set("enabled", true);
    provider.values.set("label", "local");
    const fixture = manager(provider);
    const first = await fixture.manager.ingest(requirement(paths.granted));
    provider.collected.length = 0;

    const second = await fixture.manager.ingest(requirement(paths.granted, {
      desiredStateVersion: 2,
      schemaVersion: 2,
      access: "read-write",
    }));
    expect(provider.collected).toEqual(["workspace"]);
    expect(second.grantRefs.token).toBe(first.grantRefs.token);
    expect(second.grantRefs.workspace).not.toBe(first.grantRefs.workspace);

    await fixture.manager.revokeGrant(second.grantRefs.token);
    await expect(fixture.manager.status("fixture")).resolves.toMatchObject({
      status: "revoked",
      missingFields: ["token"],
    });
    expect(fixture.revoked).toHaveBeenCalledWith(second.grantRefs.token, ["fixture"]);
  });

  it("keeps missing fields pending and accepts assignments delivered after initial setup", async () => {
    const paths = await workspace();
    const provider = new TestProvider();
    provider.values.set("token", "secret");
    provider.values.set("mode", "safe");
    provider.values.set("retries", 3);
    provider.values.set("enabled", true);
    provider.values.set("label", "local");
    const fixture = manager(provider);
    const desired = requirement(paths.granted);
    await expect(fixture.manager.ingest(desired)).resolves.toMatchObject({
      status: "pending",
      missingFields: ["workspace"],
    });

    provider.values.set("workspace", paths.granted);
    await expect(fixture.manager.ingest(desired)).resolves.toMatchObject({ status: "ready" });
    await expect(fixture.manager.ingest({
      ...desired,
      deploymentId: "assigned-after-login",
      desiredStateVersion: 2,
    })).resolves.toMatchObject({
      deploymentId: "assigned-after-login",
      status: "ready",
    });
  });

  it("enforces traversal, symlink containment, and read/write access on every resolution", async () => {
    const paths = await workspace();
    const provider = new TestProvider();
    provider.values.set("workspace", paths.granted);
    provider.values.set("token", "secret");
    provider.values.set("mode", "safe");
    provider.values.set("retries", 3);
    provider.values.set("enabled", true);
    provider.values.set("label", "local");
    const fixture = manager(provider);
    const state = await fixture.manager.ingest(requirement(paths.granted, { access: "read" }));
    const grant = state.grantRefs.workspace;

    await expect(fixture.manager.resolveGrantedPath(grant, "nested/inside.txt")).resolves.toBe(
      path.join(paths.nested, "inside.txt"),
    );
    await expect(fixture.manager.resolveGrantedPath(grant, "../outside/outside.txt")).rejects.toMatchObject({
      code: "EDGE_GRANT",
    });
    await expect(fixture.manager.resolveGrantedPath(grant, "escape/outside.txt")).rejects.toMatchObject({
      code: "EDGE_GRANT",
    });
    await expect(fixture.manager.resolveGrantedPath(grant, ".", "read-write")).rejects.toMatchObject({
      code: "EDGE_GRANT",
    });
  });
});
