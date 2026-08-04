import { describe, expect, it } from "vitest";
import {
  EdgeInventoryService,
  InMemoryEdgeCapabilityManifestStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
} from "../../src/index.js";
import type { EdgeInventoryAuthorizer, EdgePresence } from "../../src/index.js";

const now = 1_000;

async function fixture() {
  const devices = new InMemoryEdgeDeviceRegistry();
  const presence = new InMemoryEdgePresenceStore();
  const readiness = new InMemoryEdgeReadinessStore();
  const capabilities = new InMemoryEdgeCapabilityManifestStore();
  const putDevice = async (input: {
    edgeNodeId: string;
    name: string;
    subjectId: string;
    platform?: string;
    tags?: string[];
    pools?: string[];
    load?: number;
    capacity?: number;
  }) => {
    await devices.put({
      tenantId: "tenant-a",
      edgeNodeId: input.edgeNodeId,
      credentialId: `credential-${input.edgeNodeId}`,
      subjectId: input.subjectId,
      revoked: false,
      connectionGeneration: 1,
      inventoryVersion: 1,
      user: { name: input.name, description: `${input.name} description`, tags: input.tags ?? [], updatedAt: now },
      observed: { platform: input.platform ?? "linux", architecture: "arm64", agentVersion: "0.1.0", executionFeatures: ["filesystem", "mcp-stdio"], reportedAt: now },
      managed: { aliases: [], pools: input.pools ?? [], updatedAt: now },
    });
    const dynamic: EdgePresence = {
      tenantId: "tenant-a",
      edgeNodeId: input.edgeNodeId,
      credentialId: `credential-${input.edgeNodeId}`,
      connectionId: `connection-${input.edgeNodeId}`,
      connectionGeneration: 1,
      protocolVersion: 2,
      connectedAt: now - 100,
      heartbeat: { lastHeartbeatAt: now, staleAfterMs: 100, evaluatedAt: now, fresh: true },
      status: "online",
      capacity: { maxConcurrent: 4, available: input.capacity ?? 2, reportedAt: now },
      load: { active: 1, queued: 0, utilization: input.load ?? 0.5, reportedAt: now },
    };
    await presence.put(dynamic);
    await readiness.put({ tenantId: "tenant-a", edgeNodeId: input.edgeNodeId, deploymentId: "filesystem", status: "ready", recipeVersion: 2, observedAt: now, expiresAt: now + 100 });
    await capabilities.put({
      version: 2,
      kind: "edge.capability-manifest",
      tenantId: "tenant-a",
      edgeNodeId: input.edgeNodeId,
      connectionGeneration: 1,
      deploymentId: "filesystem",
      recipeDigest: "sha256:filesystem",
      tools: [{ name: "read_file" }],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      supportsCompletion: false,
    });
  };
  await putDevice({ edgeNodeId: "node-alice-a", name: "Alice Laptop", subjectId: "alice", platform: "darwin", tags: ["development"], pools: ["personal"], load: 0.7, capacity: 2 });
  await putDevice({ edgeNodeId: "node-alice-b", name: "Alice Studio", subjectId: "alice", platform: "darwin", tags: ["development", "xcode"], pools: ["workers"], load: 0.2, capacity: 3 });
  await putDevice({ edgeNodeId: "node-bob", name: "Bob Secret", subjectId: "bob", platform: "linux", tags: ["private"], pools: ["secret"], load: 0.1, capacity: 4 });
  const authorizer: EdgeInventoryAuthorizer = {
    canAccessDevice: async (context, device) => device.subjectId === context.subjectId,
    canAccessDeployment: async (_context, _device, deploymentId) => deploymentId === "filesystem",
  };
  const service = new EdgeInventoryService({ devices, presence, readiness, capabilities, authorizer, now: () => now });
  return { service, devices, presence, readiness };
}

const alice = { tenantId: "tenant-a", subjectId: "alice" };

