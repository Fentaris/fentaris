import type { Logger } from "../logging/index.js";
import type { ProxyOperation } from "../types/mcp-operation.js";

export type RuntimeEventCategory =
  | "lifecycle"
  | "health"
  | "mcp"
  | "policy"
  | "transport"
  | "extension"
  | "errors"
  | "timeouts"
  | "profiler";

export type RuntimeEventLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type RuntimeEventDimensions = {
  server?: string;
  group?: string;
  user?: string;
  operation?: string;
  durationMs?: number;
};

export type RuntimeEventBase<Name extends string, Category extends RuntimeEventCategory, Level extends RuntimeEventLevel> =
  RuntimeEventDimensions & {
    name: Name;
    category: Category;
    level: Level;
    timestamp: Date;
    message?: string;
    metadata?: Record<string, unknown>;
  };

export type RuntimeLifecycleEvent =
  | (RuntimeEventBase<"runtime.start", "lifecycle", "info"> & { runtime: string; version: string })
  | (RuntimeEventBase<"runtime.ready", "lifecycle", "info"> & { runtime: string; version: string; startupMs: number })
  | (RuntimeEventBase<"runtime.degraded", "lifecycle", "warn"> & { component: string; reason: string })
  | (RuntimeEventBase<"runtime.stop", "lifecycle", "info"> & { runtime: string; durationMs?: number })
  | (RuntimeEventBase<"runtime.error", "errors", "error" | "fatal"> & { error: RuntimeProfilerErrorPayload });

export type RuntimeMcpEvent =
  | (RuntimeEventBase<"mcp.call.start", "mcp", "debug" | "info"> & { operation: ProxyOperation; target?: string; arguments?: unknown })
  | (RuntimeEventBase<"mcp.call.success", "mcp", "debug" | "info" | "warn"> & { operation: ProxyOperation; target?: string; result?: unknown })
  | (RuntimeEventBase<"mcp.call.error", "errors", "error"> & { operation: ProxyOperation; target?: string; error: RuntimeProfilerErrorPayload })
  | (RuntimeEventBase<"mcp.call.timeout", "timeouts", "warn" | "error"> & { operation: ProxyOperation; timeoutMs: number; durationMs: number; error: RuntimeProfilerErrorPayload });

export type RuntimePolicyEvent = RuntimeEventBase<"policy.allowed" | "policy.denied", "policy", "info" | "warn"> & {
  allowed: boolean;
  reason?: string;
  matchedGroups?: string[];
  matchedPermissions?: unknown[];
};

export type RuntimeTransportEvent = RuntimeEventBase<"transport.error", "transport" | "errors", "error"> & {
  transport?: string;
  sessionId?: string;
  requestId?: string;
  error: RuntimeProfilerErrorPayload;
};

export type RuntimeHealthEvent =
  | (RuntimeEventBase<"health.check.start", "health", "debug" | "info"> & { target: string; timeoutMs?: number })
  | (RuntimeEventBase<"health.check.success", "health", "debug" | "info" | "warn"> & { target: string; status: string })
  | (RuntimeEventBase<"health.check.error", "health", "error"> & { target: string; status: string; error: RuntimeProfilerErrorPayload })
  | (RuntimeEventBase<"health.check.timeout", "timeouts", "warn" | "error"> & { target: string; status: string; error: RuntimeProfilerErrorPayload })
  | (RuntimeEventBase<"health.status", "health", "info" | "warn" | "error"> & { status: string });

export type RuntimeExtensionEvent = RuntimeEventBase<"extension.error", "extension" | "errors", "error"> & {
  boundary: "hook" | "middleware" | "route" | "sink" | "extension";
  error: RuntimeProfilerErrorPayload;
};

export type RuntimeProfilerEvent = RuntimeEventBase<"profiler.sink.error", "profiler" | "errors", "error"> & {
  sink?: string;
  error: RuntimeProfilerErrorPayload;
};

export type RuntimeProfilerErrorPayload = {
  name: string;
  code: string;
  message: string;
  severity: RuntimeEventLevel;
  hints: string[];
  context: Record<string, unknown>;
  cause?: RuntimeProfilerErrorPayload | { name: string; message: string };
};

export type RuntimeEventMap = {
  "runtime.start": Extract<RuntimeLifecycleEvent, { name: "runtime.start" }>;
  "runtime.ready": Extract<RuntimeLifecycleEvent, { name: "runtime.ready" }>;
  "runtime.degraded": Extract<RuntimeLifecycleEvent, { name: "runtime.degraded" }>;
  "runtime.stop": Extract<RuntimeLifecycleEvent, { name: "runtime.stop" }>;
  "runtime.error": Extract<RuntimeLifecycleEvent, { name: "runtime.error" }>;
  "mcp.call.start": Extract<RuntimeMcpEvent, { name: "mcp.call.start" }>;
  "mcp.call.success": Extract<RuntimeMcpEvent, { name: "mcp.call.success" }>;
  "mcp.call.error": Extract<RuntimeMcpEvent, { name: "mcp.call.error" }>;
  "mcp.call.timeout": Extract<RuntimeMcpEvent, { name: "mcp.call.timeout" }>;
  "policy.allowed": RuntimePolicyEvent & { name: "policy.allowed" };
  "policy.denied": RuntimePolicyEvent & { name: "policy.denied" };
  "transport.error": RuntimeTransportEvent;
  "health.check.start": Extract<RuntimeHealthEvent, { name: "health.check.start" }>;
  "health.check.success": Extract<RuntimeHealthEvent, { name: "health.check.success" }>;
  "health.check.error": Extract<RuntimeHealthEvent, { name: "health.check.error" }>;
  "health.check.timeout": Extract<RuntimeHealthEvent, { name: "health.check.timeout" }>;
  "health.status": Extract<RuntimeHealthEvent, { name: "health.status" }>;
  "extension.error": RuntimeExtensionEvent;
  "profiler.sink.error": RuntimeProfilerEvent;
};

export type RuntimeEventName = keyof RuntimeEventMap;
export type RuntimeEvent<N extends RuntimeEventName = RuntimeEventName> = N extends RuntimeEventName ? RuntimeEventMap[N] : never;
export type RuntimeEventHandler<N extends RuntimeEventName = RuntimeEventName> = (event: RuntimeEvent<N>) => void | Promise<void>;

export type ProfilerTrack = RuntimeEventCategory;

export type ProfilerFilter = {
  category?: ProfilerTrack | ProfilerTrack[];
  level?: RuntimeEventLevel;
  server?: string | string[];
  group?: string | string[];
  user?: string | string[];
  operation?: string | string[];
  minDurationMs?: number;
};

export type ProfilerHandlerOptions = {
  where?: ProfilerFilter;
};

export type ProfilerSink = {
  name?: string;
  write(event: RuntimeEvent): void | Promise<void>;
};

export type ProfilerFunctionSink = (event: RuntimeEvent) => void | Promise<void>;

export type ProfilerPrettySinkOptions = {
  writer?: (line: string) => void;
};

export type LoggerSinkOptions = {
  logger: Logger;
};

export type ProfilerSinkLike = ProfilerSink | ProfilerFunctionSink;
