import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EdgeLocalOperatorClient,
  HttpProxyExposureTransport,
  McpProxy,
  startIntegratedEdgeControlPlane,
} from "@fentaris/core";
import { createDefaultEdgeAgent, nodeEdgePlatform } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("real Edge agent with the integrated control plane", () => {
  it("authorizes, approves, enrolls, connects, refreshes, and revokes over loopback HTTP and WebSocket", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fentaris-integrated-edge-"));
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const controlPlaneUrl = `${origin}/_fentaris/edge`;
    const runtime = await startIntegratedEdgeControlPlane({
      controlPlane: { enabled: true, mode: "local", publicOrigin: origin, pollIntervalSeconds: 1 },
      authDir: path.join(root, "authority"),
      listenerHost: "127.0.0.1",
      listenerPort: port,
      protectionKey: "integration-test-key",
    });
    const proxy = new McpProxy();
    await proxy.listen(new HttpProxyExposureTransport({
      port,
      host: "127.0.0.1",
      path: "/mcp",
      httpRoutes: runtime.httpRoutes,
      upgradeRoutes: runtime.upgradeRoutes,
    }));
    cleanups.push(async () => {
      await proxy.stop().catch(() => undefined);
      await runtime.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });

    const platform = nodeEdgePlatform({
      dataDir: path.join(root, "agent"),
      configFile: path.join(root, "agent", "config.json"),
      deviceKeyFile: path.join(root, "agent", "device-key.json"),
      credentialFile: path.join(root, "agent", "credentials.json"),
    });
    const agent = createDefaultEdgeAgent({
      controlPlaneUrl,
      platform,
      onVerification: async (authorization) => {
        if (!runtime.operator) throw new Error("expected protected local operator channel");
        const result = await new EdgeLocalOperatorClient(runtime.operator.endpoint).request({
          command: "approve",
          userCode: authorization.userCode,
          decision: {
            tenantId: "default",
            subjectId: "alice",
            actorId: "integration-test",
            approvedAt: Date.now(),
          },
        });
        if (!result.ok) throw new Error("operator approval failed");
      },
    });

    await expect(agent.login({ name: "Alice laptop", tags: ["development"] })).resolves.toMatchObject({ repeated: false });
    await expect(agent.status()).resolves.toMatchObject({ enrolled: true, connected: true, tenantId: "default" });
    await expect(runtime.health()).resolves.toMatchObject({ enrolledDevices: 1, desiredAssignments: 1 });

    const oldRefresh = await platform.credentialStore.get("refresh-token");
    if (!oldRefresh) throw new Error("expected refresh credential");
    await platform.credentialStore.set("access-expires-at", "1");
    await agent.reconnect();
    expect(await platform.credentialStore.get("refresh-token")).not.toBe(oldRefresh);

    await agent.revoke();
    await expect(agent.status()).resolves.toMatchObject({ enrolled: false, connected: false });
    await expect(runtime.health()).resolves.toMatchObject({ enrolledDevices: 0, desiredAssignments: 0 });
  }, 20_000);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected loopback port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
