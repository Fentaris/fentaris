import { describe, expect, it, vi } from "vitest";
import {
  EDGE_MCP_ENVELOPE_VERSION,
  EDGE_PROTOCOL_VERSION,
  compileLaunchRecipe,
  createSetupSchema,
  type EdgeAgentMessage,
  type EdgeMcpRequestEnvelope,
} from "@fentaris/core";
import {
  EdgeAgentRuntime,
  EdgeWorkloadSupervisor,
  LocalSetupManager,
  type CredentialStore,
  type EdgeWorkloadFactory,
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
  values = new Map<string, string>();
  async get(name: string) { return this.values.get(name); }
  async set(name: string, value: string) { this.values.set(name, value); }
  async delete(name: string) { this.values.delete(name); }
}

describe("EdgeAgentRuntime", () => {
  it("reconciles desired state and bridges MCP traffic over the persistent connection", async () => {
    const provider: LocalSetupProvider = {
      approveWorkload: async () => true,
      collectField: async () => ({ approved: true }),
    };
    const setup = new LocalSetupManager({
      store: new MemoryStore(),
      credentials: new MemoryCredentials(),
      provider,
    });
    const close = vi.fn(async () => undefined);
    const factory: EdgeWorkloadFactory = {
      start: vi.fn(async () => ({
        client: {
          request: async () => ({ content: [{ type: "text", text: "edge-ok" }] }),
          capabilityManifest: async () => ({
            tools: [{ name: "status" }],
            resources: [],
            resourceTemplates: [],
            prompts: [],
            supportsCompletion: false,
          }),
        },
        stopGracefully: close,
        forceKill: close,
      })),
    };
    const sent: EdgeAgentMessage[] = [];
    const runtimeRef: { current?: EdgeAgentRuntime } = {};
    const supervisor = new EdgeWorkloadSupervisor({
      setup,
      factory,
      reportCapabilityManifest: (deploymentId, recipeDigest, manifest) =>
        runtimeRef.current!.reportCapabilityManifest(deploymentId, recipeDigest, manifest),
    });
    const runtime = new EdgeAgentRuntime({ setup, supervisor });
    runtimeRef.current = runtime;
    runtime.connected({
      claims: {
        tenantId: "tenant-1",
        edgeNodeId: "node-1",
        connectionGeneration: 4,
      },
      send: async (message) => { sent.push(message); },
    });
    const schema = createSetupSchema({});
    const recipe = compileLaunchRecipe({ command: "fixture" }, schema);
    await runtime.handle({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.desired-state",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 4,
      desiredVersion: 2,
      deployments: [{
        deploymentId: "fixture",
        serverName: "fixture",
        recipe,
        setupSchema: schema,
      }],
    });
    expect(sent).toEqual([
      expect.objectContaining({ kind: "edge.setup-status", status: "ready" }),
      expect.objectContaining({ kind: "edge.desired-state.ack", status: "applied", desiredVersion: 2 }),
    ]);
    expect(await runtime.summary()).toEqual({
      desiredDeployments: 1,
      readyDeployments: 1,
      blockedDeployments: 0,
    });

    const request: EdgeMcpRequestEnvelope = {
      version: EDGE_MCP_ENVELOPE_VERSION,
      kind: "mcp.request",
      requestId: "request-1",
      operation: "tools/call",
      route: {
        edgeNodeId: "node-1",
        connectionGeneration: 4,
        deploymentId: "fixture",
        downstreamSessionId: "session-1",
        targetName: "personal",
      },
      deadline: Date.now() + 10_000,
      params: { name: "status" },
    };
    await runtime.handle(request);
    expect(sent).toContainEqual(expect.objectContaining({
      kind: "edge.capability-manifest",
      deploymentId: "fixture",
      tools: [{ name: "status" }],
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      kind: "mcp.result",
      requestId: "request-1",
      result: { content: [{ type: "text", text: "edge-ok" }] },
    }));

    await expect(runtime.handle({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.desired-state",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 4,
      desiredVersion: 3,
      deployments: [{
        deploymentId: "fixture",
        serverName: "fixture",
        recipe: { ...recipe, digest: "sha256:tampered" },
        setupSchema: schema,
      }],
    })).rejects.toMatchObject({ code: "EDGE_PROTOCOL" });
    await expect(runtime.handle({
      ...request,
      route: { ...request.route, connectionGeneration: 3 },
    })).rejects.toMatchObject({ code: "EDGE_PROTOCOL" });
    await runtime.disconnected();
    expect(close).toHaveBeenCalledOnce();
  });
});
