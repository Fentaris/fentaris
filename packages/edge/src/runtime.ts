import {
  EDGE_PROTOCOL_VERSION,
  edgeError,
  validateLaunchRecipe,
  validateSetupSchema,
  type EdgeAgentMessage,
  type EdgeCapabilityManifestMessage,
  type EdgeControlPlaneMessage,
  type EdgeDesiredStateMessage,
  type EdgeProtocolClaims,
  type EdgeReadinessReport,
  type EdgeCapacitySnapshot,
  type EdgeLoadSnapshot,
} from "@fentaris/core";
import type { LocalSetupManager } from "./setup.js";
import type {
  EdgeWorkloadSupervisor,
  LocalMcpCapabilityManifest,
} from "./supervisor.js";

export interface EdgeRuntimeSummary {
  readonly desiredDeployments: number;
  readonly readyDeployments: number;
  readonly blockedDeployments: number;
}

export interface EdgeRuntimeSummaryProvider {
  summary(): Promise<EdgeRuntimeSummary>;
}

export interface EdgeRuntimeConnection {
  readonly claims: EdgeProtocolClaims;
  send(message: EdgeAgentMessage): Promise<void>;
  publishPresence?(): Promise<void>;
}

export interface EdgeAgentPresenceSnapshot {
  readonly capacity?: EdgeCapacitySnapshot;
  readonly load?: EdgeLoadSnapshot;
  readonly readiness: readonly EdgeReadinessReport[];
}

/** Runtime callback surface consumed by the persistent WebSocket connection. */
export interface EdgeConnectionRuntime extends EdgeRuntimeSummaryProvider {
  connected(connection: EdgeRuntimeConnection): void | Promise<void>;
  handle(message: Exclude<EdgeControlPlaneMessage, { kind: "edge.hello.ack" }>): void | Promise<void>;
  disconnected(): void | Promise<void>;
  clearLocalState?(): void | Promise<void>;
  presenceSnapshot?(): EdgeAgentPresenceSnapshot | Promise<EdgeAgentPresenceSnapshot>;
}

export interface EdgeAgentRuntimeOptions {
  readonly setup: LocalSetupManager;
  readonly supervisor: EdgeWorkloadSupervisor;
}

/**
 * Reconciles cloud desired state and bridges correlated MCP traffic to the
 * locally governed workload supervisor.
 */
export class EdgeAgentRuntime implements EdgeConnectionRuntime {
  private connection?: EdgeRuntimeConnection;
  private desiredVersion = 0;
  private reconcileQueue = Promise.resolve();
  private statuses = new Map<string, "ready" | "blocked">();

  constructor(private readonly options: EdgeAgentRuntimeOptions) {}

  connected(connection: EdgeRuntimeConnection): void {
    this.connection = connection;
  }

  async handle(message: Exclude<EdgeControlPlaneMessage, { kind: "edge.hello.ack" }>): Promise<void> {
    this.assertTrustedRoute(message);
    switch (message.kind) {
      case "edge.desired-state":
        await this.enqueueReconcile(message);
        return;
      case "mcp.request":
        await this.send(await this.options.supervisor.handleRequest(message));
        return;
      case "mcp.cancel":
        this.options.supervisor.handleCancel(message);
        return;
    }
  }

  async disconnected(): Promise<void> {
    this.connection = undefined;
    await this.options.supervisor.shutdown();
  }

  async clearLocalState(): Promise<void> {
    await this.options.supervisor.shutdown();
    await this.options.setup.clear();
    this.desiredVersion = 0;
    this.reconcileQueue = Promise.resolve();
    this.statuses.clear();
  }

  async summary(): Promise<EdgeRuntimeSummary> {
    let readyDeployments = 0;
    let blockedDeployments = 0;
    for (const status of this.statuses.values()) {
      if (status === "ready") readyDeployments += 1;
      else blockedDeployments += 1;
    }
    return {
      desiredDeployments: this.statuses.size,
      readyDeployments,
      blockedDeployments,
    };
  }

  async presenceSnapshot(): Promise<EdgeAgentPresenceSnapshot> {
    const observedAt = Date.now();
    return {
      readiness: [...this.statuses.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([deploymentId, status]) => ({
          deploymentId,
          status: status === "ready" ? "ready" : "setup-required",
          observedAt,
        })),
    };
  }

