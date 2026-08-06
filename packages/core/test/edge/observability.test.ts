import { describe, expect, it, vi } from "vitest";
import {
  EdgeTelemetry,
  edgeHealth,
  redactEdgeProtocolValue,
  serializeEdgePublicValue,
  type HealthCheckContext,
} from "../../src/index.js";

describe("edge observability", () => {
  it("redacts structured telemetry before emitting", async () => {
    const emit = vi.fn();
    const telemetry = new EdgeTelemetry({ emit }, () => 123);
    await telemetry.emit({
      name: "edge.workload.lifecycle",
      deploymentId: "fixture",
      outcome: "failed",
      metadata: {
        token: "secret-token",
        canonicalPath: "/Users/alice/private",
        environment: { API_KEY: "value" },
        safe: "visible",
      },
    });
    expect(emit).toHaveBeenCalledWith({
      name: "edge.workload.lifecycle",
      deploymentId: "fixture",
      outcome: "failed",
      occurredAt: 123,
      metadata: {
        token: "[REDACTED]",
        canonicalPath: "[REDACTED]",
        environment: "[REDACTED]",
        safe: "visible",
      },
    });
  });

  it("provides standard edge health checks and redacts probe metadata", async () => {
    const builder = edgeHealth({
      gateway: async () => ({ status: "ok", metadata: { connectionGeneration: 2 } }),
      targetResolution: async () => ({ status: "ok" }),
      deviceAvailability: async () => ({ status: "degraded", message: "one pool offline" }),
      deploymentReadiness: async () => ({ status: "down", metadata: { secret: "hidden" } }),
      capabilityCache: async () => ({ status: "ok", metadata: { cacheAgeMs: 12 } }),
      inventoryStore: async () => ({ status: "ok" }),
      presenceExpiry: async () => ({ status: "ok" }),
      selectionService: async () => ({ status: "ok" }),
      childBindingCleanup: async () => ({ status: "ok" }),
      channelRouting: async () => ({ status: "ok" }),
      protocolDistribution: async () => ({ status: "ok" }),
      staleReadiness: async () => ({ status: "degraded" }),
    });
    const checks = builder.toConfig().custom;
    expect(checks.map((check) => check.name)).toEqual([
      "edge.gateway",
      "edge.target-resolution",
      "edge.device-availability",
      "edge.deployment-readiness",
      "edge.capability-cache",
      "edge.inventory-store",
      "edge.presence-expiry",
      "edge.selection-service",
      "edge.child-binding-cleanup",
      "edge.channel-routing",
      "edge.protocol-distribution",
      "edge.stale-readiness",
    ]);
    const readiness = checks.find((check) => check.name === "edge.deployment-readiness")!;
    await expect(readiness.handler({} as HealthCheckContext)).resolves.toMatchObject({
      status: "down",
      metadata: { secret: "[REDACTED]" },
    });
  });

  it("redacts private paths and authorization payloads recursively", () => {
    expect(redactEdgeProtocolValue({
      authorization: "Bearer token",
      nested: { localPath: "/private/data", value: "/home/alice/file", safe: "ok" },
    })).toEqual({
      authorization: "[REDACTED]",
      nested: { localPath: "[REDACTED]", value: "[REDACTED_PATH]", safe: "ok" },
    });
  });

  it("bounds circular metadata, descriptions, observed facts, errors, outputs, and service diagnostics", () => {
    const circular: Record<string, unknown> = {
      description: "x".repeat(20),
      observedFacts: { token: "private", platform: "darwin" },
      aggregateError: { localPath: "/Users/alice/private" },
      childOutput: { environment: { SECRET: "value" } },
      serviceDiagnostics: { credentialId: "credential" },
    };
    circular.self = circular;
    expect(serializeEdgePublicValue(circular, { maxStringLength: 5 })).toEqual({
      description: "xxxxx[TRUNCATED]",
      observedFacts: { token: "[REDACTED]", platform: "darwi[TRUNCATED]" },
      aggregateError: { localPath: "[REDACTED]" },
      childOutput: { environment: "[REDACTED]" },
      serviceDiagnostics: { credentialId: "[REDACTED]" },
      self: "[CIRCULAR]",
    });
  });
});
