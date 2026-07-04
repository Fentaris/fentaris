import { describe, expect, it, vi } from "vitest";
import {
  EdgeCapabilityCache,
  McpProxy,
  McpServer,
  edge,
  type EdgeCapabilityManifest,
  type FentarisTransport,
} from "../../src/index.js";

const manifest = (overrides: Partial<EdgeCapabilityManifest> = {}): EdgeCapabilityManifest => ({
  tenantId: "tenant-1",
  deploymentId: "fixture",
  recipeDigest: "sha256:one",
  capturedAt: 100,
  tools: [{ name: "status", inputSchema: { type: "object" } }],
  resources: [{ name: "readme", uri: "file:///readme" }],
  resourceTemplates: [{ name: "files", uriTemplate: "file:///{path}" }],
  prompts: [{ name: "help" }],
  supportsCompletion: true,
  ...overrides,
});

class CloudTransport implements FentarisTransport {
  readonly listTools = vi.fn(async () => ({ tools: [{ name: "cloud", inputSchema: { type: "object" as const } }] }));
  readonly callTool = vi.fn(async () => ({ content: [] }));
  async close() {}
}

describe("EdgeCapabilityCache", () => {
  it("validates, caches, preserves offline discovery, invalidates recipe changes, and notifies", async () => {
    let now = 120;
    const cache = new EdgeCapabilityCache(undefined, () => now);
    const changes = vi.fn();
    cache.addListener(changes);
    await cache.setDesiredRecipe("tenant-1", "fixture", "sha256:one");
    await expect(cache.state("tenant-1", "fixture")).resolves.toMatchObject({
      status: "setup-required",
      diagnostic: expect.stringContaining("complete setup"),
    });

    await cache.update(manifest());
    await expect(cache.state("tenant-1", "fixture")).resolves.toMatchObject({
      status: "ready",
      cacheAgeMs: 20,
      manifest: { recipeDigest: "sha256:one" },
    });
    await cache.setOnline("tenant-1", "fixture", false);
    now = 150;
    await expect(cache.state("tenant-1", "fixture")).resolves.toMatchObject({
      status: "offline-cached",
      cacheAgeMs: 50,
      manifest: { tools: [{ name: "status" }] },
    });
    expect(changes).toHaveBeenCalled();

    await cache.setDesiredRecipe("tenant-1", "fixture", "sha256:two");
    await expect(cache.state("tenant-1", "fixture")).resolves.toMatchObject({ status: "setup-required" });
    await expect(cache.update(manifest())).rejects.toMatchObject({ code: "EDGE_PROTOCOL" });
  });

  it("serves stable logical names to different subjects and returns no capabilities before readiness", async () => {
    const cache = new EdgeCapabilityCache();
    const cloud = new CloudTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "fixture", transport: cloud })],
      targets: { personal: edge({ device: edge.userDefaultDevice() }) },
      placements: [{ serverName: "fixture", scope: "global", targetName: "personal" }],
      edge: { capabilityCache: cache },
    });

    await expect(proxy.listTools(
      undefined,
      { id: "alice" },
      { authenticated: true, userId: "alice", metadata: { tenantId: "tenant-1" } },
    )).resolves.toEqual({ tools: [] });
    expect(cloud.listTools).not.toHaveBeenCalled();

    await cache.setDesiredRecipe("tenant-1", "fixture", "sha256:one");
    await cache.update(manifest());
    const alice = await proxy.listTools(
      undefined,
      { id: "alice" },
      { authenticated: true, userId: "alice", metadata: { tenantId: "tenant-1" } },
    );
    const bob = await proxy.listTools(
      undefined,
      { id: "bob" },
      { authenticated: true, userId: "bob", metadata: { tenantId: "tenant-1" } },
    );
    expect(alice.tools.map((tool) => tool.name)).toEqual(["fixture__status"]);
    expect(bob.tools.map((tool) => tool.name)).toEqual(["fixture__status"]);

    await cache.setOnline("tenant-1", "fixture", false);
    await expect(proxy.listResources(
      undefined,
      { id: "alice" },
      { authenticated: true, userId: "alice", metadata: { tenantId: "tenant-1" } },
    )).resolves.toMatchObject({
      resources: [{ uri: "fentaris://resources/fixture/file%3A%2F%2F%2Freadme" }],
    });
    await expect(proxy.listResourceTemplates(
      undefined,
      { id: "alice" },
      { authenticated: true, userId: "alice", metadata: { tenantId: "tenant-1" } },
    )).resolves.toMatchObject({
      resourceTemplates: [{ uriTemplate: expect.stringContaining("fixture") }],
    });
    await expect(proxy.listPrompts(
      undefined,
      { id: "alice" },
      { authenticated: true, userId: "alice", metadata: { tenantId: "tenant-1" } },
    )).resolves.toMatchObject({
      prompts: [{ name: "fixture__help" }],
    });
  });

  it("rejects malformed manifests", async () => {
    const cache = new EdgeCapabilityCache();
    await expect(cache.update({
      ...manifest(),
      tools: [{ inputSchema: { type: "object" } }] as EdgeCapabilityManifest["tools"],
    })).rejects.toMatchObject({ code: "EDGE_PROTOCOL" });
  });
});
