import { randomUUID } from "node:crypto";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FentarisTransportError, createRuntimeEvent, runtimeErrorToEventPayload } from "../../profiler/index.js";
import { attachDownstreamSessionId, ensureIdentityWithMetadata } from "./downstreamSession.js";
import type { ProxyExposureHandle, ProxyExposureTransport, ProxyRuntime } from "../../types/proxy.js";
import type {
  IdentityMetadata,
  ResolvedSubject,
  UserContext,
} from "../../types/shared.js";

/**
 * Options for stdio downstream proxy exposure.
 * @pk
 */
export type StdioProxyExposureTransportOptions = {
  user?: UserContext | (() => UserContext | Promise<UserContext>);
};

/**
 * Stdio MCP downstream proxy exposure.
 * @pk
 */
export class StdioProxyExposureTransport implements ProxyExposureTransport {
  private readonly options: StdioProxyExposureTransportOptions;

  /**
   * Create a stdio proxy exposure transport.
   * @pk
   */
  constructor(options: StdioProxyExposureTransportOptions = {}) {
    this.options = options;
  }

  async listen(runtime: ProxyRuntime): Promise<ProxyExposureHandle> {
    const resolved = await this.resolveUser(runtime);
    if (runtime.identityRequired && !resolved.identity?.authenticated) {
      throw new Error("Stdio proxy exposure requires an authenticated identity when identityRequired is enabled");
    }

    // stdio is a single-session transport with no SDK-supplied session id;
    // derive a stable downstream session id so edge session pinning and proxy
    // operation context see a consistent session identity. @pk
    const downstreamSessionId = randomUUID();
    const sessionIdentity = ensureIdentityWithMetadata(resolved.identity);
    attachDownstreamSessionId(sessionIdentity, downstreamSessionId);
    const sdkServer = runtime.createSdkServer(resolved.user, sessionIdentity, resolved.subject) as McpSdkServer;
    const transport = new StdioServerTransport();

    try {
      await sdkServer.connect(transport);
    } catch (error) {
      await runtime.emitRuntimeEvent(createRuntimeEvent({
        name: "transport.error",
        category: "errors",
        level: "error",
        transport: "stdio",
        error: runtimeErrorToEventPayload(new FentarisTransportError("Stdio MCP proxy transport failed", { cause: error })),
      }));
      throw error;
    }
    await runtime.emitSessionStart({
      user: resolved.user,
      identity: sessionIdentity,
      sessionId: downstreamSessionId,
      log: runtime.logger.child({ userId: resolved.user.id, transport: "stdio", sessionId: downstreamSessionId }),
    });

    transport.onclose = () => {
      void runtime.emitSessionEnd({
        user: resolved.user,
        identity: sessionIdentity,
        sessionId: downstreamSessionId,
        log: runtime.logger.child({ userId: resolved.user.id, transport: "stdio", sessionId: downstreamSessionId }),
      });
    };

    return {
      close: async () => {
        await transport.close();
        await sdkServer.close();
      },
    };
  }

  private async resolveUser(
    runtime: ProxyRuntime,
  ): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }> {
    if (!this.options.user) {
      return runtime.resolveStdioUser();
    }

    const user = typeof this.options.user === "function" ? await this.options.user() : this.options.user;
    return { user };
  }
}
