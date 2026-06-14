import { FentarisRuntimeError, FentarisTimeoutError, runtimeErrorToEventPayload, createRuntimeEvent } from "../profiler/index.js";
import { timeoutAfter, type RuntimeLifecycleSnapshot } from "../lifecycle/index.js";
import type { Group } from "../governance/index.js";
import type { McpServer } from "../server/index.js";
import type { RuntimeEvent } from "../profiler/index.js";

export type HealthStatus = "ok" | "degraded" | "down" | "unknown";
export type HealthIncludeCategory = "runtime" | "mcp" | "transport" | "groups";

export type HealthCheckResult = {
  name: string;
  status: HealthStatus;
  message?: string;
  durationMs: number;
  checkedAt: Date;
  metadata?: Record<string, unknown>;
  error?: ReturnType<typeof runtimeErrorToEventPayload>;
};

export type HealthReport = {
  status: HealthStatus;
  checkedAt: Date;
  durationMs: number;
  checks: HealthCheckResult[];
  metadata?: Record<string, unknown>;
};

export type HealthCheckHandler = (ctx: HealthCheckContext) =>
  | HealthStatus
  | Partial<HealthCheckResult>
  | Promise<HealthStatus | Partial<HealthCheckResult>>;

export type HealthBuilderOptions = {
  checks?: boolean;
  include?: HealthIncludeCategory[];
  timeoutMs?: number;
};

export type HealthConfig = boolean | HealthBuilder | (HealthBuilderOptions & {
  custom?: Array<{ name: string; handler: HealthCheckHandler; timeoutMs?: number }>;
});

export type NormalizedHealthCheck = {
  name: string;
  handler: HealthCheckHandler;
  timeoutMs: number;
};

export type NormalizedHealthConfig = {
  checks: boolean;
  include: HealthIncludeCategory[];
  timeoutMs: number;
  custom: NormalizedHealthCheck[];
};

export type HealthCheckState = {
  lifecycle: RuntimeLifecycleSnapshot;
  servers: McpServer[];
  groups: Group[];
  exposureCount: number;
  policy?: unknown;
  auth?: unknown;
  identityRequired: boolean;
};

export type HealthRuntimeContext = {
  state(): RuntimeLifecycleSnapshot;
};

export type HealthServerContext = {
  readonly name: string;
  state(): HealthCheckResult;
  ping(): Promise<HealthCheckResult>;
  health(): Promise<HealthCheckResult>;
};

export type HealthGroupContext = {
  readonly id: string;
  servers(): Array<{ name: string; displayName: string }>;
};

export type HealthTransportContext = {
  state(): HealthCheckResult;
};

export type HealthCheckContext = {
  runtime: HealthRuntimeContext;
  mcp(name: string): HealthServerContext;
  group(id: string): HealthGroupContext;
  transport(nameOrType?: string): HealthTransportContext;
  policy: { state(): HealthCheckResult };
  auth: { state(): HealthCheckResult };
  identity: { state(): HealthCheckResult };
};

export type RunHealthChecksOptions = {
  config: NormalizedHealthConfig;
  state: HealthCheckState;
  emitRuntimeEvent?: (event: RuntimeEvent) => Promise<void>;
};

export class HealthBuilder {
  private readonly customChecks: NormalizedHealthCheck[] = [];
  private enabled = true;
  private included: HealthIncludeCategory[] = ["runtime"];
  private defaultTimeoutMs = 5_000;

  checks(enabled = true): this {
    this.enabled = enabled;
    return this;
  }

  include(categories: HealthIncludeCategory[]): this {
    this.included = [...categories];
    return this;
  }

  timeout(ms: number): this {
    this.defaultTimeoutMs = normalizeHealthTimeout(ms);
    return this;
  }

  check(name: string, handler: HealthCheckHandler, options: { timeoutMs?: number } = {}): this {
    this.customChecks.push({
      name: normalizeCheckName(name),
      handler,
      timeoutMs: normalizeHealthTimeout(options.timeoutMs ?? this.defaultTimeoutMs),
    });
    return this;
  }

