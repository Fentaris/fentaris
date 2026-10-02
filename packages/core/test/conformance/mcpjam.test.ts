import { describe, expect, it } from "vitest";
import { fentaris } from "../../src/proxy/McpProxy.js";
import { Policy } from "../../src/governance.js";
import { oauthIdentityStrategy } from "../../src/identity/oauthIdentityStrategy.js";
import { startAuthorizationServer } from "../fixtures/oauth/authorizationServer.js";
import { startTlsProxy } from "../fixtures/oauth/tlsProxy.js";

// Opt-in: the default suite must not run a third-party OAuth conformance campaign.
describe.skipIf(process.env.FENTARIS_MCPJAM !== "1")("mcpjam inbound OAuth conformance", () => {
  it("passes DCR and pre-registered headless flows, negative checks and tool calls", async () => {
    const { OAuthConformanceSuite, MCPClientManager } = await import("@mcpjam/sdk");
    const as = await startAuthorizationServer({ jwtAccessTokens: true });
    const redirectUrl = "http://127.0.0.1:9876/callback";
    as.preregister({ client_id: "mcpjam-fixture", redirect_uris: [redirectUrl] });
    const edge = await startTlsProxy();
    const serverUrl = `${edge.url}/mcp`;
    const app = fentaris({ port: 0, policy: Policy.allowAll(), identity: oauthIdentityStrategy({ issuer: as.url, resource: serverUrl, scopes: ["mcp:tools"] }) });
    app.local("verification").tool("echo", { description: "Return the authenticated user", inputSchema: { type: "object", properties: {}, additionalProperties: false } }, (ctx) => ({ content: [{ type: "text", text: ctx.user.id ?? "anonymous" }] }));
    const manager = new MCPClientManager();
    try {
      const server = await app.start();
      edge.setUpstream(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      const result = await new OAuthConformanceSuite({
        serverUrl,
        defaults: { protocolVersion: "2025-11-25", auth: { mode: "headless" }, scopes: "mcp:tools", redirectUrl, allowPrivateNetwork: true, verification: { listTools: true }, oauthConformanceChecks: true },
        flows: [{ registrationStrategy: "dcr" }, { registrationStrategy: "preregistered", client: { preregistered: { clientId: "mcpjam-fixture" } } }],
      }).run();
      const failures = result.results.flatMap((flow) => flow.steps.filter((step) => step.status === "failed").map((step) => `${step.title}: ${step.error?.message}`));
      expect(result.passed, `${result.summary}\n${failures.join("\n")}`).toBe(true);
      expect(result.results).toHaveLength(2);
      for (const flow of result.results) {
        expect(flow.passed, flow.summary).toBe(true);
        expect(flow.steps.filter((step) => step.status === "failed")).toEqual([]);
      }
      // Login credentials obtained by the suite are consumed by a separate MCP client.
      const accessToken = result.results[0]?.credentials?.accessToken;
      expect(accessToken).toBeTruthy();
      await manager.connectToServer("candidate", { url: serverUrl, accessToken });
      expect((await manager.listTools("candidate")).tools.map((tool) => tool.name)).toContain("verification__echo");
      expect(await manager.executeTool("candidate", "verification__echo", {})).toMatchObject({ content: [{ type: "text", text: "demo-user" }] });
    } finally {
      await manager.disconnectAllServers(); await app.close(); await edge.close(); await as.close();
    }
  }, 120_000);
});
