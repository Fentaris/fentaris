import type { EdgeAgent } from "./agent.js";
import { redactEdgeValue, safeEdgeError } from "./redaction.js";

export interface EdgeCliIo {
  out(value: string): void;
  error(value: string): void;
}

export async function runEdgeCli(argv: readonly string[], agent: EdgeAgent, io: EdgeCliIo): Promise<number> {
  const command = argv[0] ?? "status";
  try {
    switch (command) {
      case "login": {
        const result = await agent.login();
        io.out(JSON.stringify(redactEdgeValue({
          status: result.repeated ? "already-enrolled" : "enrolled",
          edgeNodeId: result.config.edgeNodeId,
          tenantId: result.config.tenantId,
          connected: true,
        })));
        return 0;
      }
      case "status":
        io.out(JSON.stringify(redactEdgeValue(await agent.status())));
        return 0;
      case "disconnect":
        await agent.disconnect();
        io.out(JSON.stringify({ status: "disconnected" }));
        return 0;
      case "revoke":
        await agent.revoke();
        io.out(JSON.stringify({ status: "revoked" }));
        return 0;
      case "add":
        io.error("MCP definitions and assignments are managed by Fentaris; fentaris-edge has no add command.");
        return 2;
      default:
        io.error("Usage: fentaris-edge <login|status|disconnect|revoke>");
        return 2;
    }
  } catch (error) {
    io.error(JSON.stringify(safeEdgeError(error)));
    return 1;
  }
}

