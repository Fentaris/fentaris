import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EDGE_PROTOCOL_VERSION,
  compileLaunchRecipe,
  createSetupSchema,
  edge,
  parseEdgeProtocolMessage,
  type EdgeAgentMessage,
  type LaunchRecipe,
  type SetupSchema,
} from "@fentaris/core";
import {
  EdgeAgentRuntime,
  EdgeWorkloadSupervisor,
  ExecutableAllowlistPolicy,
  LocalSetupManager,
  ManagedInstallManager,
  NodeTerminalSetupPrompter,
  TerminalSetupProvider,
  type CompiledLocalLaunchPlan,
  type CredentialStore,
  type EdgeInstallCommandInput,
  type EdgeInstallCommandRunner,
  type EdgeWorkloadFactory,
  type JsonStore,
  type LocalGrantDatabase,
  type LocalInstallDatabase,
  type TerminalSetupPrompter,
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

class TreeRunner implements EdgeInstallCommandRunner {
  exitCode = 0;
  readonly calls: EdgeInstallCommandInput[] = [];
  async run(input: EdgeInstallCommandInput) {
    this.calls.push(input);
    if (this.exitCode !== 0) return { exitCode: this.exitCode };
    const packageDirectory = path.join(input.cwd, "node_modules", "@scope", "server");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ version: "1.4.2" }));
    const binDirectory = path.join(input.cwd, "node_modules", ".bin");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(path.join(binDirectory, "scope-server"), "#!/bin/sh\n", { mode: 0o700 });
    return { exitCode: 0 };
  }
}

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function managedRecipe(schema: SetupSchema): LaunchRecipe {
  return compileLaunchRecipe({
    command: "scope-server",
    args: ["--stdio"],
    install: edge.npm({ package: "@scope/server", version: "1.4.2", bin: "scope-server" }),
  }, schema);
}

async function agent(options: { packages?: readonly string[] } = {}) {
  const created = await mkdtemp(path.join(tmpdir(), "fentaris-managed-"));
  temporary.push(created);
  const dataDir = await realpath(created);
  const runner = new TreeRunner();
  const installStore = new MemoryStore<LocalInstallDatabase>();
  const policy = new ExecutableAllowlistPolicy({ packages: options.packages ?? ["@scope/server"] });
  const installs = new ManagedInstallManager({
    store: installStore,
    root: path.join(dataDir, "installs"),
    runner,
    allowInstall: (plan) => policy.allowInstall(plan),
  });
  const setup = new LocalSetupManager({
    store: new MemoryStore<LocalGrantDatabase>(),
    credentials: new MemoryCredentials(),
    provider: { approveWorkload: async () => true, collectField: async () => ({ approved: true }) },
    resolveManagedCommand: (requirement) => installs.resolveCommand(requirement),
  });
  const plans: CompiledLocalLaunchPlan[] = [];
  const factory: EdgeWorkloadFactory = {
    start: vi.fn(async (plan) => {
      plans.push(plan);
      return {
        client: { request: async () => ({ content: [] }) },
        stopGracefully: async () => undefined,
        forceKill: async () => undefined,
      };
    }),
  };
  const supervisor = new EdgeWorkloadSupervisor({ setup, factory, installs, executablePolicy: policy });
  const runtime = new EdgeAgentRuntime({ setup, supervisor, installs });
  const sent: EdgeAgentMessage[] = [];
  runtime.connected({
    claims: { tenantId: "tenant-1", edgeNodeId: "node-1", connectionGeneration: 3 },
    send: async (message) => { sent.push(message); },
    publishPresence: async () => undefined,
  });
  return { dataDir, runner, installStore, installs, setup, supervisor, runtime, sent, plans, factory };
}

async function publish(runtime: EdgeAgentRuntime, deployments: readonly { id: string; recipe: LaunchRecipe; schema: SetupSchema }[], desiredVersion: number) {
  await runtime.handle({
    version: EDGE_PROTOCOL_VERSION,
    kind: "edge.desired-state",
    tenantId: "tenant-1",
    edgeNodeId: "node-1",
    connectionGeneration: 3,
    desiredVersion,
    deployments: deployments.map((deployment) => ({
      deploymentId: deployment.id,
      serverName: deployment.id,
      recipe: deployment.recipe,
      setupSchema: deployment.schema,
    })),
  });
}

