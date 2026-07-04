import {
  EDGE_MCP_ENVELOPE_VERSION,
  edgeError,
  isEdgeError,
  type EdgeErrorCode,
  type EdgeMcpCancelEnvelope,
  type EdgeMcpErrorEnvelope,
  type EdgeMcpOperation,
  type EdgeMcpRequestEnvelope,
  type EdgeMcpResultEnvelope,
} from "@fentaris/core";
import {
  type CompiledLocalLaunchPlan,
  type DesiredSetupRequirement,
  type LocalSetupManager,
} from "./setup.js";

export interface LocalMcpClient {
  request(operation: EdgeMcpOperation, params: unknown, signal: AbortSignal): Promise<unknown>;
  capabilityManifest?(): Promise<LocalMcpCapabilityManifest>;
}

export interface LocalMcpCapabilityManifest {
  readonly tools: readonly unknown[];
  readonly resources: readonly unknown[];
  readonly resourceTemplates: readonly unknown[];
  readonly prompts: readonly unknown[];
  readonly supportsCompletion: boolean;
}

export interface EdgeWorkload {
  readonly client: LocalMcpClient;
  stopGracefully(): Promise<void>;
  forceKill(): Promise<void>;
}

export interface EdgeWorkloadFactory {
  start(plan: CompiledLocalLaunchPlan, signal: AbortSignal): Promise<EdgeWorkload>;
}

export interface SupervisedDesiredDeployment {
  readonly requirement: DesiredSetupRequirement;
}

export interface EdgeWorkloadPolicy {
  allow(plan: CompiledLocalLaunchPlan): boolean | Promise<boolean>;
}

export interface EdgeWorkloadSupervisorOptions {
  readonly setup: LocalSetupManager;
  readonly factory: EdgeWorkloadFactory;
  readonly executablePolicy?: EdgeWorkloadPolicy;
  readonly maxConcurrentWorkloads?: number;
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly idleLeaseMs?: number;
  readonly maxOutputBytes?: number;
  readonly reportCapabilityManifest?: (
    deploymentId: string,
    recipeDigest: string,
    manifest: LocalMcpCapabilityManifest,
  ) => void | Promise<void>;
  readonly now?: () => number;
}

export interface DeploymentReconcileResult {
  readonly deploymentId: string;
  readonly status: "ready" | "blocked" | "removed";
  readonly reason?: string;
}

type WorkloadRecord = {
  readonly key: string;
  readonly deploymentId: string;
  readonly sessionId: string;
  readonly workload: EdgeWorkload;
  lastUsedAt: number;
};

/** Governed per-session MCP workload supervisor for cloud-defined deployments. */
export class EdgeWorkloadSupervisor {
  private readonly desired = new Map<string, SupervisedDesiredDeployment>();
  private readonly workloads = new Map<string, WorkloadRecord>();
  private readonly starting = new Map<string, Promise<WorkloadRecord>>();
  private readonly requests = new Map<string, AbortController>();
  private readonly locallyDenied = new Set<string>();
  private readonly blocked = new Set<string>();
  private readonly now: () => number;
  private readonly limits: Required<Pick<
    EdgeWorkloadSupervisorOptions,
    | "maxConcurrentWorkloads"
    | "startupTimeoutMs"
    | "operationTimeoutMs"
    | "shutdownTimeoutMs"
    | "idleLeaseMs"
    | "maxOutputBytes"
  >>;

  constructor(private readonly options: EdgeWorkloadSupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.limits = {
      maxConcurrentWorkloads: options.maxConcurrentWorkloads ?? 8,
      startupTimeoutMs: options.startupTimeoutMs ?? 15_000,
      operationTimeoutMs: options.operationTimeoutMs ?? 30_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
      idleLeaseMs: options.idleLeaseMs ?? 300_000,
      maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
    };
  }

