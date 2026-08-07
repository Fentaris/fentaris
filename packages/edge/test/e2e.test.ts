import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EDGE_PROTOCOL_VERSION,
  EdgeCapabilityCache,
  EdgeTransport,
  EdgeWebSocketGateway,
  InMemoryEdgeCapabilityManifestStore,
  InMemoryEdgeConnectionStore,
  InMemoryEdgeDesiredStateStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgeSetupStatusStore,
  McpProxy,
  McpServer,
  compileLaunchRecipe,
  createSetupSchema,
  edge,
  runtime,
  type EdgeGatewaySocket,
  type EdgeProtocolMessage,
  type FentarisTransport,
} from "@fentaris/core";
import {
  EdgeWorkloadSupervisor,
  LocalSetupManager,
  type CredentialStore,
  type JsonStore,
  type LocalGrantDatabase,
  type LocalSetupProvider,
} from "../src/index.js";
import { FilesystemFixtureMcp } from "./fixtures/filesystemMcp.js";

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

class LoopbackSocket implements EdgeGatewaySocket {
  bufferedAmount = 0;
  private messages = new Set<(frame: string) => void>();
  private closes = new Set<() => void>();
  onServerMessage?: (message: EdgeProtocolMessage) => void | Promise<void>;
  send(frame: string) {
    const message = JSON.parse(frame) as EdgeProtocolMessage;
    void this.onServerMessage?.(message);
  }
  close() { for (const handler of [...this.closes]) handler(); }
  onMessage(handler: (frame: string) => void) {
    this.messages.add(handler);
    return () => this.messages.delete(handler);
  }
  onClose(handler: () => void) {
    this.closes.add(handler);
    return () => this.closes.delete(handler);
  }
  receive(message: unknown) {
    const frame = JSON.stringify(message);
    for (const handler of [...this.messages]) handler(frame);
  }
}

class CatalogTransport implements FentarisTransport {
  async listTools() { return { tools: [] }; }
  async callTool() { return { content: [] }; }
  async close() {}
}

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function deviceWorkspace(text: string) {
  const created = await mkdtemp(path.join(tmpdir(), "fentaris-e2e-"));
  temporary.push(created);
  const root = await realpath(created);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "note.txt"), text);
  return root;
}