  toConfig(): NormalizedHealthConfig {
    return {
      checks: this.enabled,
      include: [...this.included],
      timeoutMs: this.defaultTimeoutMs,
      custom: [...this.customChecks],
    };
  }
}

export function health(options: HealthBuilderOptions = {}): HealthBuilder {
  const builder = new HealthBuilder();
  if (options.checks !== undefined) {
    builder.checks(options.checks);
  }
  if (options.include) {
    builder.include(options.include);
  }
  if (options.timeoutMs !== undefined) {
    builder.timeout(options.timeoutMs);
  }
  return builder;
}

export function normalizeHealthConfig(config: HealthConfig | undefined): NormalizedHealthConfig {
  if (config instanceof HealthBuilder) {
    return config.toConfig();
  }

  if (config === false) {
    return { checks: false, include: [], timeoutMs: 5_000, custom: [] };
  }

  if (config === true || config === undefined) {
    return { checks: true, include: ["runtime"], timeoutMs: 5_000, custom: [] };
  }

  const timeoutMs = normalizeHealthTimeout(config.timeoutMs ?? 5_000);
  return {
    checks: config.checks ?? true,
    include: [...(config.include ?? ["runtime"])],
    timeoutMs,
    custom: (config.custom ?? []).map((check) => ({
      name: normalizeCheckName(check.name),
      handler: check.handler,
      timeoutMs: normalizeHealthTimeout(check.timeoutMs ?? timeoutMs),
    })),
  };
}

export function createHealthContext(state: HealthCheckState): HealthCheckContext {
  const serverByName = new Map(state.servers.map((server) => [server.name, server]));
  const groupById = new Map(state.groups.map((group) => [group.id, group]));

  return {
    runtime: {
      state: () => cloneLifecycle(state.lifecycle),
    },
    mcp(name) {
      const server = serverByName.get(name);
      return {
        name,
        state() {
          const checkedAt = new Date();
          return {
            name: `mcp.${name}.state`,
            status: server ? "ok" : "unknown",
            message: server ? "Server is configured" : `Server "${name}" is not configured`,
            checkedAt,
            durationMs: 0,
            metadata: server ? { name: server.name, displayName: server.displayName } : { name },
          };
        },
        async ping() {
          const checkedAt = new Date();
          const startedAt = Date.now();
          if (!server) {
            return {
              name: `mcp.${name}.ping`,
              status: "unknown",
              message: `Server "${name}" is not configured`,
              checkedAt,
              durationMs: Date.now() - startedAt,
              metadata: { name },
            };
          }

          try {
            await server.listTools();
            return {
              name: `mcp.${name}.ping`,
              status: "ok",
              message: "Server ping succeeded",
              checkedAt,
              durationMs: Date.now() - startedAt,
              metadata: { name: server.name, displayName: server.displayName },
            };
          } catch (error) {
            return {
              name: `mcp.${name}.ping`,
              status: "degraded",
              message: "Server ping failed",
              checkedAt,
              durationMs: Date.now() - startedAt,
              metadata: { name: server.name, displayName: server.displayName },
              error: runtimeErrorToEventPayload(error),
            };
          }
        },
        health() {
          return this.ping();
        },
      };
    },
    group(id) {
      const group = groupById.get(id);
      return {
        id,
        servers() {
          return (group?.servers ?? []).map((server) => ({
            name: server.name,
            displayName: server.displayName,
          }));
        },
      };
    },
    transport(nameOrType = "exposure") {
      return {
        state() {
          return {
            name: `transport.${nameOrType}.state`,
            status: state.exposureCount > 0 ? "ok" : "unknown",
            message: state.exposureCount > 0 ? "Exposure transport is active" : "No exposure transport is active",
            checkedAt: new Date(),
            durationMs: 0,
            metadata: { exposureCount: state.exposureCount },
          };
        },
      };
    },
    policy: {
      state: () => staticInspection("policy", Boolean(state.policy), state.policy ? "Policy is configured" : "Policy is not configured"),
    },
    auth: {
      state: () => staticInspection("auth", Boolean(state.auth), state.auth ? "Auth is configured" : "Auth is not configured"),
    },
    identity: {
      state: () => staticInspection("identity", state.identityRequired, state.identityRequired ? "Identity is required" : "Identity is optional"),
    },
  };
}