  /** Reconcile only the cloud-defined desired deployment set. */
  async reconcile(deployments: readonly SupervisedDesiredDeployment[]): Promise<DeploymentReconcileResult[]> {
    const next = new Map(deployments.map((deployment) => [deployment.requirement.deploymentId, deployment]));
    const results: DeploymentReconcileResult[] = [];
    for (const deploymentId of [...this.desired.keys()]) {
      if (next.has(deploymentId)) continue;
      await this.stopDeployment(deploymentId);
      this.desired.delete(deploymentId);
      this.blocked.delete(deploymentId);
      results.push({ deploymentId, status: "removed" });
    }
    for (const deployment of deployments) {
      const deploymentId = deployment.requirement.deploymentId;
      this.desired.set(deploymentId, deployment);
      if (this.locallyDenied.has(deploymentId)) {
        this.blocked.add(deploymentId);
        await this.stopDeployment(deploymentId);
        results.push({ deploymentId, status: "blocked", reason: "local-deny" });
        continue;
      }
      const state = await this.options.setup.ingest(deployment.requirement);
      if (state.status !== "ready") {
        this.blocked.add(deploymentId);
        await this.stopDeployment(deploymentId);
        results.push({ deploymentId, status: "blocked", reason: `setup-${state.status}` });
      } else {
        this.blocked.delete(deploymentId);
        results.push({ deploymentId, status: "ready" });
      }
    }
    return results;
  }

  /** Handle one correlated edge protocol MCP request. */
  async handleRequest(request: EdgeMcpRequestEnvelope): Promise<EdgeMcpResultEnvelope | EdgeMcpErrorEnvelope> {
    try {
      const desired = this.desired.get(request.route.deploymentId);
      if (!desired || this.blocked.has(request.route.deploymentId) || this.locallyDenied.has(request.route.deploymentId)) {
        throw edgeError("EDGE_SETUP_REQUIRED", "Edge deployment is not locally ready.", {
          details: { deploymentId: request.route.deploymentId },
        });
      }
      if (request.deadline <= this.now()) {
        throw edgeError("EDGE_WORKLOAD", "Edge MCP request deadline already expired.");
      }
      const workload = await this.workloadFor(
        request.route.deploymentId,
        request.route.downstreamSessionId,
        desired.requirement,
      );
      workload.lastUsedAt = this.now();
      const controller = new AbortController();
      this.requests.set(request.requestId, controller);
      const deadlineMs = Math.max(
        1,
        Math.min(this.limits.operationTimeoutMs, request.deadline - this.now()),
      );
      try {
        const result = await withTimeout(
          workload.workload.client.request(request.operation, request.params, controller.signal),
          deadlineMs,
          () => controller.abort(),
          "Edge MCP operation timed out",
        );
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (bytes > this.limits.maxOutputBytes) {
          throw edgeError("EDGE_CAPACITY", "Edge MCP result exceeds the configured output limit.", {
            details: { bytes, limit: this.limits.maxOutputBytes },
          });
        }
        return {
          version: EDGE_MCP_ENVELOPE_VERSION,
          kind: "mcp.result",
          requestId: request.requestId,
          operation: request.operation,
          route: request.route,
          result,
        };
      } finally {
        this.requests.delete(request.requestId);
        workload.lastUsedAt = this.now();
      }
    } catch (error) {
      return errorEnvelope(request, error);
    }
  }

