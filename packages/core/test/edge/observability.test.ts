import { describe, expect, it, vi } from "vitest";
import {
  EdgeTelemetry,
  edgeHealth,
  redactEdgeProtocolValue,
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
    });
    const checks = builder.toConfig().custom;
    expect(checks.map((check) => check.name)).toEqual([
      "edge.gateway",
      "edge.target-resolution",
      "edge.device-availability",
      "edge.deployment-readiness",
      "edge.capability-cache",
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
});

