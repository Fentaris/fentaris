#!/usr/bin/env node
import process from "node:process";

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const frame = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (frame.trim()) handle(JSON.parse(frame));
  }
});

function handle(message) {
  if (message.id === undefined) return;
  let result;
  switch (message.method) {
    case "initialize":
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "edge-stdio-fixture", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = {
        tools: [{
          name: "echo",
          description: "Echo text",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        }],
      };
      break;
    case "tools/call":
      result = {
        content: [{ type: "text", text: String(message.params.arguments?.text ?? "") }],
      };
      break;
    default:
      respond(message.id, undefined, { code: -32601, message: "Method not found" });
      return;
  }
  respond(message.id, result);
}

function respond(id, result, error) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    ...(error ? { error } : { result }),
  }) + "\n");
}
