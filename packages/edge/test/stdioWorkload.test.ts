import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StdioEdgeWorkloadFactory } from "../src/index.js";

describe("StdioEdgeWorkloadFactory", () => {
  it("starts a real stdio MCP process, discovers capabilities, and forwards operations", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/stdioMcp.mjs", import.meta.url));
    const factory = new StdioEdgeWorkloadFactory();
    const startup = new AbortController();
    const workload = await factory.start({
      deploymentId: "fixture",
      recipeDigest: "sha256:fixture",
      command: process.execPath,
      args: [fixture],
      env: {},
    }, startup.signal);
    try {
      await expect(workload.client.capabilityManifest?.()).resolves.toMatchObject({
        tools: [{ name: "echo" }],
        resources: [],
        prompts: [],
        supportsCompletion: false,
      });
      await expect(workload.client.request(
        "tools/call",
        { name: "echo", arguments: { text: "edge-ok" } },
        new AbortController().signal,
      )).resolves.toMatchObject({
        content: [{ type: "text", text: "edge-ok" }],
      });
    } finally {
      await workload.stopGracefully();
    }
  });
});
