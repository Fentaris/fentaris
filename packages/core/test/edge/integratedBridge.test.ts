import { describe, expect, it, vi } from "vitest";
import {
  EdgeCapabilityCache,
  InMemoryEdgeCapabilityManifestStore,
  InMemoryEdgeDesiredStateStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
  InMemoryEdgeSetupStatusStore,
  IntegratedEdgeGatewayBridge,
  compileLaunchRecipe,
  createSetupSchema,
  edge,
  type EdgeDesiredStateMessage,
  type EdgeGatewayAuthorization,
} from "../../src/index.js";

describe("integrated Edge gateway bridge", () => {
  it("publishes device-provenanced capabilities and gates dispatch on current state", async () => {
    const devices = new InMemoryEdgeDeviceRegistry();
    const desired = new InMemoryEdgeDesiredStateStore();
    const setup = new InMemoryEdgeSetupStatusStore();
    const manifests = new InMemoryEdgeCapabilityManifestStore();
    const presence = new InMemoryEdgePresenceStore();
    const readiness = new InMemoryEdgeReadinessStore();
    const cache = new EdgeCapabilityCache();
    const reconcile = vi.fn(async () => undefined);
    const bridge = new IntegratedEdgeGatewayBridge({
      devices,
      desired,
      setup,
      manifests,
      presence,
      readiness,
      capabilityCache: cache,
      reconciler: { enqueue: reconcile } as never,
    });
    const schema = createSetupSchema({ apiKey: edge.secret() });
    const recipe = compileLaunchRecipe({ command: "github-mcp" }, schema);
    const state: EdgeDesiredStateMessage = {
      version: 3,
      kind: "edge.desired-state",
      tenantId: "default",
      edgeNodeId: "node-1",
      connectionGeneration: 2,
      desiredVersion: 4,
      deployments: [{
        deploymentId: "github",
        serverName: "github",
        recipe,
        launchDigest: recipe.digest,
        setupSchema: schema,
        setupSchemaVersion: schema.version,
      }],
    };
    await devices.put({
      tenantId: "default",
      edgeNodeId: "node-1",
      credentialId: "credential-1",
      subjectId: "alice",
      revoked: false,
      connectionGeneration: 2,
    });
    await desired.publish(state);
    await presence.put({
      tenantId: "default",
      edgeNodeId: "node-1",
      credentialId: "credential-1",
      connectionId: "connection-1",
      connectionGeneration: 2,
      protocolVersion: 3,
      connectedAt: 1,
      heartbeat: { lastHeartbeatAt: 2, staleAfterMs: 30_000, evaluatedAt: 2, fresh: true },
      status: "online",
    });
    await readiness.put({
      tenantId: "default",
      edgeNodeId: "node-1",
      credentialId: "credential-1",
      connectionGeneration: 2,
      deploymentId: "github",
      status: "ready",
      desiredVersion: 4,
      launchDigest: recipe.digest,
      observedAt: 2,
    });
    const manifest = {
      version: 3 as const,
      kind: "edge.capability-manifest" as const,
      tenantId: "default",
      edgeNodeId: "node-1",
      connectionGeneration: 2,
      deploymentId: "github",
      recipeDigest: recipe.digest,
      tools: [{ name: "create_issue" }],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      supportsCompletion: false,
    };
    await manifests.put(manifest);
    await bridge.manifestChanged(manifest);
    expect((await cache.state("default", "github")).manifest).toMatchObject({
      edgeNodeId: "node-1",
      connectionGeneration: 2,
    });

    const authorization: EdgeGatewayAuthorization = {
      direction: "outbound",
      identity: { tenantId: "default", edgeNodeId: "node-1", credentialId: "credential-1" },
      connection: {
        tenantId: "default",
        edgeNodeId: "node-1",
        connectionId: "connection-1",
        connectionGeneration: 2,
        protocolVersion: 3,
        connectedAt: 1,
        lastHeartbeatAt: 2,
      },
      message: {
        version: 1,
        kind: "mcp.request",
        requestId: "request-1",
        operation: "tools/call",
        route: {
          edgeNodeId: "node-1",
          connectionGeneration: 2,
          deploymentId: "github",
          downstreamSessionId: "session-1",
          subjectId: "alice",
          targetName: "laptop",
        },
        deadline: Date.now() + 1_000,
        params: { name: "create_issue", arguments: {} },
      },
    };
    await expect(bridge.authorize(authorization)).resolves.toBe(true);
    await expect(bridge.authorize({
      ...authorization,
      message: {
        ...authorization.message,
        route: { ...authorization.message.route, connectionGeneration: 1 },
      } as typeof authorization.message,
    })).resolves.toBe(false);
    await expect(bridge.authorize({
      ...authorization,
      message: {
        ...authorization.message,
        operation: "tools/call",
        params: { name: "missing_tool", arguments: {} },
      } as typeof authorization.message,
    })).resolves.toBe(false);
    await expect(bridge.authorize({
      ...authorization,
      message: {
        ...authorization.message,
        operation: "experimental/unknown",
        params: {},
      } as typeof authorization.message,
    })).resolves.toBe(false);
    await expect(bridge.authorize({
      ...authorization,
      message: {
        ...authorization.message,
        operation: "resources/read",
        params: { uri: "file:///secret" },
      } as typeof authorization.message,
    })).resolves.toBe(false);

    await manifests.put({
      ...manifest,
      resourceTemplates: [{ name: "files", uriTemplate: "file:///{path}" }],
      resources: [{ name: "readme", uri: "file:///readme" }],
    });
    await expect(bridge.authorize({
      ...authorization,
      message: {
        ...authorization.message,
        operation: "resources/read",
        params: { uri: "file:///readme" },
      } as typeof authorization.message,
    })).resolves.toBe(true);
    await expect(bridge.authorize({
      ...authorization,
      message: {
        ...authorization.message,
        operation: "resources/read",
        params: { uri: "file:///docs/a.md" },
      } as typeof authorization.message,
    })).resolves.toBe(true);
    await expect(bridge.authorize({
      ...authorization,
      message: {
        ...authorization.message,
        operation: "resources/read",
        params: { uri: "https://evil.example/x" },
      } as typeof authorization.message,
    })).resolves.toBe(false);

    await devices.put({
      tenantId: "default",
      edgeNodeId: "node-1",
      credentialId: "credential-1",
      subjectId: "alice",
      revoked: true,
      connectionGeneration: 2,
    });
    await expect(bridge.authorize(authorization)).resolves.toBe(false);
  });

  it("invalidates discovery availability on disconnect and triggers reconciliation on reports", async () => {
    const desired = new InMemoryEdgeDesiredStateStore();
    const cache = new EdgeCapabilityCache();
    const reconciler = { enqueue: vi.fn(async () => undefined) };
    const bridge = new IntegratedEdgeGatewayBridge({
      devices: new InMemoryEdgeDeviceRegistry(),
      desired,
      setup: new InMemoryEdgeSetupStatusStore(),
      manifests: new InMemoryEdgeCapabilityManifestStore(),
      presence: new InMemoryEdgePresenceStore(),
      readiness: new InMemoryEdgeReadinessStore(),
      capabilityCache: cache,
      reconciler: reconciler as never,
    });
    await bridge.connected({
      tenantId: "default",
      edgeNodeId: "node-1",
      connectionId: "connection-1",
      connectionGeneration: 1,
      protocolVersion: 3,
      connectedAt: 1,
      lastHeartbeatAt: 1,
    });
    expect(reconciler.enqueue).toHaveBeenCalledWith(expect.objectContaining({ trigger: "connection" }));
    await bridge.disconnected({
      tenantId: "default",
      edgeNodeId: "node-1",
      connectionId: "connection-1",
      connectionGeneration: 1,
      protocolVersion: 3,
      connectedAt: 1,
      lastHeartbeatAt: 1,
    });
  });
});
