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
  | "edge.request.failed"
  | "edge.orchestration.started"
  | "edge.orchestration.child"
  | "edge.orchestration.completed"
  | "edge.orchestration.cleanup"
  | "edge.authorization.created"
  | "edge.authorization.approved"
  | "edge.authorization.denied"
  | "edge.enrollment.completed"
  | "edge.device.revoked"
  | "edge.connection.authenticated"
  | "edge.dispatch.gated";

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
  readonly inventoryStore?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly presenceExpiry?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly selectionService?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly childBindingCleanup?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly channelRouting?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly protocolDistribution?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly staleReadiness?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
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
  addProbe(builder, "edge.inventory-store", options.inventoryStore);
  addProbe(builder, "edge.presence-expiry", options.presenceExpiry);
  addProbe(builder, "edge.selection-service", options.selectionService);
  addProbe(builder, "edge.child-binding-cleanup", options.childBindingCleanup);
  addProbe(builder, "edge.channel-routing", options.channelRouting);
  addProbe(builder, "edge.protocol-distribution", options.protocolDistribution);
  addProbe(builder, "edge.stale-readiness", options.staleReadiness);
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

export interface EdgeSerializationLimits {
  readonly maxDepth?: number;
  readonly maxArrayItems?: number;
  readonly maxStringLength?: number;
  readonly maxBytes?: number;
}

/** Redact and bound an untrusted public/diagnostic value before serialization. @pk */
export function serializeEdgePublicValue(value: unknown, limits: EdgeSerializationLimits = {}): unknown {
  const maxDepth = limits.maxDepth ?? 12;
  const maxArrayItems = limits.maxArrayItems ?? 100;
  const maxStringLength = limits.maxStringLength ?? 8_192;
  const maxBytes = limits.maxBytes ?? 1_000_000;
  const seen = new WeakSet<object>();
  const visit = (input: unknown, key: string, depth: number): unknown => {
    if (/authorization|credential|privateKey|secret|token|environment|env|canonicalPath|localPath|grant/i.test(key)) return "[REDACTED]";
    if (depth > maxDepth) return "[TRUNCATED_DEPTH]";
    if (typeof input === "string") {
      const redacted = looksLikePrivatePath(input) ? "[REDACTED_PATH]" : input;
      return redacted.length > maxStringLength ? `${redacted.slice(0, maxStringLength)}[TRUNCATED]` : redacted;
    }
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return "[CIRCULAR]";
    seen.add(input);
    if (Array.isArray(input)) return input.slice(0, maxArrayItems).map((entry) => visit(entry, key, depth + 1));
    return Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .slice(0, maxArrayItems)
      .map(([childKey, child]) => [childKey, visit(child, childKey, depth + 1)]));
  };
  const serialized = visit(value, "", 0);
  const encoded = JSON.stringify(serialized);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    return { error: { code: "EDGE_CAPACITY", message: "Serialized Edge value exceeded the effective byte limit." } };
  }
  return serialized;
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