  async reportCapabilityManifest(
    deploymentId: string,
    recipeDigest: string,
    manifest: LocalMcpCapabilityManifest,
  ): Promise<void> {
    const connection = this.requireConnection();
    const message: EdgeCapabilityManifestMessage = {
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.capability-manifest",
      ...connection.claims,
      deploymentId,
      recipeDigest,
      ...manifest,
    };
    await connection.send(message);
  }

  private async reconcile(message: EdgeDesiredStateMessage): Promise<void> {
    if (message.desiredVersion < this.desiredVersion) {
      throw edgeError("EDGE_PROTOCOL", "Received stale edge desired state.", {
        details: { received: message.desiredVersion, current: this.desiredVersion },
      });
    }
    const deployments = message.deployments.map((deployment) => {
      const recipe = validateLaunchRecipe(deployment.recipe);
      const diagnostics = validateSetupSchema(deployment.setupSchema)
        .filter((diagnostic) => diagnostic.severity === "error");
      if (diagnostics.length > 0) {
        throw edgeError("EDGE_PROTOCOL", "Desired deployment contains an invalid setup schema.", {
          details: { deploymentId: deployment.deploymentId, diagnostics },
        });
      }
      if (
        recipe.setupSchemaVersion !== undefined
        && recipe.setupSchemaVersion !== deployment.setupSchema.version
      ) {
        throw edgeError("EDGE_PROTOCOL", "Launch recipe and setup schema versions do not match.", {
          details: { deploymentId: deployment.deploymentId },
        });
      }
      return {
        requirement: {
          deploymentId: deployment.deploymentId,
          desiredStateVersion: message.desiredVersion,
          recipe,
          schema: deployment.setupSchema,
        },
      };
    });
    const results = await this.options.supervisor.reconcile(deployments);
    this.desiredVersion = message.desiredVersion;
    this.statuses = new Map(
      results
        .filter((result) => result.status !== "removed")
        .map((result) => [result.deploymentId, result.status === "ready" ? "ready" : "blocked"]),
    );

    const connection = this.requireConnection();
    await connection.publishPresence?.();
    for (const deployment of message.deployments) {
      const state = await this.options.setup.status(deployment.deploymentId);
      if (!state) continue;
      await connection.send({
        version: EDGE_PROTOCOL_VERSION,
        kind: "edge.setup-status",
        ...connection.claims,
        deploymentId: state.deploymentId,
        recipeDigest: state.recipeDigest,
        setupSchemaVersion: state.setupSchemaVersion,
        status: state.status,
        grantRefs: state.grantRefs,
      });
    }
    const blockedDeploymentIds = results
      .filter((result) => result.status === "blocked")
      .map((result) => result.deploymentId);
    await connection.send({
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.desired-state.ack",
      ...connection.claims,
      desiredVersion: message.desiredVersion,
      status: blockedDeploymentIds.length === 0 ? "applied" : "blocked",
      ...(blockedDeploymentIds.length > 0 ? { blockedDeploymentIds } : {}),
    });
  }

  private enqueueReconcile(message: EdgeDesiredStateMessage): Promise<void> {
    const pending = this.reconcileQueue.then(() => this.reconcile(message));
    this.reconcileQueue = pending.catch(() => undefined);
    return pending;
  }

  private assertTrustedRoute(
    message: Exclude<EdgeControlPlaneMessage, { kind: "edge.hello.ack" }>,
  ): void {
    const claims = this.requireConnection().claims;
    if (message.kind === "mcp.request" || message.kind === "mcp.cancel") {
      if (
        message.route.edgeNodeId !== claims.edgeNodeId
        || message.route.connectionGeneration !== claims.connectionGeneration
      ) {
        throw edgeError("EDGE_PROTOCOL", "Control-plane MCP message contains stale routing claims.");
      }
      return;
    }
    if (
      message.tenantId !== claims.tenantId
      || message.edgeNodeId !== claims.edgeNodeId
      || message.connectionGeneration !== claims.connectionGeneration
    ) {
      throw edgeError("EDGE_PROTOCOL", "Control-plane message contains stale routing claims.");
    }
  }

  private send(message: EdgeAgentMessage): Promise<void> {
    return this.requireConnection().send(message);
  }

  private requireConnection(): EdgeRuntimeConnection {
    if (!this.connection) throw edgeError("EDGE_UNAVAILABLE", "Edge runtime is not connected.");
    return this.connection;
  }
}
