import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EdgeMcpOperation } from "@fentaris/core";
import type { LocalMcpClient, LocalMcpCapabilityManifest } from "../../src/index.js";

export class FilesystemFixtureMcp implements LocalMcpClient {
  constructor(private readonly root: string) {}

  async request(operation: EdgeMcpOperation, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error("cancelled");
    const input = (params ?? {}) as Record<string, unknown>;
    switch (operation) {
      case "tools/list":
        return { tools: (await this.capabilityManifest()).tools };
      case "tools/call": {
        if (input.name !== "read_file") throw new Error("unknown fixture tool");
        const args = (input.arguments ?? {}) as Record<string, unknown>;
        const content = await readFile(this.file(String(args.file ?? "")), "utf8");
        return { content: [{ type: "text", text: content }] };
      }
      case "resources/list":
        return { resources: [{ name: "note", uri: "fixture:///note.txt" }] };
      case "resources/read":
        return {
          contents: [{
            uri: String(input.uri),
            text: await readFile(this.file(uriFile(String(input.uri))), "utf8"),
          }],
        };
      case "resources/templates/list":
        return { resourceTemplates: [{ name: "files", uriTemplate: "fixture:///{name}" }] };
      case "prompts/list":
        return { prompts: [{ name: "summarize", arguments: [{ name: "file" }] }] };
      case "prompts/get":
        return {
          messages: [{
            role: "user",
            content: { type: "text", text: `Summarize ${String((input.arguments as Record<string, unknown> | undefined)?.file ?? "note.txt")}` },
          }],
        };
      case "completion/complete":
        return { completion: { values: ["note.txt"] } };
      case "ping":
        return {};
    }
  }

  async capabilityManifest(): Promise<LocalMcpCapabilityManifest> {
    return {
      tools: [{ name: "read_file", description: "Read an approved fixture file", inputSchema: { type: "object" } }],
      resources: [{ name: "note", uri: "fixture:///note.txt" }],
      resourceTemplates: [{ name: "files", uriTemplate: "fixture:///{name}" }],
      prompts: [{ name: "summarize", arguments: [{ name: "file" }] }],
      supportsCompletion: true,
    };
  }

  private file(name: string): string {
    const candidate = path.resolve(this.root, name);
    const relative = path.relative(this.root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("fixture path escape");
    return candidate;
  }
}

function uriFile(uri: string): string {
  const parsed = new URL(uri);
  return parsed.pathname.replace(/^\/+/, "");
}

