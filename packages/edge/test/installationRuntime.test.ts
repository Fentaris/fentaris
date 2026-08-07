import { describe, expect, it, vi } from "vitest";
import {
  EDGE_PROTOCOL_VERSION,
  compileLaunchRecipe,
  computeRecipeDigest,
  createSetupSchema,
  edge,
  installedArtifact,
  type EdgeAgentMessage,
  type InstallationLifecycleSummary,
  type LaunchRecipe,
} from "@fentaris/core";
import { EdgeAgentRuntime, type EdgeWorkloadSupervisor, type InstallationCoordinator, type LocalSetupManager } from "../src/index.js";

const integrity = `sha256:${"1".repeat(64)}` as const;

function recipes() {
  const installation = edge.install.nodePackage({ package: "server", version: "1.0.0", integrity }, {
    verification: [{ kind: "executable", target: "bin/server" }],
    outputs: [{ name: "server", kind: "executable", path: "bin/server" }],
  });
  const base = compileLaunchRecipe({ command: "placeholder" });
  const payload: Omit<LaunchRecipe, "digest"> = { ...base, command: installedArtifact(installation, "server") };
  const launch: LaunchRecipe = { ...payload, digest: computeRecipeDigest(payload) };
  return { installation, launch };
}

describe("installation-aware runtime sequencing", () => {
  it("installs and verifies before setup/workload reconciliation and reports correlated lifecycle", async () => {
    const { installation, launch } = recipes();
    const order: string[] = [];
    const lifecycle: InstallationLifecycleSummary = {
      deploymentId: "server",
      desiredVersion: 1,
      recipeDigest: installation.digest,
      launchDigest: launch.digest,
      state: "installed",
      readiness: "setup-required",
      observedAt: 10,
    };
    const coordinator = { reconcile: vi.fn(async () => { order.push("installation"); return lifecycle; }), recoverInterrupted: vi.fn(async () => []) };
    const supervisor = {
      reconcile: vi.fn(async (deployments: Parameters<EdgeWorkloadSupervisor["reconcile"]>[0]) => {
        order.push("setup-workload");
        return deployments.map(({ requirement }) => ({ deploymentId: requirement.deploymentId, status: "ready" as const }));
      }),
      shutdown: vi.fn(), handleRequest: vi.fn(), handleCancel: vi.fn(), blockDeployment: vi.fn(),
    };
    const setup = { status: vi.fn(async () => undefined), clear: vi.fn() };
    const sent: EdgeAgentMessage[] = [];
    const runtime = new EdgeAgentRuntime({
      setup: setup as unknown as LocalSetupManager,
      supervisor: supervisor as unknown as EdgeWorkloadSupervisor,
      installation: coordinator as unknown as InstallationCoordinator,
    });
    await runtime.connected({
      protocolVersion: 3,
      claims: { tenantId: "tenant", edgeNodeId: "node", connectionGeneration: 1 },
      send: async (message) => { sent.push(message); },
    });
    await runtime.handle({
      version: 3,
      kind: "edge.desired-state",
      tenantId: "tenant",
      edgeNodeId: "node",
      connectionGeneration: 1,
      desiredVersion: 1,
      deployments: [{
        deploymentId: "server",
        serverName: "server",
        recipe: launch,
        launchDigest: launch.digest,
        installationRecipe: installation,
        installationDigest: installation.digest,
        setupSchema: createSetupSchema({}),
      }],
    });
    expect(order).toEqual(["installation", "setup-workload"]);
    expect(sent).toContainEqual(expect.objectContaining({ kind: "edge.installation-status", state: "installed", installationDigest: installation.digest, launchDigest: launch.digest }));
    expect(sent).toContainEqual(expect.objectContaining({ kind: "edge.desired-state.ack", status: "applied" }));
    expect((await runtime.presenceSnapshot()).readiness[0]).toMatchObject({ status: "ready", installationDigest: installation.digest });
  });

  it("blocks setup while approval is required and rejects stale retry/removal controls", async () => {
    const { installation, launch } = recipes();
    const coordinator = {
      reconcile: vi.fn(async () => ({ deploymentId: "server", desiredVersion: 2, recipeDigest: installation.digest, launchDigest: launch.digest, state: "approval-required", readiness: "setup-required", observedAt: 10, reasonCode: "approval-required" })),
      remove: vi.fn(),
      recoverInterrupted: vi.fn(async () => []),
    };
    const supervisor = { reconcile: vi.fn(async () => []), shutdown: vi.fn(), handleRequest: vi.fn(), handleCancel: vi.fn(), blockDeployment: vi.fn() };
    const runtime = new EdgeAgentRuntime({ setup: { status: vi.fn(), clear: vi.fn() } as unknown as LocalSetupManager, supervisor: supervisor as unknown as EdgeWorkloadSupervisor, installation: coordinator as unknown as InstallationCoordinator });
    await runtime.connected({ protocolVersion: EDGE_PROTOCOL_VERSION, claims: { tenantId: "tenant", edgeNodeId: "node", connectionGeneration: 1 }, send: async () => undefined });
    await runtime.handle({ version: 3, kind: "edge.desired-state", tenantId: "tenant", edgeNodeId: "node", connectionGeneration: 1, desiredVersion: 2, deployments: [{ deploymentId: "server", serverName: "server", recipe: launch, launchDigest: launch.digest, installationRecipe: installation, installationDigest: installation.digest, setupSchema: createSetupSchema({}) }] });
    expect(supervisor.reconcile).toHaveBeenCalledWith([]);
    expect((await runtime.presenceSnapshot()).readiness[0]).toMatchObject({ status: "setup-required", reasonCode: "approval-required" });
    await expect(runtime.handle({ version: 3, kind: "edge.installation-control", tenantId: "tenant", edgeNodeId: "node", connectionGeneration: 1, deploymentId: "server", desiredVersion: 1, installationDigest: installation.digest, action: "retry", requestId: "stale" }))
      .rejects.toMatchObject({ code: "EDGE_PROTOCOL" });
  });
});
