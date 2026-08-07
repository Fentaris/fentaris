import {
  edgeError,
  normalizeInstallationReadiness,
  validateInstallationRecipe,
  validateLaunchRecipe,
  validateSetupSchema,
  type EdgeAgentMessage,
  type EdgeCapabilityManifestMessage,
  type EdgeControlPlaneMessage,
  type EdgeDesiredStateMessage,
  type EdgeProtocolClaims,
  type EdgeProtocolVersion,
  type EdgeReadinessReport,
  type EdgeCapacitySnapshot,
  type EdgeLoadSnapshot,
  type EdgeInstallationControlMessage,
  type EdgeInstallationStatusMessage,
  type InstallationLifecycleSummary,
} from "@fentaris/core";
import type { InstallationCoordinator } from "./installation.js";
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
  readonly protocolVersion: EdgeProtocolVersion;
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
  installationControl?(): EdgeInstallationLocalControl | undefined;
}

export interface EdgeAgentRuntimeOptions {
  readonly setup: LocalSetupManager;
  readonly supervisor: EdgeWorkloadSupervisor;
  readonly installation?: InstallationCoordinator;
}

export interface EdgeInstallationLocalControl {
  status(parameters: Readonly<Record<string, unknown>>): Promise<unknown>;
  review(parameters: Readonly<Record<string, unknown>>): Promise<unknown>;
  approve(parameters: Readonly<Record<string, unknown>>): Promise<unknown>;
  deny(parameters: Readonly<Record<string, unknown>>): Promise<unknown>;
  retry(parameters: Readonly<Record<string, unknown>>): Promise<unknown>;
  revoke(parameters: Readonly<Record<string, unknown>>): Promise<unknown>;
  cleanup(parameters: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/**
 * Reconciles cloud desired state and bridges correlated MCP traffic to the
 * locally governed workload supervisor.
 */
export class EdgeAgentRuntime implements EdgeConnectionRuntime {
  private connection?: EdgeRuntimeConnection;
  private desiredVersion = 0;
  private reconcileQueue = Promise.resolve();
  private statuses = new Map<string, EdgeReadinessReport>();
  private currentDesired?: EdgeDesiredStateMessage;

  constructor(private readonly options: EdgeAgentRuntimeOptions) {}

  async connected(connection: EdgeRuntimeConnection): Promise<void> {
    this.connection = connection;
    await this.options.installation?.recoverInterrupted();
  }

  async handle(message: Exclude<EdgeControlPlaneMessage, { kind: "edge.hello.ack" }>): Promise<void> {
    this.assertTrustedRoute(message);
    switch (message.kind) {
      case "edge.desired-state":
        await this.enqueueReconcile(message);
        return;
      case "edge.installation-control":
        await this.handleInstallationControl(message);
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
      if (status.status === "ready") readyDeployments += 1;
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
      readiness: [...this.statuses.values()]
        .sort((left, right) => left.deploymentId.localeCompare(right.deploymentId))
        .map((status) => ({ ...status, observedAt })),
    };
  }

  async reportCapabilityManifest(
    deploymentId: string,
    recipeDigest: string,
    manifest: LocalMcpCapabilityManifest,
  ): Promise<void> {
    const connection = this.requireConnection();
    const message: EdgeCapabilityManifestMessage = {
      version: connection.protocolVersion,
      kind: "edge.capability-manifest",
      ...connection.claims,
      deploymentId,
      recipeDigest,
      ...manifest,
    };
    await connection.send(message);
  }

  installationControl(): EdgeInstallationLocalControl | undefined {
    if (!this.options.installation) return undefined;
    const desiredDeployment = (parameters: Readonly<Record<string, unknown>>) => {
      const deploymentId = typeof parameters.deploymentId === "string" ? parameters.deploymentId : "";
      const deployment = this.currentDesired?.deployments.find((candidate) => candidate.deploymentId === deploymentId);
      if (!deployment?.installationRecipe || !this.currentDesired) throw edgeError("EDGE_SETUP_REQUIRED", "Managed installation deployment is unavailable.");
      return { deployment, desired: this.currentDesired };
    };
    const reconcileAfterDecision = async (parameters: Readonly<Record<string, unknown>>, decision: "approved" | "denied" | "revoked") => {
      const { deployment, desired } = desiredDeployment(parameters);
      const result = await this.options.installation!.decide(deployment.installationRecipe!, decision, parameters.localPolicy ?? {});
      if (decision !== "approved") await this.options.supervisor.blockDeployment(deployment.deploymentId);
      await this.enqueueReconcile(desired);
      return result;
    };
    return {
      status: async (parameters) => {
        if (typeof parameters.deploymentId === "string") return this.options.installation!.status(parameters.deploymentId);
        return this.presenceSnapshot();
      },
      review: async (parameters) => {
        const { deployment } = desiredDeployment(parameters);
        return this.options.installation!.review(deployment.installationRecipe!, parameters.localPolicy ?? {}, parameters.cleanup === true);
      },
      approve: (parameters) => reconcileAfterDecision(parameters, "approved"),
      deny: (parameters) => reconcileAfterDecision(parameters, "denied"),
      revoke: (parameters) => reconcileAfterDecision(parameters, "revoked"),
      retry: async (parameters) => {
        const { deployment, desired } = desiredDeployment(parameters);
        return this.options.installation!.reconcile({ deploymentId: deployment.deploymentId, desiredVersion: desired.desiredVersion, launchDigest: deployment.recipe.digest, recipe: deployment.installationRecipe!, explicitRetry: true });
      },
      cleanup: async (parameters) => {
        const { deployment } = desiredDeployment(parameters);
        await this.options.supervisor.blockDeployment(deployment.deploymentId);
        return this.options.installation!.remove(deployment.deploymentId, deployment.installationRecipe!, parameters.approveCleanup === true);
      },
    };
  }

  private async reconcile(message: EdgeDesiredStateMessage): Promise<void> {
    if (message.desiredVersion < this.desiredVersion) {
      throw edgeError("EDGE_PROTOCOL", "Received stale edge desired state.", {
        details: { received: message.desiredVersion, current: this.desiredVersion },
      });
    }
    const connection = this.requireConnection();
    const installationStates = new Map<string, InstallationLifecycleSummary>();
    const blocked = new Map<string, EdgeReadinessReport>();
    const deployments = [];
    for (const deployment of message.deployments) {
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
      if (deployment.requiresAgentUpgrade || (deployment.installationRecipe && (connection.protocolVersion < 3 || !this.options.installation))) {
        blocked.set(deployment.deploymentId, {
          deploymentId: deployment.deploymentId,
          status: "blocked",
          desiredVersion: message.desiredVersion,
          launchDigest: recipe.digest,
          installationDigest: deployment.installationDigest,
          reasonCode: "agent-upgrade-required",
          retryable: false,
          observedAt: Date.now(),
        });
        continue;
      }
      if (deployment.installationRecipe && this.options.installation) {
        const installationRecipe = validateInstallationRecipe(deployment.installationRecipe);
        const lifecycle = await this.options.installation.reconcile({
          deploymentId: deployment.deploymentId,
          desiredVersion: message.desiredVersion,
          launchDigest: recipe.digest,
          recipe: installationRecipe,
        });
        installationStates.set(deployment.deploymentId, lifecycle);
        await this.reportInstallation(lifecycle);
        if (lifecycle.state !== "installed" && lifecycle.state !== "ready") {
          blocked.set(deployment.deploymentId, {
            deploymentId: deployment.deploymentId,
            status: normalizeInstallationReadiness(lifecycle.state),
            desiredVersion: lifecycle.desiredVersion,
            launchDigest: lifecycle.launchDigest,
            installationDigest: lifecycle.recipeDigest,
            installationState: lifecycle.state,
            reasonCode: lifecycle.reasonCode,
            retryable: lifecycle.attempt?.retryable ?? false,
            attemptId: lifecycle.attempt?.attemptId,
            observedAt: lifecycle.observedAt,
          });
          continue;
        }
      }
      deployments.push({
        requirement: {
          deploymentId: deployment.deploymentId,
          desiredStateVersion: message.desiredVersion,
          recipe,
          schema: deployment.setupSchema,
        },
      });
    }
    const results = await this.options.supervisor.reconcile(deployments);
    this.desiredVersion = message.desiredVersion;
    this.currentDesired = message;
    const statuses = new Map(blocked);
    for (const result of results.filter((candidate) => candidate.status !== "removed")) {
      const lifecycle = installationStates.get(result.deploymentId);
      statuses.set(result.deploymentId, {
        deploymentId: result.deploymentId,
        status: result.status === "ready" ? "ready" : "setup-required",
        desiredVersion: message.desiredVersion,
        ...(lifecycle ? {
          installationDigest: lifecycle.recipeDigest,
          launchDigest: lifecycle.launchDigest,
          installationState: lifecycle.state,
        } : {}),
        observedAt: Date.now(),
      });
    }
    this.statuses = statuses;

    await connection.publishPresence?.();
    for (const deployment of message.deployments) {
      const state = await this.options.setup.status(deployment.deploymentId);
      if (!state) continue;
      await connection.send({
        version: connection.protocolVersion,
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
      .map((result) => result.deploymentId)
      .concat([...blocked.keys()]);
    await connection.send({
      version: connection.protocolVersion,
      kind: "edge.desired-state.ack",
      ...connection.claims,
      desiredVersion: message.desiredVersion,
      status: blockedDeploymentIds.length === 0 ? "applied" : "blocked",
      ...(blockedDeploymentIds.length > 0 ? { blockedDeploymentIds } : {}),
      deploymentDigests: Object.fromEntries(message.deployments.map((deployment) => [deployment.deploymentId, {
        launchDigest: deployment.recipe.digest,
        ...(deployment.installationDigest ? { installationDigest: deployment.installationDigest } : {}),
      }])),
    });
  }

  private async reportInstallation(lifecycle: InstallationLifecycleSummary): Promise<void> {
    const connection = this.requireConnection();
    if (connection.protocolVersion < 3) return;
    const message: EdgeInstallationStatusMessage = {
      version: 3,
      kind: "edge.installation-status",
      ...connection.claims,
      deploymentId: lifecycle.deploymentId,
      desiredVersion: lifecycle.desiredVersion,
      installationDigest: lifecycle.recipeDigest,
      launchDigest: lifecycle.launchDigest,
      state: lifecycle.state,
      reasonCode: lifecycle.reasonCode,
      retryable: lifecycle.attempt?.retryable ?? false,
      attemptId: lifecycle.attempt?.attemptId,
      attemptStartedAt: lifecycle.attempt?.startedAt,
      observedAt: lifecycle.observedAt,
      nextAction: lifecycle.nextAction,
    };
    await connection.send(message);
  }

  private async handleInstallationControl(message: EdgeInstallationControlMessage): Promise<void> {
    const desired = this.currentDesired;
    const deployment = desired?.deployments.find((candidate) => candidate.deploymentId === message.deploymentId);
    if (!desired || !deployment?.installationRecipe || deployment.installationDigest !== message.installationDigest
      || desired.desiredVersion !== message.desiredVersion || !this.options.installation) {
      throw edgeError("EDGE_PROTOCOL", "Installation control does not match current authorized desired state.");
    }
    if (message.action === "retry") {
      await this.options.installation.reconcile({
        deploymentId: deployment.deploymentId,
        desiredVersion: desired.desiredVersion,
        launchDigest: deployment.recipe.digest,
        recipe: deployment.installationRecipe,
        explicitRetry: true,
      });
      await this.enqueueReconcile(desired);
      return;
    }
    await this.options.supervisor.blockDeployment(deployment.deploymentId);
    const lifecycle = await this.options.installation.remove(deployment.deploymentId, deployment.installationRecipe);
    await this.reportInstallation(lifecycle);
    this.statuses.set(deployment.deploymentId, {
      deploymentId: deployment.deploymentId,
      status: "unavailable",
      desiredVersion: desired.desiredVersion,
      installationDigest: deployment.installationDigest,
      launchDigest: deployment.recipe.digest,
      installationState: lifecycle.state,
      observedAt: lifecycle.observedAt,
    });
    await this.requireConnection().publishPresence?.();
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