describe("edge execution end to end", () => {
  it("routes two users through one MCP namespace to isolated approved filesystems", async () => {
    const aliceRoot = await deviceWorkspace("alice-private");
    const bobRoot = await deviceWorkspace("bob-private");
    const devices = new InMemoryEdgeDeviceRegistry();
    await devices.put({ tenantId: "tenant-1", edgeNodeId: "node-alice", credentialId: "cred-alice", revoked: false, connectionGeneration: 0 });
    await devices.put({ tenantId: "tenant-1", edgeNodeId: "node-bob", credentialId: "cred-bob", revoked: false, connectionGeneration: 0 });
    const gateway = new EdgeWebSocketGateway({
      authenticator: {
        authenticate: async (credential, hello) => ({
          tenantId: "tenant-1",
          edgeNodeId: hello.edgeNodeId,
          credentialId: credential,
        }),
      },
      deviceRegistry: devices,
      connectionStore: new InMemoryEdgeConnectionStore(),
      desiredStateStore: new InMemoryEdgeDesiredStateStore(),
      setupStatusStore: new InMemoryEdgeSetupStatusStore(),
      capabilityManifestStore: new InMemoryEdgeCapabilityManifestStore(),
      // Explicit allow-all: gateway MCP dispatch is fail-closed without an authorizer.
      authorizer: { authorize: async () => true },
    });
    const schema = createSetupSchema({ workspace: edge.folder({ access: "read" }) });
    const recipe = compileLaunchRecipe({
      command: "filesystem-fixture",
      args: [runtime.input("workspace")],
    }, schema);
    const cache = new EdgeCapabilityCache();
    await cache.setDesiredRecipe("tenant-1", "fixture", recipe.digest);
    await cache.update({
      tenantId: "tenant-1",
      deploymentId: "fixture",
      recipeDigest: recipe.digest,
      capturedAt: Date.now(),
      tools: [{ name: "read_file", inputSchema: { type: "object" } }],
      resources: [{ name: "note", uri: "fixture:///note.txt" }],
      resourceTemplates: [{ name: "files", uriTemplate: "fixture:///{name}" }],
      prompts: [{ name: "summarize", arguments: [{ name: "file" }] }],
      supportsCompletion: true,
    });
    await cache.setOnline("tenant-1", "fixture", true, "node-alice");
    await cache.setOnline("tenant-1", "fixture", true, "node-bob");

    const supervisors = new Map<string, EdgeWorkloadSupervisor>();
    const connect = async (nodeId: string, credential: string, root: string) => {
      const provider: LocalSetupProvider = {
        approveWorkload: async () => true,
        collectField: async () => ({ approved: true, value: root }),
      };
      const setup = new LocalSetupManager({
        store: new MemoryStore(),
        credentials: new MemoryCredentials(),
        provider,
      });
      const supervisor = new EdgeWorkloadSupervisor({
        setup,
        factory: {
          start: async (plan) => ({
            client: new FilesystemFixtureMcp(plan.args[0]),
            stopGracefully: async () => undefined,
            forceKill: async () => undefined,
          }),
        },
      });
      await supervisor.reconcile([{
        requirement: {
          deploymentId: "fixture",
          desiredStateVersion: 1,
          recipe,
          schema,
        },
      }]);
      supervisors.set(nodeId, supervisor);
      const socket = new LoopbackSocket();
      socket.onServerMessage = async (message) => {
        if (message.kind === "mcp.request") socket.receive(await supervisor.handleRequest(message));
        if (message.kind === "mcp.cancel") supervisor.handleCancel(message);
      };
      const accepted = gateway.accept(socket, credential);
      socket.receive({
        version: EDGE_PROTOCOL_VERSION,
        kind: "edge.hello",
        tenantId: "tenant-1",
        edgeNodeId: nodeId,
        supportedVersions: [EDGE_PROTOCOL_VERSION],
        nonce: "nonce",
        proof: "proof",
      });
      await accepted;
      return socket;
    };
    const aliceSocket = await connect("node-alice", "cred-alice", aliceRoot);
    await connect("node-bob", "cred-bob", bobRoot);

    const edgeTransport = new EdgeTransport({ channel: gateway });
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "fixture", transport: new CatalogTransport() })],
      targets: { personal: edge({ device: edge.userDefaultDevice() }) },
      placements: [{ serverName: "fixture", scope: "global", targetName: "personal" }],
      edge: {
        transport: edgeTransport,
        capabilityCache: cache,
        deviceResolver: {
          resolveUserDefaultDevice: async (context) => ({
            edgeNodeId: context.subjectId === "bob" ? "node-bob" : "node-alice",
          }),
        },
      },
    });
    const identity = (sessionId: string) => ({
      authenticated: true,
      metadata: { sessionId, tenantId: "tenant-1" },
    });

    await expect(proxy.listTools(undefined, { id: "alice" }, identity("alice-session"))).resolves.toMatchObject({
      tools: [{ name: "fixture__read_file" }],
    });
    await expect(proxy.callTool(
      { name: "fixture__read_file", arguments: { file: "note.txt" } },
      { id: "alice" },
      identity("alice-session"),
    )).resolves.toMatchObject({ content: [{ text: "alice-private" }] });
    await expect(proxy.callTool(
      { name: "fixture__read_file", arguments: { file: "note.txt" } },
      { id: "bob" },
      identity("bob-session"),
    )).resolves.toMatchObject({ content: [{ text: "bob-private" }] });
    await expect(proxy.readResource(
      { uri: `fentaris://resources/fixture/${encodeURIComponent("fixture:///note.txt")}` },
      { id: "alice" },
      identity("alice-session"),
    )).resolves.toMatchObject({ contents: [{ text: "alice-private" }] });
    await expect(proxy.getPrompt(
      { name: "fixture__summarize", arguments: { file: "note.txt" } },
      { id: "alice" },
      identity("alice-session"),
    )).resolves.toMatchObject({ messages: [{ content: { text: "Summarize note.txt" } }] });
    await expect(proxy.complete(
      { ref: { type: "ref/prompt", name: "fixture__summarize" }, argument: { name: "file", value: "n" } },
      { id: "alice" },
      identity("alice-session"),
    )).resolves.toEqual({ completion: { values: ["note.txt"] } });

    aliceSocket.close();
    await expect(proxy.callTool(
      { name: "fixture__read_file", arguments: { file: "note.txt" } },
      { id: "alice" },
      identity("alice-session"),
    )).resolves.toMatchObject({ isError: true });
    await proxy.endEdgeSession("alice-session");
    expect(await proxy.edgeSessionPinner()?.store.size()).toBe(1);
    await Promise.all([...supervisors.values()].map((supervisor) => supervisor.shutdown()));
  });
});