describe("EdgeInventoryService", () => {
  it("composes policy-filtered metadata, freshness, readiness, and capability summaries", async () => {
    const { service } = await fixture();
    const result = await service.list(alice, { platforms: ["darwin"], tags: ["development"], deploymentId: "filesystem", readiness: ["ready"] });
    expect(result.devices.map((device) => device.device.name)).toEqual(["Alice Laptop", "Alice Studio"]);
    expect(result.devices[0]).toMatchObject({
      heartbeatFresh: true,
      platform: "darwin",
      executionFeatures: ["filesystem", "mcp-stdio"],
      readiness: [{ deploymentId: "filesystem", status: "ready", toolCount: 1 }],
    });
    expect(JSON.stringify(result)).not.toContain("credential-");
    expect(JSON.stringify(result)).not.toContain("node-alice");
  });

  it("applies readiness filters without requiring a deployment filter", async () => {
    const { service, readiness } = await fixture();
    await readiness.put({
      tenantId: "tenant-a",
      edgeNodeId: "node-alice-b",
      deploymentId: "filesystem",
      status: "setup-required",
      observedAt: now,
      expiresAt: now + 100,
    });
    const result = await service.list(alice, { readiness: ["ready"] });
    expect(result.devices.map((device) => device.device.name)).toEqual(["Alice Laptop"]);
  });

  it("paginates only after authorization and does not expose hidden totals or cursors", async () => {
    const { service } = await fixture();
    const first = await service.list(alice, { limit: 1 });
    const second = await service.list(alice, { limit: 1, cursor: first.nextCursor });
    expect(first.devices).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    expect(second.devices).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect([...first.devices, ...second.devices].map((device) => device.device.name)).not.toContain("Bob Secret");
  });

  it("returns identical non-enumerating errors for hidden and missing devices", async () => {
    const { service } = await fixture();
    const capture = async (name: string) => {
      try {
        await service.get(alice, name);
        throw new Error("expected failure");
      } catch (error) {
        return { code: (error as { code?: string }).code, message: (error as Error).message, details: (error as { details?: unknown }).details };
      }
    };
    expect(await capture("Bob Secret")).toEqual(await capture("Does Not Exist"));
  });

  it("selects with hard requirements, ranked preferences, and deterministic tie-breaking", async () => {
    const { service } = await fixture();
    const selected = await service.select(alice, {
      requires: { tags: ["development"], features: ["filesystem"], platforms: ["darwin"], deploymentId: "filesystem" },
      prefer: ["lowest-load"],
      strategy: "name",
    });
    expect(selected.device.device.name).toBe("Alice Studio");
    expect(selected.explanation).toMatchObject({
      satisfiedRequirements: ["tags", "features", "platforms", "deploymentId"],
      appliedPreferences: ["lowest-load"],
      evaluatedCandidates: 2,
    });
    expect(JSON.stringify(selected.explanation)).not.toContain("Bob Secret");
  });

  it("returns safe unmet categories when no authorized device satisfies requirements", async () => {
    const { service } = await fixture();
    await expect(service.select(alice, { requires: { platforms: ["windows"], deploymentId: "filesystem" } }))
      .rejects.toMatchObject({
        code: "EDGE_UNAVAILABLE",
        details: { unmetRequirementCategories: ["platforms", "deploymentId"] },
      });
  });

  it("revalidates inventory version, authorization, freshness, capacity, readiness, and revocation at dispatch", async () => {
    const { service, devices, presence, readiness } = await fixture();
    const selected = await service.get(alice, "Alice Studio");
    await expect(service.revalidateForDispatch(alice, selected.device, "filesystem")).resolves.toMatchObject({
      edgeNodeId: "node-alice-b",
      connectionGeneration: 1,
    });

    await devices.updateInventory("tenant-a", "node-alice-b", { expectedInventoryVersion: 1, description: "changed", updatedAt: now + 1 });
    await expect(service.revalidateForDispatch(alice, selected.device, "filesystem"))
      .rejects.toMatchObject({ code: "EDGE_INVENTORY_CONFLICT" });
    const current = await service.get(alice, "Alice Studio");

    const dynamic = await presence.get("tenant-a", "node-alice-b");
    await presence.put({ ...dynamic!, capacity: { maxConcurrent: 4, available: 0, reportedAt: now } });
    await expect(service.revalidateForDispatch(alice, current.device, "filesystem"))
      .rejects.toMatchObject({ code: "EDGE_UNAVAILABLE" });
    await presence.put({ ...dynamic!, capacity: { maxConcurrent: 4, available: 1, reportedAt: now } });
    await readiness.put({ tenantId: "tenant-a", edgeNodeId: "node-alice-b", deploymentId: "filesystem", status: "setup-required", observedAt: now });
    await expect(service.revalidateForDispatch(alice, current.device, "filesystem"))
      .rejects.toMatchObject({ code: "EDGE_SETUP_REQUIRED" });
    await devices.revoke("tenant-a", "node-alice-b");
    await expect(service.revalidateForDispatch(alice, current.device, "filesystem"))
      .rejects.toMatchObject({ code: "EDGE_UNAUTHORIZED_TARGET" });
  });
});