export async function runHealthChecks(options: RunHealthChecksOptions): Promise<HealthReport> {
  const startedAt = Date.now();
  const checkedAt = new Date();
  if (!options.config.checks) {
    return {
      status: "unknown",
      checkedAt,
      durationMs: Date.now() - startedAt,
      checks: [],
      metadata: { disabled: true },
    };
  }

  const ctx = createHealthContext(options.state);
  const checks = [
    ...builtInChecks(options.config.include, options.state),
    ...options.config.custom,
  ];
  const results: HealthCheckResult[] = [];

  for (const check of checks) {
    const checkStartedAt = Date.now();
    await options.emitRuntimeEvent?.(createRuntimeEvent({
      name: "health.check.start",
      category: "health",
      level: "debug",
      operation: "health:check",
      target: check.name,
      timeoutMs: check.timeoutMs,
      message: "Health check started",
    }));

    try {
      const raw = await timeoutAfter(Promise.resolve(check.handler(ctx)), check.timeoutMs, "Health check timed out", "health");
      const result = normalizeHealthResult(check.name, raw, checkStartedAt);
      results.push(result);
      await options.emitRuntimeEvent?.(createRuntimeEvent({
        name: "health.check.success",
        category: "health",
        level: result.status === "ok" ? "debug" : "warn",
        operation: "health:check",
        target: check.name,
        status: result.status,
        durationMs: result.durationMs,
        message: "Health check completed",
      }));
    } catch (error) {
      const timeout = error instanceof FentarisTimeoutError;
      const result: HealthCheckResult = {
        name: check.name,
        status: timeout ? "down" : "degraded",
        message: timeout ? "Health check timed out" : "Health check failed",
        checkedAt: new Date(),
        durationMs: Date.now() - checkStartedAt,
        error: runtimeErrorToEventPayload(error),
      };
      results.push(result);
      await options.emitRuntimeEvent?.(createRuntimeEvent({
        name: timeout ? "health.check.timeout" : "health.check.error",
        category: timeout ? "timeouts" : "health",
        level: timeout ? "warn" : "error",
        operation: "health:check",
        target: check.name,
        status: result.status,
        durationMs: result.durationMs,
        error: result.error,
        message: result.message,
      }));
    }
  }

  const status = aggregateHealthStatus(results);
  const report = {
    status,
    checkedAt,
    durationMs: Date.now() - startedAt,
    checks: results,
    metadata: {
      state: options.state.lifecycle.state,
      checkCount: results.length,
    },
  };
  await options.emitRuntimeEvent?.(createRuntimeEvent({
    name: "health.status",
    category: "health",
    level: status === "ok" ? "info" : status === "unknown" ? "warn" : "error",
    operation: "health:report",
    status,
    durationMs: report.durationMs,
    metadata: {
      checkCount: results.length,
      down: results.filter((check) => check.status === "down").length,
      degraded: results.filter((check) => check.status === "degraded").length,
      unknown: results.filter((check) => check.status === "unknown").length,
    },
    message: "Runtime health report completed",
  }));
  return report;
}

