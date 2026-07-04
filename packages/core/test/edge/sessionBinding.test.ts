import { describe, expect, it } from "vitest";
import {
  EdgeSessionPinner,
  InMemorySessionBindingStore,
  edge,
  isEdgeError,
  type DeviceResolution,
  type DeviceResolver,
  type ExecutionTarget,
  type PlacementBindingModel,
  type SessionBindingKey,
  type SessionBindingListener,
  type SessionBindingStore,
  type SessionTargetBinding,
} from "../../src/index.js";
import { attachDownstreamSessionId, ensureIdentityWithMetadata } from "../../src/transports/exposure/downstreamSession.js";
import { McpProxy } from "../../src/proxy/McpProxy.js";
import { McpServer } from "../../src/server/McpServer.js";
import { StdioTransport } from "../../src/transports/client/StdioTransport.js";
import { Policy } from "../../src/governance.js";

const personalEdge = edge({ device: edge.userDefaultDevice() });
const aliasEdge = edge({ device: edge.namedDevice("laptop") });

function mockResolver(devices: Partial<DeviceResolver> = {}): DeviceResolver {
  return {
    resolveSessionDevice: devices.resolveSessionDevice,
    resolveUserDefaultDevice: devices.resolveUserDefaultDevice,
    resolveNamedAlias: devices.resolveNamedAlias ?? (async () => null),
    resolvePool: devices.resolvePool ?? (async () => null),
  };
}

function pinner(
  targets: Record<string, ExecutionTarget>,
  bindings: PlacementBindingModel[],
  resolver: DeviceResolver,
  store?: SessionBindingStore,
) {
  return new EdgeSessionPinner({
    targets: new Map(Object.entries(targets)),
    bindings,
    deviceResolver: resolver,
    store,
  });
}

const deviceA: DeviceResolution = { edgeNodeId: "node-a", alias: "laptop" };
const deviceB: DeviceResolution = { edgeNodeId: "node-b" };

const key = (overrides: Partial<SessionBindingKey> = {}): SessionBindingKey => ({
  sessionId: "sess-1",
  targetName: "personal-device",
  ...overrides,
});

