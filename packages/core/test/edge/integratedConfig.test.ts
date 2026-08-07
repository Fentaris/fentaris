import { describe, expect, it } from "vitest";
import {
  EDGE_CONTROL_PLANE_DEFAULT_BASE_PATH,
  EDGE_CONTROL_PLANE_ERROR_CODES,
  IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS,
  InMemoryEdgeCapabilityManifestStore,
  InMemoryEdgeConnectionStore,
  InMemoryEdgeDesiredStateStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
  InMemoryEdgeSetupStatusStore,
  buildEdgeControlPlaneUrls,
  edgeControlPlaneError,
  mergeEdgeControlPlaneConfig,
  normalizeEdgeControlPlaneConfig,
  parseSerializableEdgeControlPlaneConfig,
  validateEdgeControlPlaneConfig,
  validateFentarisConfig,
  type EdgeControlPlaneConfig,
  type FentarisDiagnostic,
} from "../../src/index.js";

describe("integrated Edge control-plane configuration", () => {
  it("normalizes minimal local configuration with secure defaults", () => {
    const normalized = normalizeEdgeControlPlaneConfig({
      enabled: true,
      mode: "local",
    });

    expect(normalized).toMatchObject({
      enabled: true,
      mode: "local",
      basePath: EDGE_CONTROL_PLANE_DEFAULT_BASE_PATH,
      stateDir: "edge-control-plane",
      accessTokenTtlSeconds: 15 * 60,
      pollIntervalSeconds: 5,
    });
    expect(validateEdgeControlPlaneConfig({ enabled: true, mode: "local" }, {
      mcpPath: "/mcp",
      listenerHost: "127.0.0.1",
    })).toEqual([]);
  });

  it("leaves absent control-plane configuration unchanged", () => {
    expect(normalizeEdgeControlPlaneConfig(undefined)).toBeUndefined();
    expect(validateEdgeControlPlaneConfig(undefined)).toEqual([]);
    expect(validateFentarisConfig({}).valid).toBe(true);
  });

  it("merges serializable JSON options under TypeScript precedence", () => {
    const merged = mergeEdgeControlPlaneConfig(
      {
        enabled: true,
        mode: "local",
        basePath: "/_fentaris/edge-ts",
        accessTokenTtlSeconds: 120,
      },
      {
        enabled: true,
        mode: "local",
        basePath: "/_fentaris/edge-json",
        publicOrigin: "http://127.0.0.1:4000",
        accessTokenTtlSeconds: 999,
      },
    );

    expect(merged).toMatchObject({
      enabled: true,
      mode: "local",
      basePath: "/_fentaris/edge-ts",
      publicOrigin: "http://127.0.0.1:4000",
      accessTokenTtlSeconds: 120,
    });
  });

  it("rejects conflicting routes, insecure origins, and embedded secrets", () => {
    const diagnostics = validateEdgeControlPlaneConfig({
      enabled: true,
      mode: "local",
      basePath: "/mcp",
      publicOrigin: "http://example.com",
      tokenSecret: "raw-secret",
    } as EdgeControlPlaneConfig & { tokenSecret: string }, {
      mcpPath: "/mcp",
    });

    expect(diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "FENTARIS_EDGE_CONTROL_PLANE_ROUTE_CONFLICT",
      "FENTARIS_EDGE_CONTROL_PLANE_PUBLIC_ORIGIN_INSECURE",
      "FENTARIS_EDGE_CONTROL_PLANE_SENSITIVE_VALUE",
    ]));
  });

  it("rejects managed mode without durable adapters", () => {
    const diagnostics = validateEdgeControlPlaneConfig({
      enabled: true,
      mode: "managed",
      publicOrigin: "https://edge.example.com",
      adapters: {
        deviceRegistry: new InMemoryEdgeDeviceRegistry(),
        desiredStateStore: new InMemoryEdgeDesiredStateStore(),
        setupStatusStore: new InMemoryEdgeSetupStatusStore(),
        capabilityManifestStore: new InMemoryEdgeCapabilityManifestStore(),
        connectionStore: new InMemoryEdgeConnectionStore(),
        presenceStore: new InMemoryEdgePresenceStore(),
        readinessStore: new InMemoryEdgeReadinessStore(),
      },
    });

    expect(diagnostics.some((entry) => entry.code === "FENTARIS_EDGE_CONTROL_PLANE_MANAGED_ADAPTER_UNSAFE")).toBe(true);
    expect(diagnostics.some((entry) => entry.code === "FENTARIS_EDGE_CONTROL_PLANE_APPROVAL_ADAPTER_MISSING")).toBe(true);
    expect(IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS.multiInstance).toBe(false);
  });

  it("parses serializable fentaris.json fields and rejects TypeScript-only keys", () => {
    const diagnostics: FentarisDiagnostic[] = [];
    const parsed = parseSerializableEdgeControlPlaneConfig({
      enabled: true,
      mode: "local",
      publicOrigin: "http://127.0.0.1:4000",
      approval: { approve: async () => undefined },
    }, diagnostics);

    expect(parsed).toMatchObject({
      enabled: true,
      mode: "local",
      publicOrigin: "http://127.0.0.1:4000",
    });
    expect(diagnostics.some((entry) => entry.code === "FENTARIS_EDGE_CONTROL_PLANE_JSON_UNSUPPORTED_FIELD")).toBe(true);
  });

  it("builds join and gateway URLs from the canonical public origin only", () => {
    const urls = buildEdgeControlPlaneUrls("https://edge.example.com", "/_fentaris/edge");
    expect(urls).toEqual({
      joinBaseUrl: "https://edge.example.com/_fentaris/edge",
      gatewayUrl: "wss://edge.example.com/_fentaris/edge/ws",
      authorizeUrl: "https://edge.example.com/_fentaris/edge/device/authorize",
      tokenUrl: "https://edge.example.com/_fentaris/edge/device/token",
      refreshUrl: "https://edge.example.com/_fentaris/edge/token/refresh",
      enrollUrl: "https://edge.example.com/_fentaris/edge/edge/enroll",
      revokeUrl: "https://edge.example.com/_fentaris/edge/edge/revoke",
      verificationUrl: "https://edge.example.com/_fentaris/edge/device/verify",
    });
  });

  it("exposes confidential control-plane error contracts", () => {
    expect(edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES.authorization_pending, undefined, { interval: 5 }))
      .toEqual({ error: "authorization_pending", interval: 5 });
  });
});
