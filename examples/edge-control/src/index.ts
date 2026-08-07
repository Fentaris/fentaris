import {
  McpProxy,
  McpServer,
  Policy,
  StdioTransport,
  edge,
  runtime,
} from "@fentaris/core";

/** A self-contained local app: no gateway, inventory, or resolver wiring. */
export function createEdgeControlApp(): McpProxy {
  return new McpProxy({
    port: 4000,
    host: "127.0.0.1",
    servers: [new McpServer({
      name: "workspace",
      transport: new StdioTransport({
        command: "workspace-mcp",
        args: ["--root", runtime.input("workspace")],
      }),
    })],
    policy: Policy.allowAll(),
    targets: {
      personal: edge({ device: edge.userDefaultDevice() }),
    },
    setup: {
      workspace: {
        workspace: edge.folder({ access: "read-write" }),
      },
    },
    placements: [
      { serverName: "workspace", scope: "global", targetName: "personal" },
    ],
    edge: {
      controlPlane: {
        enabled: true,
        mode: "local",
        publicOrigin: "http://127.0.0.1:4000",
      },
    },
  });
}

export async function startEdgeControlApp(): Promise<McpProxy> {
  const app = createEdgeControlApp();
  await app.start();
  return app;
}