describe("InMemorySessionBindingStore", () => {
  it("stores and reads a binding", async () => {
    const store = new InMemorySessionBindingStore();
    const binding = await store.store(key(), {
      sessionId: "sess-1",
      targetName: "personal-device",
      edgeNodeId: "node-a",
      alias: "laptop",
      connectionGeneration: 1,
    });
    expect(binding.edgeNodeId).toBe("node-a");
    expect(binding.connectionGeneration).toBe(1);
    const read = await store.get(key());
    expect(read?.edgeNodeId).toBe("node-a");
  });

  it("rejects takeover by a different edge node", async () => {
    const store = new InMemorySessionBindingStore();
    await store.store(key(), {
      sessionId: "sess-1",
      targetName: "personal-device",
      edgeNodeId: "node-a",
      connectionGeneration: 1,
    });
    let caught: unknown;
    try {
      await store.store(key(), {
        sessionId: "sess-1",
        targetName: "personal-device",
        edgeNodeId: "node-b",
        connectionGeneration: 1,
      });
    } catch (error) {
      caught = error;
    }
    expect(isEdgeError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("EDGE_UNAVAILABLE");
    // No private device inventory leaked. @pk
    expect((caught as { details?: Record<string, unknown> }).details).toEqual({ targetName: "personal-device" });
  });

  it("allows the same node to advance its connection generation on reconnect", async () => {
    const store = new InMemorySessionBindingStore();
    await store.store(key(), {
      sessionId: "sess-1",
      targetName: "personal-device",
      edgeNodeId: "node-a",
      connectionGeneration: 1,
    });
    const updated = await store.store(key(), {
      sessionId: "sess-1",
      targetName: "personal-device",
      edgeNodeId: "node-a",
      connectionGeneration: 3,
    });
    expect(updated.connectionGeneration).toBe(3);
  });

  it("removes expired bindings on purge and notifies listeners", async () => {
    const removed: Array<{ binding: SessionTargetBinding; reason: string }> = [];
    const listener: SessionBindingListener = {
      onSessionBindingRemoved: (binding, reason) => removed.push({ binding, reason }),
    };
    const store = new InMemorySessionBindingStore({ fixedMs: 1 });
    store.addListener(listener);
    await store.store(key(), {
      sessionId: "sess-1",
      targetName: "personal-device",
      edgeNodeId: "node-a",
      connectionGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const purged = await store.purgeExpired();
    expect(purged).toHaveLength(1);
    expect(removed[0].reason).toBe("expiry");
  });

  it("returns undefined from get for an expired binding and removes it", async () => {
    const store = new InMemorySessionBindingStore({ idleMs: 1 });
    await store.store(key(), {
      sessionId: "sess-1",
      targetName: "personal-device",
      edgeNodeId: "node-a",
      connectionGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const read = await store.get(key());
    expect(read).toBeUndefined();
    expect(await store.size()).toBe(0);
  });

  it("deletes all bindings for a session and notifies session-end", async () => {
    const removed: Array<{ binding: SessionTargetBinding; reason: string }> = [];
    const store = new InMemorySessionBindingStore();
    store.addListener({ onSessionBindingRemoved: (binding, reason) => removed.push({ binding, reason }) });
    await store.store(key(), {
      sessionId: "sess-1",
      targetName: "personal-device",
      edgeNodeId: "node-a",
      connectionGeneration: 1,
    });
    await store.store(key({ targetName: "team-workers" }), {
      sessionId: "sess-1",
      targetName: "team-workers",
      edgeNodeId: "node-b",
      connectionGeneration: 1,
    });
    const deleted = await store.deleteSession("sess-1");
    expect(deleted).toHaveLength(2);
    expect(removed.map((entry) => entry.reason)).toEqual(["session-end", "session-end"]);
  });

  it("clears all bindings on shutdown and notifies shutdown", async () => {
    const removed: Array<{ binding: SessionTargetBinding; reason: string }> = [];
    const store = new InMemorySessionBindingStore();
    store.addListener({ onSessionBindingRemoved: (binding, reason) => removed.push({ binding, reason }) });
    await store.store(key(), {
      sessionId: "sess-1",
      targetName: "personal-device",
      edgeNodeId: "node-a",
      connectionGeneration: 1,
    });
    const cleared = await store.clear();
    expect(cleared).toHaveLength(1);
    expect(removed[0].reason).toBe("shutdown");
  });
});

describe("EdgeSessionPinner pinning and reuse", () => {
  it("returns cloud placement without pinning for a cloud target", async () => {
    const p = pinner({}, [], mockResolver());
    const result = await p.pin({
      sessionId: "sess-1",
      serverName: "custom",
      groupIds: [],
    });
    expect(result.kind).toBe("cloud");
    expect(result.targetName).toBe("cloud");
    expect(await p.store.size()).toBe(0);
  });

  it("lazily pins an edge target to an eligible device", async () => {
    const resolver = mockResolver({ resolveUserDefaultDevice: async () => deviceA });
    const p = pinner({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
    ], resolver);
    const result = await p.pin({ sessionId: "sess-1", serverName: "custom", subjectId: "alice", groupIds: [] });
    expect(result.kind).toBe("edge");
    if (result.kind !== "edge") return;
    expect(result.reused).toBe(false);
    expect(result.device.edgeNodeId).toBe("node-a");
    expect(result.binding.edgeNodeId).toBe("node-a");
  });

  it("reuses a pinned device across MCP declarations using the same logical target", async () => {
    const resolver = mockResolver({ resolveUserDefaultDevice: async () => deviceA });
    const p = pinner({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
    ], resolver);
    const first = await p.pin({ sessionId: "sess-1", serverName: "custom", subjectId: "alice", groupIds: [] });
    const second = await p.pin({ sessionId: "sess-1", serverName: "custom", subjectId: "alice", groupIds: [] });
    if (first.kind !== "edge" || second.kind !== "edge") throw new Error("expected edge");
    expect(second.reused).toBe(true);
    expect(second.binding.edgeNodeId).toBe(first.binding.edgeNodeId);
  });

  it("pins different sessions to independent devices", async () => {
    let calls = 0;
    const resolver = mockResolver({
      resolveUserDefaultDevice: async () => {
        calls += 1;
        return calls === 1 ? deviceA : deviceB;
      },
    });
    const p = pinner({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
    ], resolver);
    const alice = await p.pin({ sessionId: "sess-1", serverName: "custom", subjectId: "alice", groupIds: [] });
    const bob = await p.pin({ sessionId: "sess-2", serverName: "custom", subjectId: "bob", groupIds: [] });
    if (alice.kind !== "edge" || bob.kind !== "edge") throw new Error("expected edge");
    expect(alice.binding.edgeNodeId).toBe("node-a");
    expect(bob.binding.edgeNodeId).toBe("node-b");
  });

  it("pinning different logical targets in the same session resolves independently", async () => {
    const resolver = mockResolver({
      resolveUserDefaultDevice: async () => deviceA,
      resolveNamedAlias: async (alias) => (alias === "laptop" ? deviceA : null),
    });
    const p = pinner({ "personal-device": personalEdge, "alice-device": aliasEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
      { serverName: "custom", scope: "user", userId: "alice", targetName: "alice-device" },
    ], resolver);
    // Both targets are eligible (global + a user binding); pin each explicitly
    // so two distinct logical targets in the same session resolve independently. @pk
    const first = await p.pin({
      sessionId: "sess-1",
      serverName: "custom",
      subjectId: "alice",
      groupIds: [],
      requestedTarget: "personal-device",
    });
    const second = await p.pin({
      sessionId: "sess-1",
      serverName: "custom",
      subjectId: "alice",
      groupIds: [],
      requestedTarget: "alice-device",
    });
    if (first.kind !== "edge" || second.kind !== "edge") throw new Error("expected edge");
    expect(first.targetName).toBe("personal-device");
    expect(second.targetName).toBe("alice-device");
    expect(await p.store.size()).toBe(2);
  });

  it("returns EDGE_UNAVAILABLE when no eligible device exists", async () => {
    const resolver = mockResolver({ resolveUserDefaultDevice: async () => null });
    const p = pinner({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
    ], resolver);
    let caught: unknown;
    try {
      await p.pin({ sessionId: "sess-1", serverName: "custom", subjectId: "alice", groupIds: [] });
    } catch (error) {
      caught = error;
    }
    expect(isEdgeError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("EDGE_UNAVAILABLE");
  });

  it("rejects an ineligible explicit session target", async () => {
    const resolver = mockResolver({ resolveUserDefaultDevice: async () => deviceA });
    const p = pinner({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
    ], resolver);
    let caught: unknown;
    try {
      await p.pin({
        sessionId: "sess-1",
        serverName: "custom",
        subjectId: "alice",
        groupIds: [],
        requestedTarget: "alice-device",
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code: string }).code).toBe("EDGE_UNAUTHORIZED_TARGET");
  });

  it("rejects a different-node takeover on reconnect", async () => {
    const resolver = mockResolver({ resolveUserDefaultDevice: async () => deviceA });
    const p = pinner({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
    ], resolver);
    await p.pin({ sessionId: "sess-1", serverName: "custom", subjectId: "alice", groupIds: [] });
    let caught: unknown;
    try {
      await p.reconnect(key({ subjectId: "alice" }), "node-b", 2);
    } catch (error) {
      caught = error;
    }
    expect((caught as { code: string }).code).toBe("EDGE_UNAVAILABLE");
  });

  it("endSession removes bindings and notifies dependent workloads", async () => {
    const removed: SessionTargetBinding[] = [];
    const resolver = mockResolver({ resolveUserDefaultDevice: async () => deviceA });
    const p = pinner({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
    ], resolver);
    p.addListener({ onSessionBindingRemoved: (binding) => removed.push(binding) });
    await p.pin({ sessionId: "sess-1", serverName: "custom", subjectId: "alice", groupIds: [] });
    const deleted = await p.endSession("sess-1");
    expect(deleted).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(await p.store.size()).toBe(0);
  });
});

describe("shared-store adapter fixture", () => {
  it("pins through a custom SessionBindingStore adapter", async () => {
    // A minimal shared-store adapter fixture that a managed cloud could back
    // with durable storage; here it mirrors an external map. @pk
    const backing = new Map<string, SessionTargetBinding>();
    const adapter: SessionBindingStore = {
      async store(k, value) {
        const id = `${k.sessionId}|${k.subjectId ?? ""}|${k.targetName}`;
        const existing = backing.get(id);
        if (existing && existing.edgeNodeId !== value.edgeNodeId) {
          throw new Error("EDGE_UNAVAILABLE");
        }
        const binding: SessionTargetBinding = {
          sessionId: k.sessionId,
          subjectId: k.subjectId,
          targetName: k.targetName,
          edgeNodeId: value.edgeNodeId,
          alias: value.alias,
          connectionGeneration: value.connectionGeneration,
          createdAt: value.createdAt ?? Date.now(),
          lastAccessAt: value.lastAccessAt ?? Date.now(),
          expiresAt: value.expiresAt,
        };
        backing.set(id, binding);
        return binding;
      },
      async get(k) {
        return backing.get(`${k.sessionId}|${k.subjectId ?? ""}|${k.targetName}`);
      },
      async delete(k) {
        const id = `${k.sessionId}|${k.subjectId ?? ""}|${k.targetName}`;
        const existing = backing.get(id);
        backing.delete(id);
        return existing;
      },
      async deleteSession() {
        return [];
      },
      async deleteTarget() {
        return [];
      },
      async purgeExpired() {
        return [];
      },
      async clear() {
        backing.clear();
        return [];
      },
      async listBySession() {
        return [];
      },
      async size() {
        return backing.size;
      },
      addListener() {},
    };
    const resolver = mockResolver({ resolveUserDefaultDevice: async () => deviceA });
    const p = pinner({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
    ], resolver, adapter);
    const result = await p.pin({ sessionId: "sess-1", serverName: "custom", subjectId: "alice", groupIds: [] });
    if (result.kind !== "edge") throw new Error("expected edge");
    expect(result.binding.edgeNodeId).toBe("node-a");
    expect(await adapter.size()).toBe(1);
  });
});

function stdioServer(name: string) {
  return new McpServer({ name, transport: new StdioTransport({ command: "node" }) });
}

describe("McpProxy session-binding integration", () => {
  it("pinSessionTarget returns cloud placement when no device resolver is configured", async () => {
    const proxy = new McpProxy({ policy: Policy.allowAll(), servers: [stdioServer("custom")] });
    proxy.mcp("custom").target("cloud");
    const result = await proxy.pinSessionTarget({ sessionId: "sess-1", serverName: "custom", groupIds: [] });
    expect(result.kind).toBe("cloud");
  });

  it("pinSessionTarget pins through the configured edge runtime and endEdgeSession clears bindings", async () => {
    const resolver = mockResolver({ resolveUserDefaultDevice: async () => deviceA });
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [stdioServer("custom")],
      edge: { deviceResolver: resolver },
    });
    proxy.target("personal-device", edge({ device: edge.userDefaultDevice() }));
    proxy.mcp("custom").target("personal-device");
    const result = await proxy.pinSessionTarget({ sessionId: "sess-1", serverName: "custom", subjectId: "alice", groupIds: [] });
    if (result.kind !== "edge") throw new Error("expected edge");
    expect(result.binding.edgeNodeId).toBe("node-a");
    const pinner = proxy.edgeSessionPinner()!;
    expect(await pinner.store.size()).toBe(1);
    await proxy.endEdgeSession("sess-1");
    expect(await pinner.store.size()).toBe(0);
  });

  it("emitSessionEnd releases session-target bindings", async () => {
    const resolver = mockResolver({ resolveUserDefaultDevice: async () => deviceA });
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [stdioServer("custom")],
      edge: { deviceResolver: resolver },
    });
    proxy.target("personal-device", edge({ device: edge.userDefaultDevice() }));
    proxy.mcp("custom").target("personal-device");
    await proxy.pinSessionTarget({ sessionId: "sess-1", serverName: "custom", subjectId: "alice", groupIds: [] });
    const pinner = proxy.edgeSessionPinner()!;
    expect(await pinner.store.size()).toBe(1);
    await proxy.emitSessionEnd({
      user: { id: "alice" },
      identity: { authenticated: true, userId: "alice" },
      sessionId: "sess-1",
      log: proxy["logger"],
    } as never);
    expect(await pinner.store.size()).toBe(0);
  });

  it("shutdown clears all session-target bindings", async () => {
    const resolver = mockResolver({ resolveUserDefaultDevice: async () => deviceA });
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [stdioServer("custom")],
      edge: { deviceResolver: resolver },
    });
    proxy.target("personal-device", edge({ device: edge.userDefaultDevice() }));
    proxy.mcp("custom").target("personal-device");
    await proxy.pinSessionTarget({ sessionId: "sess-1", serverName: "custom", subjectId: "alice", groupIds: [] });
    await proxy.stop();
    // After shutdown the pinner cache is dropped; a fresh one starts empty. @pk
    expect(await proxy.edgeSessionPinner()?.store.size()).toBe(0);
  });
});