  /** Propagate a correlated cancellation to the local MCP client signal. */
  handleCancel(cancel: EdgeMcpCancelEnvelope): boolean {
    const controller = this.requests.get(cancel.requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Sticky local denial overrides all replayed desired state. */
  async denyDeployment(deploymentId: string): Promise<void> {
    this.locallyDenied.add(deploymentId);
    this.blocked.add(deploymentId);
    await this.stopDeployment(deploymentId);
  }

  /** Explicit local action required before a denied deployment may run again. */
  renewConsent(deploymentId: string): void {
    this.locallyDenied.delete(deploymentId);
  }

  /** Mark a deployment blocked after grant/workload revocation. */
  async blockDeployment(deploymentId: string): Promise<void> {
    this.locallyDenied.add(deploymentId);
    this.blocked.add(deploymentId);
    await this.stopDeployment(deploymentId);
  }

  async endSession(sessionId: string): Promise<void> {
    const records = [...this.workloads.values()].filter((record) => record.sessionId === sessionId);
    await Promise.all(records.map((record) => this.stopRecord(record)));
  }

  async sweepIdle(): Promise<readonly string[]> {
    const threshold = this.now() - this.limits.idleLeaseMs;
    const idle = [...this.workloads.values()].filter((record) => record.lastUsedAt <= threshold);
    await Promise.all(idle.map((record) => this.stopRecord(record)));
    return idle.map((record) => record.key);
  }

  async shutdown(): Promise<void> {
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    await Promise.all([...this.workloads.values()].map((record) => this.stopRecord(record)));
  }

  activeWorkloadCount(): number {
    return this.workloads.size;
  }

  private async workloadFor(
    deploymentId: string,
    sessionId: string,
    requirement: DesiredSetupRequirement,
  ): Promise<WorkloadRecord> {
    const key = workloadKey(deploymentId, sessionId);
    const existing = this.workloads.get(key);
    if (existing) return existing;
    const pending = this.starting.get(key);
    if (pending) return pending;
    if (this.workloads.size + this.starting.size >= this.limits.maxConcurrentWorkloads) {
      throw edgeError("EDGE_CAPACITY", "Edge workload concurrency limit reached.");
    }
    const starting = this.startWorkload(key, deploymentId, sessionId, requirement);
    this.starting.set(key, starting);
    try {
      return await starting;
    } finally {
      this.starting.delete(key);
    }
  }

  private async startWorkload(
    key: string,
    deploymentId: string,
    sessionId: string,
    requirement: DesiredSetupRequirement,
  ): Promise<WorkloadRecord> {
    const plan = await this.options.setup.compileLaunchPlan(requirement);
    if (this.options.executablePolicy && !await this.options.executablePolicy.allow(plan)) {
      throw edgeError("EDGE_WORKLOAD", "Local executable/package policy denied the launch recipe.");
    }
    const startup = new AbortController();
    const workload = await withTimeout(
      this.options.factory.start(plan, startup.signal),
      this.limits.startupTimeoutMs,
      () => startup.abort(),
      "Edge workload startup timed out",
    );
    if (workload.client.capabilityManifest && this.options.reportCapabilityManifest) {
      const manifest = await workload.client.capabilityManifest();
      await this.options.reportCapabilityManifest(deploymentId, plan.recipeDigest, manifest);
    }
    const record: WorkloadRecord = {
      key,
      deploymentId,
      sessionId,
      workload,
      lastUsedAt: this.now(),
    };
    this.workloads.set(key, record);
    return record;
  }

  private async stopDeployment(deploymentId: string): Promise<void> {
    const records = [...this.workloads.values()].filter((record) => record.deploymentId === deploymentId);
    await Promise.all(records.map((record) => this.stopRecord(record)));
  }

  private async stopRecord(record: WorkloadRecord): Promise<void> {
    if (this.workloads.get(record.key) !== record) return;
    this.workloads.delete(record.key);
    try {
      await withTimeout(
        record.workload.stopGracefully(),
        this.limits.shutdownTimeoutMs,
        undefined,
        "Edge workload graceful shutdown timed out",
      );
    } catch {
      await record.workload.forceKill();
    }
  }
}

function workloadKey(deploymentId: string, sessionId: string): string {
  return `${deploymentId}\u0000${sessionId}`;
}

function errorEnvelope(request: EdgeMcpRequestEnvelope, error: unknown): EdgeMcpErrorEnvelope {
  const code: EdgeErrorCode = isEdgeError(error) ? error.code : "EDGE_WORKLOAD";
  const message = error instanceof Error ? error.message : "Edge workload failed";
  return {
    version: EDGE_MCP_ENVELOPE_VERSION,
    kind: "mcp.error",
    requestId: request.requestId,
    operation: request.operation,
    route: request.route,
    error: {
      code,
      message,
      ...(isEdgeError(error) && error.details ? { details: error.details } : {}),
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: (() => void) | undefined,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(edgeError("EDGE_WORKLOAD", message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
