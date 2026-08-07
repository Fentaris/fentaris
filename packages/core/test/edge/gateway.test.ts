import { describe, expect, it, vi } from "vitest";
import {
  EDGE_MCP_ENVELOPE_VERSION,
  EDGE_PROTOCOL_VERSION,
  EdgeTransport,
  EdgeWebSocketGateway,
  InMemoryEdgeCapabilityManifestStore,
  InMemoryEdgeChannelBroker,
  InMemoryEdgeConnectionStore,
  InMemoryEdgeDesiredStateStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
  InMemoryEdgeSetupStatusStore,
  compileLaunchRecipe,
  createSetupSchema,
  type EdgeDesiredStateMessage,
  type EdgeGatewayAuthenticator,
  type EdgeGatewaySocket,
  type EdgeProtocolMessage,
  type ProxyContext,
} from "../../src/index.js";

class TestSocket implements EdgeGatewaySocket {
  bufferedAmount = 0;
  readonly sent: EdgeProtocolMessage[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly messageHandlers = new Set<(frame: string) => void>();
  private readonly closeHandlers = new Set<() => void>();

  send(frame: string): void {
    this.sent.push(JSON.parse(frame) as EdgeProtocolMessage);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    for (const handler of [...this.closeHandlers]) handler();
  }

  onMessage(handler: (frame: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  receive(message: unknown): void {
    const frame = typeof message === "string" ? message : JSON.stringify(message);
    for (const handler of [...this.messageHandlers]) handler(frame);
  }
}

function hello(overrides: Record<string, unknown> = {}) {
  return {
    version: EDGE_PROTOCOL_VERSION,
    kind: "edge.hello",
    tenantId: "tenant-1",
    edgeNodeId: "node-1",
    supportedVersions: [EDGE_PROTOCOL_VERSION],
    nonce: "nonce",
    proof: "proof",
    ...overrides,
  };
}

async function fixture(options: { authorize?: ReturnType<typeof vi.fn>; now?: () => number } = {}) {
  const devices = new InMemoryEdgeDeviceRegistry();
  await devices.put({
    tenantId: "tenant-1",
    edgeNodeId: "node-1",
    credentialId: "credential-1",
    revoked: false,
    connectionGeneration: 0,
  });
  const connections = new InMemoryEdgeConnectionStore();
  const desired = new InMemoryEdgeDesiredStateStore();
  const setup = new InMemoryEdgeSetupStatusStore();
  const manifests = new InMemoryEdgeCapabilityManifestStore();
  const presence = new InMemoryEdgePresenceStore();
  const readiness = new InMemoryEdgeReadinessStore();
  const authenticator: EdgeGatewayAuthenticator = {
    authenticate: vi.fn(async (credential) => {
      if (credential !== "secret") throw new Error("bad credential");
      return { tenantId: "tenant-1", edgeNodeId: "node-1", credentialId: "credential-1" };
    }),
  };
  const gateway = new EdgeWebSocketGateway({
    authenticator,
    deviceRegistry: devices,
    connectionStore: connections,
    desiredStateStore: desired,
    setupStatusStore: setup,
    capabilityManifestStore: manifests,
    presenceStore: presence,
    readinessStore: readiness,
    ...(options.authorize ? { authorizer: { authorize: options.authorize } } : {}),
    ...(options.now ? { now: options.now } : {}),
    connectionId: () => "connection-1",
  });
  return { gateway, devices, connections, desired, setup, manifests, presence, readiness, authenticator };
}

async function connect(gateway: EdgeWebSocketGateway, socket = new TestSocket()) {
  const connected = gateway.accept(socket, "secret");
  socket.receive(hello());
  const record = await connected;
  return { socket, record };
}

function desiredState(version: number): EdgeDesiredStateMessage {
  return {
    version: EDGE_PROTOCOL_VERSION,
    kind: "edge.desired-state",
    tenantId: "tenant-1",
    edgeNodeId: "node-1",
    connectionGeneration: 0,
    desiredVersion: version,
    deployments: [{
      deploymentId: "fixture",
      serverName: "fixture",
      recipe: compileLaunchRecipe({ command: "fixture" }),
      setupSchema: createSetupSchema({}),
    }],
  };
}

describe("EdgeWebSocketGateway", () => {
  it("negotiates v1 for legacy agents and v3 for current agents", async () => {
    const legacy = await fixture();
    const legacySocket = new TestSocket();
    const legacyPending = legacy.gateway.accept(legacySocket, "secret");
    legacySocket.receive(hello({ version: 1, supportedVersions: [1] }));
    expect((await legacyPending).protocolVersion).toBe(1);
    expect(legacySocket.sent[0]).toMatchObject({ version: 1, protocolVersion: 1 });

    const current = await fixture();
    expect((await connect(current.gateway)).record.protocolVersion).toBe(3);
  });

  it("persists authenticated current-protocol facts, presence, readiness, and freshness", async () => {
    let now = 100;
    const { gateway, devices, presence, readiness } = await fixture({ now: () => now });
    const { socket } = await connect(gateway);
    socket.receive({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.presence",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 1,
      observed: { platform: "darwin", architecture: "arm64", agentVersion: "0.1.0", executionFeatures: ["mcp-stdio"], reportedAt: 99 },
      capacity: { maxConcurrent: 4, available: 3, reportedAt: 99 },
      load: { active: 1, queued: 0, utilization: 0.25, reportedAt: 99 },
      readiness: [{ deploymentId: "filesystem", status: "ready", observedAt: 99 }],
      reportedAt: 99,
    });
    await vi.waitFor(async () => {
      expect((await devices.get("tenant-1", "node-1"))?.observed?.platform).toBe("darwin");
      expect((await presence.get("tenant-1", "node-1"))?.credentialId).toBe("credential-1");
      expect((await readiness.get("tenant-1", "node-1", "filesystem"))?.connectionGeneration).toBe(1);
    });

    now = 120;
    socket.receive({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.heartbeat",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 1,
      sentAt: 119,
      capacity: { maxConcurrent: 4, available: 2, reportedAt: 119 },
      load: { active: 2, queued: 0, utilization: 0.5, reportedAt: 119 },
    });
    await vi.waitFor(async () => {
      expect((await presence.get("tenant-1", "node-1"))?.heartbeat.lastHeartbeatAt).toBe(120);
      expect((await presence.get("tenant-1", "node-1"))?.capacity?.available).toBe(2);
    });
  });
  it("authenticates hello, negotiates the protocol, tracks heartbeat, and reconciles desired-state acknowledgements", async () => {
    let now = 100;
    const authorize = vi.fn(async () => true);
    const { gateway, connections, desired } = await fixture({ authorize, now: () => now });
    const { socket, record } = await connect(gateway);
    expect(record.connectionGeneration).toBe(1);
    expect(socket.sent[0]).toMatchObject({
      kind: "edge.hello.ack",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 1,
    });

    expect(await gateway.publishDesiredState(desiredState(1))).toBe("published");
    expect(await gateway.publishDesiredState(desiredState(1))).toBe("unchanged");
    expect(socket.sent.filter((message) => message.kind === "edge.desired-state")).toHaveLength(1);

    now = 120;
    socket.receive({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.heartbeat",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 1,
      sentAt: 119,
    });
    await vi.waitFor(async () => {
      expect((await connections.get("tenant-1", "node-1"))?.lastHeartbeatAt).toBe(120);
    });
    socket.receive({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.desired-state.ack",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 1,
      desiredVersion: 1,
      status: "applied",
    });
    await vi.waitFor(async () => {
      expect(await desired.acknowledgedVersion("tenant-1", "node-1")).toBe(1);
    });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ direction: "outbound" }));
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ direction: "inbound" }));
  });

  it("bridges correlated MCP traffic and rejects forged routing fields", async () => {
    const authorize = vi.fn(async () => true);
    const { gateway } = await fixture({ authorize });
    const { socket, record } = await connect(gateway);
    const edgeTransport = new EdgeTransport({ channel: gateway });
    const context = {
      user: { id: "alice" },
      subject: { id: "alice", groups: [], hasGroup: () => false },
      auth: { authenticated: true, userId: "alice" },
      transport: { sessionId: "session-1" },
      execution: {
        kind: "edge",
        targetName: "personal",
        deploymentId: "fixture",
        edgeNodeId: "node-1",
        connectionGeneration: record.connectionGeneration,
        reused: false,
      },
    } as ProxyContext;
    const pending = edgeTransport.withProxyContext(context, () => edgeTransport.callTool({ name: "status" }));
    await vi.waitFor(() => expect(socket.sent.some((message) => message.kind === "mcp.request")).toBe(true));
    const request = socket.sent.find((message) => message.kind === "mcp.request");
    if (!request || request.kind !== "mcp.request") throw new Error("missing request");
    socket.receive({
      version: EDGE_MCP_ENVELOPE_VERSION,
      kind: "mcp.result",
      requestId: request.requestId,
      operation: request.operation,
      route: request.route,
      result: { content: [{ type: "text", text: "ok" }] },
    });
    await expect(pending).resolves.toMatchObject({ content: [{ text: "ok" }] });

    socket.receive({
      version: EDGE_MCP_ENVELOPE_VERSION,
      kind: "mcp.result",
      requestId: "forged",
      operation: "tools/call",
      route: { ...request.route, edgeNodeId: "node-2" },
      result: { content: [] },
    });
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(4403));
  });

  it("rejects replay, malformed frames, stale generations, unauthorized messages, and backpressure", async () => {
    const { gateway, desired } = await fixture();
    await desired.publish(desiredState(2));
    await expect(desired.publish(desiredState(1))).rejects.toMatchObject({ code: "EDGE_PROTOCOL" });
    await expect(desired.publish({ ...desiredState(2), deployments: [] })).rejects.toMatchObject({ code: "EDGE_PROTOCOL" });

    const malformedSocket = new TestSocket();
    const malformed = gateway.accept(malformedSocket, "secret");
    malformedSocket.receive("not-json");
    await expect(malformed).rejects.toBeInstanceOf(Error);
    expect(malformedSocket.closes.at(-1)?.code).toBe(4403);

    const first = await connect(gateway);
    const secondSocket = new TestSocket();
    const secondPending = gateway.accept(secondSocket, "secret");
    secondSocket.receive(hello());
    const second = await secondPending;
    expect(second.connectionGeneration).toBe(2);
    expect(first.socket.closes.at(-1)?.code).toBe(4409);

    const deniedFixture = await fixture({ authorize: vi.fn(async () => false) });
    const denied = await connect(deniedFixture.gateway);
    denied.socket.receive({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.heartbeat",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 1,
      sentAt: 1,
    });
    await vi.waitFor(() => expect(denied.socket.closes.at(-1)?.code).toBe(4403));

    secondSocket.bufferedAmount = 2_000_000;
    await expect(gateway.publishDesiredState(desiredState(3))).rejects.toMatchObject({ code: "EDGE_CAPACITY" });
  });

  it("expires dead connections and provides working single-process store/broker adapters", async () => {
    let now = 1_000;
    const { gateway, connections, setup, manifests } = await fixture({ now: () => now });
    const { socket } = await connect(gateway);
    now = 40_001;
    await expect(gateway.sweepExpiredConnections()).resolves.toHaveLength(1);
    expect(socket.closes.at(-1)?.code).toBe(4408);
    expect(await connections.get("tenant-1", "node-1")).toBeUndefined();

    await setup.put({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.setup-status",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 1,
      deploymentId: "fixture",
      recipeDigest: "sha256:recipe",
      setupSchemaVersion: 1,
      status: "ready",
    });
    expect((await setup.get("tenant-1", "node-1", "fixture"))?.status).toBe("ready");

    await manifests.put({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.capability-manifest",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 1,
      deploymentId: "fixture",
      recipeDigest: "sha256:recipe",
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      supportsCompletion: false,
    });
    expect((await manifests.get("tenant-1", "node-1", "fixture"))?.recipeDigest).toBe("sha256:recipe");

    const broker = new InMemoryEdgeChannelBroker();
    const seen: string[] = [];
    const unsubscribe = broker.subscribe("node-1", (message) => seen.push(message));
    await broker.publish("node-1", "hello");
    unsubscribe();
    await broker.publish("node-1", "ignored");
    expect(seen).toEqual(["hello"]);
  });

  it("terminates and removes the exact active connection generation", async () => {
    const { gateway, connections } = await fixture();
    const { socket, record } = await connect(gateway);
    await gateway.disconnect("tenant-1", "node-1", record.connectionGeneration + 1, "operator-disconnect");
    expect(socket.closes).toEqual([]);

    await gateway.disconnect("tenant-1", "node-1", record.connectionGeneration, "revoked");
    expect(socket.closes.at(-1)).toEqual({ code: 4403, reason: "revoked" });
    expect(await connections.get("tenant-1", "node-1")).toBeUndefined();
  });
});
