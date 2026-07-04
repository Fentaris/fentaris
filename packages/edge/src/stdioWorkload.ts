import {
  StdioTransport,
  edgeError,
  type EdgeMcpOperation,
} from "@fentaris/core";
import type { CompiledLocalLaunchPlan } from "./setup.js";
import type {
  EdgeWorkload,
  EdgeWorkloadFactory,
  LocalMcpCapabilityManifest,
  LocalMcpClient,
} from "./supervisor.js";

class StdioLocalMcpClient implements LocalMcpClient {
  constructor(private readonly transport: StdioTransport) {}

  async request(operation: EdgeMcpOperation, params: unknown, signal: AbortSignal): Promise<unknown> {
    const pending = this.dispatch(operation, params);
    return abortable(pending, signal, () => this.transport.close());
  }

  async capabilityManifest(): Promise<LocalMcpCapabilityManifest> {
    const capabilities = await this.transport.serverCapabilities();
    const [tools, resources, resourceTemplates, prompts] = await Promise.all([
      this.transport.listTools().then((result) => result.tools),
      this.transport.listResources().then((result) => result.resources),
      this.transport.listResourceTemplates().then((result) => result.resourceTemplates),
      this.transport.listPrompts().then((result) => result.prompts),
    ]);
    return {
      tools,
      resources,
      resourceTemplates,
      prompts,
      supportsCompletion: Boolean(capabilities?.completions),
    };
  }

  private dispatch(operation: EdgeMcpOperation, params: unknown): Promise<unknown> {
    switch (operation) {
      case "tools/list":
        return this.transport.listTools(params as Parameters<StdioTransport["listTools"]>[0]);
      case "tools/call":
        return this.transport.callTool(params as Parameters<StdioTransport["callTool"]>[0]);
      case "resources/list":
        return this.transport.listResources(params as Parameters<NonNullable<StdioTransport["listResources"]>>[0]);
      case "resources/read":
        return this.transport.readResource(params as Parameters<NonNullable<StdioTransport["readResource"]>>[0]);
      case "resources/templates/list":
        return this.transport.listResourceTemplates(
          params as Parameters<NonNullable<StdioTransport["listResourceTemplates"]>>[0],
        );
      case "prompts/list":
        return this.transport.listPrompts(params as Parameters<NonNullable<StdioTransport["listPrompts"]>>[0]);
      case "prompts/get":
        return this.transport.getPrompt(params as Parameters<NonNullable<StdioTransport["getPrompt"]>>[0]);
      case "completion/complete":
        return this.transport.complete(params as Parameters<NonNullable<StdioTransport["complete"]>>[0]);
      case "ping":
        return Promise.resolve({});
    }
  }
}

/** Production workload factory backed by one stdio MCP client per workload. */
export class StdioEdgeWorkloadFactory implements EdgeWorkloadFactory {
  async start(plan: CompiledLocalLaunchPlan, signal: AbortSignal): Promise<EdgeWorkload> {
    const transport = new StdioTransport({
      command: plan.command,
      args: [...plan.args],
      env: { ...plan.env },
      clientName: "fentaris-edge",
    });
    try {
      await abortable(transport.serverCapabilities(), signal, () => transport.close());
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    return {
      client: new StdioLocalMcpClient(transport),
      stopGracefully: () => transport.close(),
      forceKill: () => transport.close(),
    };
  }
}

function abortable<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void | Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    void onAbort();
    return Promise.reject(edgeError("EDGE_WORKLOAD", "Edge MCP operation was cancelled."));
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(edgeError("EDGE_WORKLOAD", "Edge MCP operation was cancelled."));
      void onAbort();
    };
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