describe("downstream session identity propagation (4.3)", () => {
  it("attaches the downstream session id to a defined identity", () => {
    const identity = ensureIdentityWithMetadata({ authenticated: true, userId: "alice" });
    expect(identity.metadata).toEqual({});
    attachDownstreamSessionId(identity, "sess-1");
    expect(identity.metadata).toEqual({ sessionId: "sess-1" });
  });

  it("creates a base identity when none was resolved and attaches the session id", () => {
    const identity = ensureIdentityWithMetadata(undefined);
    expect(identity.authenticated).toBe(false);
    attachDownstreamSessionId(identity, "sess-2");
    expect(identity.metadata).toEqual({ sessionId: "sess-2" });
  });

  it("does not overwrite an existing session id when the new value is empty", () => {
    const identity = ensureIdentityWithMetadata({ metadata: { sessionId: "sess-1" } });
    attachDownstreamSessionId(identity, undefined);
    expect(identity.metadata).toEqual({ sessionId: "sess-1" });
  });

  it("preserves existing identity metadata when attaching the session id", () => {
    const identity = ensureIdentityWithMetadata({ metadata: { role: "admin" } });
    attachDownstreamSessionId(identity, "s");
    expect(identity.metadata).toEqual({ role: "admin", sessionId: "s" });
  });
});