import type { EdgeAgent } from "./agent.js";
import type { EdgeJoinMetadata } from "./enrollment.js";
import type { EdgeServiceOperation, EdgeServiceResult } from "./service.js";
import { redactEdgeValue, safeEdgeError } from "./redaction.js";

export interface EdgeCliIo {
  out(value: string): void;
  error(value: string): void;
}

export interface EdgeCliOperations {
  installService(): Promise<EdgeServiceResult>;
  service(operation: EdgeServiceOperation): Promise<EdgeServiceResult>;
  run(): Promise<void>;
}

export async function runEdgeCli(
  argv: readonly string[],
  agent: EdgeAgent,
  io: EdgeCliIo,
  operations?: EdgeCliOperations,
): Promise<number> {
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
          warnings: ["fentaris-edge login is deprecated; use fentaris edge join <control-plane-url>."],
        })));
        return 0;
      }
      case "join": {
        const parsed = parseJoin(argv.slice(1));
        const result = await agent.login(parsed.metadata);
        let service: EdgeServiceResult | undefined;
        const warnings: string[] = [];
        if (!parsed.noService) {
          if (!operations) throw new Error("Persistent service operations are unavailable in this embedding.");
          try {
            service = await operations.installService();
          } catch (error) {
            warnings.push("Persistent service installation was unavailable; enrollment identity was retained.");
            if (parsed.requireService) throw error;
          }
        }
        await agent.disconnect();
        const envelope = {
          ok: true,
          data: {
            status: result.repeated ? "already-enrolled" : "enrolled",
            device: { name: parsed.metadata.name ?? result.config.hostnameLabel ?? "edge-device" },
            service: service ?? { persistent: false, adapter: "foreground" },
          },
          pagination: null,
          warnings,
          nextActions: service?.persistent ? [] : [{ description: "Run Edge in the foreground", command: "fentaris edge run" }],
        };
        io.out(parsed.json ? JSON.stringify(envelope) : `${envelope.data.device.name} ${envelope.data.status}`);
        return 0;
      }
      case "run":
        if (!operations) throw new Error("Persistent Edge runtime is unavailable in this embedding.");
        await operations.run();
        return 0;
      case "service": {
        if (!operations) throw new Error("Persistent service operations are unavailable in this embedding.");
        const operation = serviceOperation(argv[1]);
        io.out(JSON.stringify({ ok: true, data: await operations.service(operation), pagination: null, warnings: [], nextActions: [] }));
        return 0;
      }
      case "status":
        io.out(JSON.stringify(redactEdgeValue({
          ...await agent.status(),
          warnings: ["fentaris-edge status is deprecated; use fentaris edge status."],
        })));
        return 0;
      case "disconnect":
        await agent.disconnect();
        io.out(JSON.stringify({ status: "disconnected", warnings: ["fentaris-edge disconnect is deprecated; use fentaris edge disconnect."] }));
        return 0;
      case "revoke":
        await agent.revoke();
        io.out(JSON.stringify({ status: "revoked", warnings: ["fentaris-edge revoke is deprecated; use fentaris edge revoke."] }));
        return 0;
      case "add":
        io.error("MCP definitions and assignments are managed by Fentaris; fentaris-edge has no add command.");
        return 2;
      default:
        io.error("Usage: fentaris-edge <join|run|service|login|status|disconnect|revoke>");
        return 2;
    }
  } catch (error) {
    io.error(JSON.stringify(safeEdgeError(error)));
    return 1;
  }
}

function parseJoin(argv: readonly string[]): {
  metadata: EdgeJoinMetadata;
  json: boolean;
  noService: boolean;
  requireService: boolean;
} {
  const metadata: { name?: string; description?: string; tags: string[] } = { tags: [] };
  let json = false;
  let noService = false;
  let requireService = false;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") json = true;
    else if (value === "--no-service") noService = true;
    else if (value === "--service") requireService = true;
    else if (value === "--name" || value === "--description" || value === "--tag") {
      const next = argv[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      if (value === "--name") metadata.name = next;
      else if (value === "--description") metadata.description = next;
      else metadata.tags.push(next);
      index += 1;
    } else if (value?.startsWith("-")) throw new Error(`Unknown join option ${value}.`);
  }
  if (noService && requireService) throw new Error("--service and --no-service cannot be combined.");
  return { metadata, json, noService, requireService };
}

function serviceOperation(value: string | undefined): EdgeServiceOperation {
  if (value === "install" || value === "start" || value === "stop" || value === "restart" || value === "uninstall") return value;
  throw new Error("service requires install, start, stop, restart, or uninstall.");
}
