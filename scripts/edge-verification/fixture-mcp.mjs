#!/usr/bin/env node
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const frame = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (frame.trim()) respond(JSON.parse(frame));
  }
});

function respond(message) {
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "installed-edge-fixture", version: "1.0.0" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }
      : message.method === "tools/call"
        ? { content: [{ type: "text", text: String(message.params.arguments?.text ?? "") }] }
        : undefined;
  process.stdout.write(`${JSON.stringify(result === undefined
    ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
    : { jsonrpc: "2.0", id: message.id, result })}\n`);
}