describe("managed installation during reconciliation", () => {
  it("installs, becomes ready, launches the managed bin, and reports a bounded install status", async () => {
    const fixture = await agent();
    const schema = createSetupSchema({});
    await publish(fixture.runtime, [{ id: "filesystem", recipe: managedRecipe(schema), schema }], 1);

    await expect(fixture.runtime.summary()).resolves.toMatchObject({
      readyDeployments: 1,
      blockedDeployments: 0,
      installedPackages: 1,
      failedInstalls: 0,
    });
    await expect(fixture.runtime.presenceSnapshot()).resolves.toMatchObject({
      readiness: [expect.objectContaining({ deploymentId: "filesystem", status: "ready" })],
    });

    const setupStatus = fixture.sent.find((message) => message.kind === "edge.setup-status");
    expect(setupStatus).toMatchObject({
      status: "ready",
      install: {
        status: "installed",
        packageId: "@scope/server@1.4.2",
        resolvedVersion: "1.4.2",
      },
    });
    expect(JSON.stringify(setupStatus)).not.toContain(fixture.dataDir);
    expect(() => parseEdgeProtocolMessage(JSON.stringify(setupStatus))).not.toThrow();

    const plan = await fixture.setup.compileLaunchPlan({
      deploymentId: "filesystem",
      desiredStateVersion: 1,
      schema,
      recipe: managedRecipe(schema),
    });
    expect(plan.command.startsWith(path.join(fixture.dataDir, "installs", "packages"))).toBe(true);
    expect(plan.command.endsWith(path.join("node_modules", ".bin", "scope-server"))).toBe(true);
    expect(plan.install?.package).toBe("@scope/server");
  });

  it("blocks the deployment and reports install-required when installation fails", async () => {
    const fixture = await agent();
    fixture.runner.exitCode = 1;
    const schema = createSetupSchema({});
    await publish(fixture.runtime, [{ id: "filesystem", recipe: managedRecipe(schema), schema }], 1);

    await expect(fixture.runtime.summary()).resolves.toMatchObject({
      readyDeployments: 0,
      blockedDeployments: 1,
      failedInstalls: 1,
    });
    await expect(fixture.runtime.presenceSnapshot()).resolves.toMatchObject({
      readiness: [expect.objectContaining({ status: "install-required", reasonCategory: "install-failed" })],
    });
    expect(fixture.sent.find((message) => message.kind === "edge.setup-status")).toMatchObject({
      install: { status: "failed", reasonCategory: "install-failed" },
    });
    expect(fixture.sent.find((message) => message.kind === "edge.desired-state.ack")).toMatchObject({
      status: "blocked",
      blockedDeploymentIds: ["filesystem"],
    });
    await expect(fixture.setup.compileLaunchPlan({
      deploymentId: "filesystem",
      desiredStateVersion: 1,
      schema,
      recipe: managedRecipe(schema),
    })).rejects.toMatchObject({ code: "EDGE_SETUP_REQUIRED" });
  });

  it("denies an unapproved package before fetching and reports install-denied", async () => {
    const fixture = await agent({ packages: [] });
    const schema = createSetupSchema({});
    await publish(fixture.runtime, [{ id: "filesystem", recipe: managedRecipe(schema), schema }], 1);

    expect(fixture.runner.calls).toHaveLength(0);
    await expect(fixture.runtime.presenceSnapshot()).resolves.toMatchObject({
      readiness: [expect.objectContaining({ status: "install-required", reasonCategory: "install-denied" })],
    });
  });

  it("is idempotent on replay and prunes installs when the deployment is removed", async () => {
    const fixture = await agent();
    const schema = createSetupSchema({});
    const deployments = [{ id: "filesystem", recipe: managedRecipe(schema), schema }];
    await publish(fixture.runtime, deployments, 1);
    await publish(fixture.runtime, deployments, 2);
    expect(fixture.runner.calls).toHaveLength(1);

    await publish(fixture.runtime, [], 3);
    expect(fixture.installStore.value?.records).toEqual({});
    await expect(readdir(path.join(fixture.dataDir, "installs", "packages"))).resolves.toEqual([]);
  });

  it("clears managed installs with the rest of the local state", async () => {
    const fixture = await agent();
    const schema = createSetupSchema({});
    await publish(fixture.runtime, [{ id: "filesystem", recipe: managedRecipe(schema), schema }], 1);
    await fixture.runtime.clearLocalState();
    expect(fixture.installStore.value).toBeUndefined();
    await expect(readdir(path.join(fixture.dataDir, "installs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the pinned package in the local consent prompt", async () => {
    const prompts: string[] = [];
    const prompter: TerminalSetupPrompter = {
      confirm: async (message) => { prompts.push(message); return true; },
      input: async () => "",
    };
    const provider = new TerminalSetupProvider(prompter);
    const schema = createSetupSchema({});
    await provider.approveWorkload({
      deploymentId: "filesystem",
      desiredStateVersion: 1,
      schema,
      recipe: managedRecipe(schema),
    });
    expect(prompts[0]).toContain("install @scope/server@1.4.2");
    expect(new NodeTerminalSetupPrompter()).toBeInstanceOf(NodeTerminalSetupPrompter);
  });

  it("refuses managed-install deployments when the agent has no installer", async () => {
    const setup = new LocalSetupManager({
      store: new MemoryStore<LocalGrantDatabase>(),
      credentials: new MemoryCredentials(),
      provider: { approveWorkload: async () => true, collectField: async () => ({ approved: true }) },
    });
    const schema = createSetupSchema({});
    const requirement = {
      deploymentId: "filesystem",
      desiredStateVersion: 1,
      schema,
      recipe: managedRecipe(schema),
    };
    await setup.ingest(requirement);
    await expect(setup.compileLaunchPlan(requirement)).rejects.toMatchObject({ code: "EDGE_SETUP_REQUIRED" });
  });
});
