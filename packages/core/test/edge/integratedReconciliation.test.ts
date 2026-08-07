import { describe, expect, it, vi } from "vitest";
import {
  InMemoryEdgeDesiredStateStore,
  InMemoryEdgeDeviceRegistry,
  IntegratedEdgeReconciler,
  compileEdgeDeploymentCatalog,
  createSetupSchema,
  deriveEligibleEdgeDeployments,
  edge,
  runtime,
  type EdgeDesiredAssignmentSnapshot,
  type EdgeDesiredAssignmentStore,
} from "../../src/index.js";
import { McpServer } from "../../src/server/McpServer.js";
import { StdioTransport } from "../../src/transports/client/StdioTransport.js";

function declarations(args: string[] = []) {
  const schema = createSetupSchema({ apiKey: edge.secret({ required: true }) });
  const server = new McpServer({
    name: "github",
    transport: new StdioTransport({ command: "github-mcp", args, env: { API_KEY: runtime.secret("apiKey") } }),
  });
  const targets = new Map([["laptop", edge({ device: edge.namedDevice("alice-laptop") })]]);
  const bindings = [{ serverName: "github", scope: "user" as const, userId: "alice", targetName: "laptop" }];
  return { server, schema, targets, bindings };
}

describe("integrated Edge deployment planning and reconciliation", () => {
  it("compiles an immutable catalog and withholds assignments not proven for subject and device", async () => {
    const input = declarations();
    const catalog = compileEdgeDeploymentCatalog({
      servers: [input.server],
      targets: input.targets,
      bindings: input.bindings,
      setupSchemas: new Map([["github", input.schema]]),
    });
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0].deployment).toMatchObject({
      deploymentId: "github",
      setupSchemaVersion: input.schema.version,
      launchDigest: expect.stringMatching(/^sha256:/),
    });

    const eligible = await deriveEligibleEdgeDeployments({
      catalog,
      device: device("alice", "alice-laptop"),
      groupIds: [],
      tenantDevices: [listed("alice", "alice-laptop")],
    });
    expect(eligible.deployments.map((entry) => entry.deploymentId)).toEqual(["github"]);

    const denied = await deriveEligibleEdgeDeployments({
      catalog,
      device: device("bob", "alice-laptop"),
      groupIds: [],
      tenantDevices: [listed("bob", "alice-laptop")],
    });
    expect(denied.deployments).toEqual([]);
    expect(denied.withheld).toContainEqual({ serverName: "github", reason: "subject-not-authorized" });
  });

  it("serializes per-device reconciliation and increments only when effective content changes", async () => {
    const input = declarations();
    const devices = new InMemoryEdgeDeviceRegistry();
    await devices.put(device("alice", "alice-laptop"));
    const desired = new InMemoryEdgeDesiredStateStore();
    const assignments = new MemoryAssignments();
    const publish = vi.fn((state) => desired.publish(state));
    const catalog = compileEdgeDeploymentCatalog({
      servers: [input.server],
      targets: input.targets,
      bindings: input.bindings,
      setupSchemas: new Map([["github", input.schema]]),
    });
    const reconciler = new IntegratedEdgeReconciler({
      catalog,
      deviceRegistry: devices,
      desiredStateStore: desired,
      assignmentStore: assignments,
      publish,
    });

    await Promise.all([
      reconciler.enqueue({ tenantId: "default", edgeNodeId: "node-1", trigger: "connection" }),
      reconciler.enqueue({ tenantId: "default", edgeNodeId: "node-1", trigger: "inventory-change" }),
    ]);
    expect((await assignments.get("default", "node-1"))?.version).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);

    const changed = declarations(["--safe"]);
    const changedReconciler = new IntegratedEdgeReconciler({
      catalog: compileEdgeDeploymentCatalog({
        servers: [changed.server],
        targets: changed.targets,
        bindings: changed.bindings,
        setupSchemas: new Map([["github", changed.schema]]),
      }),
      deviceRegistry: devices,
      desiredStateStore: desired,
      assignmentStore: assignments,
      publish,
    });
    await changedReconciler.enqueue({ tenantId: "default", edgeNodeId: "node-1", trigger: "application-start" });
    expect((await assignments.get("default", "node-1"))?.version).toBe(2);
    expect((await desired.get("default", "node-1"))?.deployments[0].recipe.args).toEqual(["--safe"]);
  });

  it("uses a managed assignment resolver without broadening on adapter failure", async () => {
    const input = declarations();
    const poolTargets = new Map([["fleet", edge({ device: edge.pool("developers") })]]);
    const catalog = compileEdgeDeploymentCatalog({
      servers: [input.server],
      targets: poolTargets,
      bindings: [{ serverName: "github", scope: "user", userId: "alice", targetName: "fleet" }],
      setupSchemas: new Map([["github", input.schema]]),
    });
    const resolved = await deriveEligibleEdgeDeployments({
      catalog,
      device: device("alice", "alice-laptop"),
      groupIds: [],
      tenantDevices: [listed("alice", "alice-laptop")],
      assignmentResolver: { resolveEligibleDevices: async () => ["node-1"] },
    });
    expect(resolved.deployments).toHaveLength(1);

    const failed = await deriveEligibleEdgeDeployments({
      catalog,
      device: device("alice", "alice-laptop"),
      groupIds: [],
      tenantDevices: [listed("alice", "alice-laptop")],
      assignmentResolver: { resolveEligibleDevices: async () => { throw new Error("offline"); } },
    });
    expect(failed.deployments).toEqual([]);
    expect(failed.withheld).toContainEqual({ serverName: "github", reason: "managed-assignment-unavailable" });
  });

  it("hot-plugs a second user's device without mutating the startup catalog", async () => {
    const input = declarations();
    const catalog = compileEdgeDeploymentCatalog({
      servers: [input.server],
      targets: new Map([["personal", edge({ device: edge.userDefaultDevice() })]]),
      bindings: [{ serverName: "github", scope: "global", targetName: "personal" }],
      setupSchemas: new Map([["github", input.schema]]),
    });
    const devices = new InMemoryEdgeDeviceRegistry();
    const desired = new InMemoryEdgeDesiredStateStore();
    const assignments = new MemoryAssignments();
    const reconciler = new IntegratedEdgeReconciler({
      catalog,
      deviceRegistry: devices,
      desiredStateStore: desired,
      assignmentStore: assignments,
      publish: (state) => desired.publish(state),
    });

    await devices.put(deviceFor("node-alice", "alice", "Alice laptop"));
    await reconciler.enqueue({ tenantId: "default", edgeNodeId: "node-alice", trigger: "enrollment" });
    await devices.put(deviceFor("node-bob", "bob", "Bob laptop"));
    await reconciler.enqueue({ tenantId: "default", edgeNodeId: "node-bob", trigger: "enrollment" });

    expect(catalog.entries).toHaveLength(1);
    expect((await assignments.get("default", "node-alice"))?.deploymentIds).toEqual(["github"]);
    expect((await assignments.get("default", "node-bob"))?.deploymentIds).toEqual(["github"]);
  });
});