export function normalizeHealthResult(name: string, result: HealthStatus | Partial<HealthCheckResult>, startedAt: number): HealthCheckResult {
  const checkedAt = new Date();
  if (typeof result === "string") {
    return {
      name,
      status: result,
      checkedAt,
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    name,
    status: result.status ?? "unknown",
    message: result.message,
    checkedAt: result.checkedAt ?? checkedAt,
    durationMs: result.durationMs ?? Date.now() - startedAt,
    metadata: result.name && result.name !== name ? { ...result.metadata, sourceName: result.name } : result.metadata,
    error: result.error,
  };
}

export function aggregateHealthStatus(results: HealthCheckResult[]): HealthStatus {
  if (results.length === 0) {
    return "unknown";
  }
  if (results.some((result) => result.status === "down")) {
    return "down";
  }
  if (results.some((result) => result.status === "degraded")) {
    return "degraded";
  }
  if (results.every((result) => result.status === "unknown")) {
    return "unknown";
  }
  if (results.some((result) => result.status === "unknown")) {
    return "degraded";
  }
  return "ok";
}

function builtInChecks(include: HealthIncludeCategory[], state: HealthCheckState): NormalizedHealthCheck[] {
  const checks: NormalizedHealthCheck[] = [];
  if (include.includes("runtime")) {
    checks.push({
      name: "runtime.lifecycle",
      timeoutMs: 5_000,
      handler: (ctx) => {
        const snapshot = ctx.runtime.state();
        const status: HealthStatus =
          snapshot.state === "ready" ? "ok"
          : snapshot.state === "degraded" ? "degraded"
          : snapshot.state === "failed" ? "down"
          : "unknown";
        return {
          status,
          message: `Runtime state is ${snapshot.state}`,
          metadata: { state: snapshot.state, ...safeLifecycleMetadata(snapshot.metadata) },
        };
      },
    });
  }
  if (include.includes("mcp")) {
    for (const server of state.servers) {
      checks.push({
        name: `mcp.${server.name}.availability`,
        timeoutMs: 5_000,
        handler: (ctx) => ctx.mcp(server.name).state(),
      });
    }
    if (state.servers.length === 0) {
      checks.push({
        name: "mcp.servers",
        timeoutMs: 5_000,
        handler: () => ({ status: "unknown", message: "No MCP servers are configured" }),
      });
    }
    checks.push({
      name: "mcp.catalog",
      timeoutMs: 5_000,
      handler: async (ctx) => {
        const runtimeState = ctx.runtime.state();
        return {
          status: runtimeState.state === "failed" ? "down" : "ok",
          message: "MCP server catalog is inspectable",
          metadata: { runtimeState: runtimeState.state },
        };
      },
    });
  }
  if (include.includes("transport")) {
    checks.push({
      name: "transport.exposure",
      timeoutMs: 5_000,
      handler: (ctx) => ctx.transport("exposure").state(),
    });
  }
  if (include.includes("groups")) {
    for (const group of state.groups) {
      checks.push({
        name: `group.${group.id}.visibility`,
        timeoutMs: 5_000,
        handler: (ctx) => ({
          status: "ok",
          message: "Group-scoped server visibility is inspectable",
          metadata: { servers: ctx.group(group.id).servers() },
        }),
      });
    }
    if (state.groups.length === 0) {
      checks.push({
        name: "groups.visibility",
        timeoutMs: 5_000,
        handler: () => ({ status: "unknown", message: "No groups are configured" }),
      });
    }
  }
  return checks;
}

function staticInspection(name: string, present: boolean, message: string): HealthCheckResult {
  return {
    name: `${name}.state`,
    status: present ? "ok" : "unknown",
    message,
    checkedAt: new Date(),
    durationMs: 0,
  };
}

function cloneLifecycle(snapshot: RuntimeLifecycleSnapshot): RuntimeLifecycleSnapshot {
  return {
    state: snapshot.state,
    metadata: {
      ...snapshot.metadata,
      failure: snapshot.metadata.failure ? { ...snapshot.metadata.failure } : undefined,
    },
  };
}

function safeLifecycleMetadata(metadata: RuntimeLifecycleSnapshot["metadata"]): Record<string, unknown> {
  return {
    name: metadata.name,
    version: metadata.version,
    startedAt: metadata.startedAt?.toISOString(),
    stoppedAt: metadata.stoppedAt?.toISOString(),
    lastTransitionAt: metadata.lastTransitionAt.toISOString(),
    failure: metadata.failure,
  };
}

function normalizeCheckName(name: string): string {
  if (!name.trim()) {
    throw new FentarisRuntimeError("Health check name cannot be empty", {
      code: "FENTARIS_HEALTH_INVALID_CHECK",
    });
  }
  return name;
}

function normalizeHealthTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new FentarisRuntimeError("Health check timeout must be a non-negative finite number", {
      code: "FENTARIS_HEALTH_INVALID_TIMEOUT",
      context: { timeoutMs },
    });
  }
  return timeoutMs;
}
