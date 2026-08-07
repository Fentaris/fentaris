import { describe, expect, it } from "vitest";
import {
  EDGE_PROTOCOL_VERSION,
  InMemoryEdgeInstallationStatusStore,
  InMemoryEdgeReadinessStore,
  adaptDesiredStateForEdgeProtocol,
  compileLaunchRecipe,
  createSetupSchema,
  edge,
  parseEdgeProtocolMessage,
  selectHighestMutualEdgeProtocolVersion,
  type EdgeDesiredStateMessage,
  type EdgeInstallationStatusMessage,
  type InstallationDigest,
} from "../../src/index.js";

const digest = (character: string): InstallationDigest => `sha256:${character.repeat(64)}`;

function desired(): EdgeDesiredStateMessage {
  const recipe = edge.install.nodePackage({ package: "server", version: "1.2.3", integrity: digest("1") }, {
    verification: [{ kind: "executable", target: "bin/server" }],
    outputs: [{ name: "server", kind: "executable", path: "bin/server" }],
  });
  const launch = compileLaunchRecipe({ command: "server" });
  return {
    version: 3,
    kind: "edge.desired-state",
    tenantId: "tenant-1",
    edgeNodeId: "node-1",
    connectionGeneration: 1,
    desiredVersion: 4,
    deployments: [{
      deploymentId: "server",
      serverName: "server",
      recipe: launch,
      launchDigest: launch.digest,
      installationRecipe: recipe,
      installationDigest: recipe.digest,
      setupSchema: createSetupSchema({}),
    }],
  };
}

describe("Edge installation protocol v3", () => {
  it("negotiates v3 and retains launch-only compatibility", () => {
    expect(EDGE_PROTOCOL_VERSION).toBe(3);
    expect(selectHighestMutualEdgeProtocolVersion([1, 2, 3])).toBe(3);
    expect(selectHighestMutualEdgeProtocolVersion([1, 2])).toBe(2);
  });

  it("validates correlated installation and launch digests", () => {
    expect(parseEdgeProtocolMessage(JSON.stringify(desired()))).toMatchObject({ desiredVersion: 4 });
    const mismatched = structuredClone(desired());
    mismatched.deployments[0]!.installationDigest = digest("9");
    expect(() => parseEdgeProtocolMessage(JSON.stringify(mismatched))).toThrow(/correlation mismatch/);
  });

  it("omits installation details and reports upgrade-required to older agents", () => {
    const legacy = adaptDesiredStateForEdgeProtocol(desired(), 2);
    expect(legacy.version).toBe(2);
    expect(legacy.deployments[0]).toMatchObject({ requiresAgentUpgrade: true });
    expect(legacy.deployments[0]).not.toHaveProperty("installationRecipe");
    expect(legacy.deployments[0]).not.toHaveProperty("installationDigest");
  });

  it("parses bounded lifecycle, approval, retry, and removal messages", () => {
    const common = { version: 3, tenantId: "tenant-1", edgeNodeId: "node-1", connectionGeneration: 2 } as const;
    expect(parseEdgeProtocolMessage(JSON.stringify({
      ...common,
      kind: "edge.installation-status",
      deploymentId: "server",
      desiredVersion: 4,
      installationDigest: digest("1"),
      launchDigest: digest("2"),
      state: "approval-required",
      retryable: false,
      observedAt: 10,
      approvalRequired: { approvalDigest: digest("3"), sourceKind: "git", cleanup: false },
    }))).toMatchObject({ kind: "edge.installation-status" });
    for (const action of ["retry", "remove"] as const) {
      expect(parseEdgeProtocolMessage(JSON.stringify({
        ...common,
        kind: "edge.installation-control",
        deploymentId: "server",
        desiredVersion: 4,
        installationDigest: digest("1"),
        action,
        requestId: `request-${action}`,
      }))).toMatchObject({ action });
    }
  });

  it("rejects stale lifecycle and readiness correlation", async () => {
    const statuses = new InMemoryEdgeInstallationStatusStore();
    const base: EdgeInstallationStatusMessage = {
      version: 3,
      kind: "edge.installation-status",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 2,
      deploymentId: "server",
      desiredVersion: 4,
      installationDigest: digest("1"),
      launchDigest: digest("2"),
      state: "installing",
      retryable: false,
      observedAt: 10,
    };
    await statuses.put(base);
    await expect(statuses.put({ ...base, desiredVersion: 3, observedAt: 11 })).rejects.toThrow(/stale/);
    await expect(statuses.put({ ...base, installationDigest: digest("9"), observedAt: 11 })).rejects.toThrow(/mismatched/);

    const readiness = new InMemoryEdgeReadinessStore();
    await readiness.put({ tenantId: "tenant-1", edgeNodeId: "node-1", deploymentId: "server", connectionGeneration: 2, desiredVersion: 4, installationDigest: digest("1"), launchDigest: digest("2"), status: "setup-required", observedAt: 10 });
    await expect(readiness.put({ tenantId: "tenant-1", edgeNodeId: "node-1", deploymentId: "server", connectionGeneration: 1, desiredVersion: 4, installationDigest: digest("1"), launchDigest: digest("2"), status: "ready", observedAt: 11 })).rejects.toThrow(/stale/);
  });
});
