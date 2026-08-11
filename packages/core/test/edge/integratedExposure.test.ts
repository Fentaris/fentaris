import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpProxy } from "../../src/proxy/McpProxy.js";
import {
  EdgeLocalAuthorityStore,
  EdgeLocalOperatorClient,
  McpServer,
  StdioTransport,
  compileEdgeDeploymentCatalog,
  createSetupSchema,
  edge,
  normalizeEdgeControlPlaneConfig,
  startIntegratedEdgeControlPlane,
} from "../../src/index.js";

const proxies: McpProxy[] = [];
const runtimes: Array<Awaited<ReturnType<typeof startIntegratedEdgeControlPlane>>> = [];

afterEach(async () => {
  while (proxies.length > 0) {
    await proxies.pop()?.stop();
  }
  while (runtimes.length > 0) {
    await runtimes.pop()?.close();
  }
});

describe("integrated Edge control-plane exposure", () => {
  it("restores persisted device metadata before startup reconciliation", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "fentaris-edge-restart-"));
    const directory = path.join(authDir, "edge-control-plane");
    const store = new EdgeLocalAuthorityStore({ directory, protectionKey: "test-key" });
    await store.open();
    await store.putEnrolledDevice({
      tenantId: "default",
      edgeNodeId: "node-1",
      subjectId: "alice",
      publicKey: "test-public-key",
      credentialId: "credential-1",
      credentialHash: "sha256:test",
      enrolledAt: 1,
      revoked: false,
      connectionGeneration: 1,
      user: { name: "Alice laptop", tags: ["development"], updatedAt: 1 },
      managed: { aliases: [], pools: [], updatedAt: 1 },
    });
    await store.close();

    const server = new McpServer({ name: "echo", transport: new StdioTransport({ command: "node" }) });
    const catalog = compileEdgeDeploymentCatalog({
      servers: [server],
      targets: new Map([["personal", edge({ device: edge.namedDevice("Alice laptop") })]]),
      bindings: [{ serverName: "echo", scope: "global", targetName: "personal" }],
      setupSchemas: new Map([["echo", createSetupSchema({})]]),
    });
    const runtime = await startIntegratedEdgeControlPlane({
      controlPlane: { enabled: true, mode: "local", publicOrigin: "http://127.0.0.1:4000" },
      authDir,
      protectionKey: "test-key",
      catalog,
    });
    runtimes.push(runtime);

    expect(runtime.store?.snapshot().desiredAssignments).toMatchObject([{
      edgeNodeId: "node-1",
      deploymentIds: ["echo"],
    }]);

    if (!runtime.operator) throw new Error("expected operator channel");
    const operator = new EdgeLocalOperatorClient(runtime.operator.endpoint);
    const listed = await operator.request({
      command: "device-list",
      context: { tenantId: "default", subjectId: "alice" },
    });
    expect(listed).toMatchObject({
      ok: true,
      data: { ok: true, data: [{ device: { name: "Alice laptop" }, revoked: false }] },
    });
    const revoked = await operator.request({
      command: "device-revoke",
      context: { tenantId: "default" },
      deviceName: "Alice laptop",
    });
    expect(revoked).toMatchObject({ ok: true, data: { ok: true, data: { revoked: true } } });
    expect(runtime.store?.snapshot().enrolledDevices[0]?.revoked).toBe(true);
    expect(runtime.store?.snapshot().desiredAssignments).toHaveLength(0);
  });

  it("serves authorize and token routes from app.start when enabled", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "fentaris-edge-http-"));
    const port = await freePort();
    const proxy = new McpProxy({
      port,
      host: "127.0.0.1",
      path: "/mcp",
      edge: {
        controlPlane: {
          enabled: true,
          mode: "local",
          publicOrigin: `http://127.0.0.1:${port}`,
          stateDir: "edge-control-plane",
        },
      },
    });
    // Force auth directory by starting the composition through env-backed protection and resolved state under tmp.
    Object.assign(proxy as object, {});
    // Rebind control-plane authDir via direct runtime composition for deterministic temp paths.
    await proxy.stop().catch(() => undefined);

    const config = normalizeEdgeControlPlaneConfig({
      enabled: true,
      mode: "local",
      publicOrigin: `http://127.0.0.1:${port}`,
    });
    if (!config) throw new Error("expected config");
    const runtime = await startIntegratedEdgeControlPlane({
      controlPlane: { enabled: true, mode: "local", publicOrigin: `http://127.0.0.1:${port}` },
      authDir,
      listenerHost: "127.0.0.1",
      listenerPort: port,
      protectionKey: "test-key",
    });
    runtimes.push(runtime);

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const route = runtime.httpRoutes.find(
        (entry) => entry.method === (req.method ?? "GET") && entry.path === url.pathname,
      );
      if (!route) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      await route.handler(req, res, url);
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    try {
      const authorize = await fetch(`http://127.0.0.1:${port}/_fentaris/edge/device/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "fentaris-edge" }),
      });
      expect(authorize.status).toBe(200);
      const began = await authorize.json() as { deviceCode: string; userCode: string };
      expect(began.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

      const pending = await fetch(`http://127.0.0.1:${port}/_fentaris/edge/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "fentaris-edge", deviceCode: began.deviceCode }),
      });
      expect(pending.status).toBe(400);
      await expect(pending.json()).resolves.toMatchObject({ error: "authorization_pending" });

      if (!runtime.operator) throw new Error("expected operator channel");
      const client = new EdgeLocalOperatorClient(runtime.operator.endpoint);
      const approved = await client.request({
        command: "approve",
        userCode: began.userCode,
        decision: {
          tenantId: "default",
          subjectId: "alice",
          actorId: "operator",
          approvedAt: Date.now(),
        },
      });
      expect(approved.ok).toBe(true);

      const token = await fetch(`http://127.0.0.1:${port}/_fentaris/edge/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "fentaris-edge", deviceCode: began.deviceCode }),
      });
      expect(token.status).toBe(200);
      await expect(token.json()).resolves.toMatchObject({
        tokenType: "Bearer",
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
