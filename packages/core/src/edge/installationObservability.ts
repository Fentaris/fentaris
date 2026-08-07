import { health, type HealthBuilder } from "../health/index.js";
import { redactEdgeProtocolValue, type EdgeHealthProbeResult } from "./observability.js";

export type EdgeInstallationRuntimeEventName =
  | "edge.installation.source"
  | "edge.installation.approval"
  | "edge.installation.attempt"
  | "edge.installation.verification"
  | "edge.installation.activation"
  | "edge.installation.rollback"
  | "edge.installation.cleanup";

export interface EdgeInstallationRuntimeEvent {
  readonly name: EdgeInstallationRuntimeEventName;
  readonly occurredAt: number;
  readonly deploymentId?: string;
  readonly outcome?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EdgeInstallationTelemetrySink {
  emit(event: EdgeInstallationRuntimeEvent): void | Promise<void>;
}

/** Structured managed-installation telemetry with mandatory protocol/local-data redaction. */
export class EdgeInstallationTelemetry {
  constructor(
    private readonly sink: EdgeInstallationTelemetrySink,
    private readonly now: () => number = Date.now,
  ) {}

  async emit(event: Omit<EdgeInstallationRuntimeEvent, "occurredAt"> & { occurredAt?: number }): Promise<void> {
    await this.sink.emit(redactEdgeProtocolValue({
      ...event,
      occurredAt: event.occurredAt ?? this.now(),
    }) as unknown as EdgeInstallationRuntimeEvent);
  }
}

export interface EdgeInstallationHealthOptions {
  readonly interruptedAttempts?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly staleLifecycle?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly storage?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly isolation?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly orphanedArtifacts?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly agentUpgradeRequirements?: () => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>;
  readonly timeoutMs?: number;
}

/** Build standard managed-installation health checks. */
export function edgeInstallationHealth(options: EdgeInstallationHealthOptions): HealthBuilder {
  const builder = health({ timeoutMs: options.timeoutMs });
  addProbe(builder, "edge.installation-interrupted-attempts", options.interruptedAttempts);
  addProbe(builder, "edge.installation-stale-lifecycle", options.staleLifecycle);
  addProbe(builder, "edge.installation-storage", options.storage);
  addProbe(builder, "edge.installation-isolation", options.isolation);
  addProbe(builder, "edge.installation-orphaned-artifacts", options.orphanedArtifacts);
  addProbe(builder, "edge.installation-agent-upgrade", options.agentUpgradeRequirements);
  return builder;
}

function addProbe(
  builder: HealthBuilder,
  name: string,
  probe: (() => EdgeHealthProbeResult | Promise<EdgeHealthProbeResult>) | undefined,
): void {
  if (!probe) return;
  builder.check(name, async () => {
    const result = await probe();
    return { status: result.status, ...(result.message ? { message: result.message } : {}), ...(result.metadata ? { metadata: result.metadata } : {}) };
  });
}