function device(subjectId: string, name: string) {
  return deviceFor("node-1", subjectId, name);
}

function deviceFor(edgeNodeId: string, subjectId: string, name: string) {
  return {
    tenantId: "default",
    edgeNodeId,
    credentialId: `credential-${edgeNodeId}`,
    subjectId,
    revoked: false,
    connectionGeneration: 1,
    user: { name, tags: [], updatedAt: 1 },
    managed: { aliases: [], pools: [], updatedAt: 1 },
  };
}

function listed(subjectId: string, name: string) {
  const { credentialId, ...record } = device(subjectId, name);
  void credentialId;
  return { ...record, inventorySchemaVersion: 1 as const, inventoryVersion: 1, deviceRef: { name, inventoryVersion: 1 } };
}

class MemoryAssignments implements EdgeDesiredAssignmentStore {
  private readonly values = new Map<string, EdgeDesiredAssignmentSnapshot>();
  async get(tenantId: string, edgeNodeId: string) {
    return this.values.get(`${tenantId}:${edgeNodeId}`);
  }
  async compareAndSwap(snapshot: EdgeDesiredAssignmentSnapshot, expectedVersion: number | undefined) {
    const key = `${snapshot.tenantId}:${snapshot.edgeNodeId}`;
    const current = this.values.get(key);
    if (current?.version !== expectedVersion) return "conflict" as const;
    if (current?.digest === snapshot.digest) return "unchanged" as const;
    this.values.set(key, snapshot);
    return "updated" as const;
  }
  async remove(tenantId: string, edgeNodeId: string) {
    this.values.delete(`${tenantId}:${edgeNodeId}`);
  }
}
