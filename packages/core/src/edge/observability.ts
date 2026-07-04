import { health, type HealthBuilder, type HealthStatus } from "../health/index.js";

export type EdgeRuntimeEventName =
  | "edge.target.resolved"
  | "edge.session.bound"
  | "edge.connection.generation"
  | "edge.desired.reconciled"
  | "edge.setup.transition"
  | "edge.workload.lifecycle"
  | "edge.request.started"
  | "edge.request.completed"
  | "edge.request.timeout"
  | "edge.request.cancelled"
  | "edge.request.failed";

export interface EdgeRuntimeEvent {
  readonly name: EdgeRuntimeEventName;
  readonly occurredAt: number;
  readonly durationMs?: number;
  readonly subjectId?: string;
  readonly tenantId?: string;
  readonly targetName?: string;
  readonly deploymentId?: string;
  readonly edgeNodeId?: string;
  readonly connectionGeneration?: number;
  readonly downstreamSessionId?: string;
  readonly requestId?: string;
  readonly outcome?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EdgeTelemetrySink {
  emit(event: EdgeRuntimeEvent): void | Promise<void>;
}

/** Structured edge telemetry emitter with mandatory protocol/local-data redaction. */
export class EdgeTelemetry {
  constructor(
    private readonly sink: EdgeTelemetrySink,
    private readonly now: () => number = Date.now,
  ) {}

  async emit(event: Omit<EdgeRuntimeEvent, "occurredAt"> & { occurredAt?: number }): Promise<void> {
    await this.sink.emit(redactEdgeProtocolValue({
      ...event,
      occurredAt: event.occurredAt ?? this.now(),
    }) as unknown as EdgeRuntimeEvent);
  }
}

export interface EdgeHealthProbeResult {
  readonly status: HealthStatus;
  readonly message?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface EdgeHealthOptions {
  readonly gateway?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly targetResolution?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly deviceAvailability?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly deploymentReadiness?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly capabilityCache?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly timeoutMs?: number;
}

/** Build standard edge health checks using existing Fentaris health primitives. */
export function edgeHealth(options: EdgeHealthOptions): HealthBuilder {
  const builder = health({ timeoutMs: options.timeoutMs });
  addProbe(builder, "edge.gateway", options.gateway);
  addProbe(builder, "edge.target-resolution", options.targetResolution);
  addProbe(builder, "edge.device-availability", options.deviceAvailability);
  addProbe(builder, "edge.deployment-readiness", options.deploymentReadiness);
  addProbe(builder, "edge.capability-cache", options.capabilityCache);
  return builder;
}

/** Redact edge credentials, local paths, secrets, environments, and auth fields. */
export function redactEdgeProtocolValue(value: unknown, key = ""): unknown {
  if (/authorization|credential|privateKey|secret|token|environment|env|canonicalPath|localPath/i.test(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((entry) => redactEdgeProtocolValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, child]) => [
        entryKey,
        redactEdgeProtocolValue(child, entryKey),
      ]),
    );
  }
  if (typeof value === "string" && looksLikePrivatePath(value)) return "[REDACTED_PATH]";
  return value;
}

function addProbe(
  builder: HealthBuilder,
  name: string,
  probe: (() => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>) | undefined,
): void {
  if (!probe) return;
  builder.check(name, async () => {
    const result = await probe();
    return {
      status: result.status,
      message: result.message,
      metadata: redactEdgeProtocolValue(result.metadata) as Record<string, unknown> | undefined,
    };
  });
}

function looksLikePrivatePath(value: string): boolean {
  return value.startsWith("/Users/")
    || value.startsWith("/home/")
    || value.startsWith("/private/")
    || /^[A-Za-z]:\\Users\\/.test(value);
}
