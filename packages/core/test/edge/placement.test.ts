import { describe, expect, it } from "vitest";
import {
  PlacementResolver,
  detectStaticPlacementOverlaps,
  edge,
  isEdgeError,
  resolveDeviceSelector,
  requireDevice,
  type DeviceResolution,
  type DeviceResolver,
  type DeviceResolverContext,
  type FentarisDiagnostic,
  type PlacementBindingModel,
} from "../../src/index.js";
import type { ExecutionTarget } from "../../src/edge/target.js";
import { McpProxy } from "../../src/proxy/McpProxy.js";
import { McpServer } from "../../src/server/McpServer.js";
import { StdioTransport } from "../../src/transports/client/StdioTransport.js";
import { Policy, group, user } from "../../src/governance.js";

function resolver(targets: Record<string, ExecutionTarget>, bindings: PlacementBindingModel[]) {
  return new PlacementResolver({
    targets: new Map(Object.entries(targets)),
    bindings,
  });
}

const personalEdge = edge({ device: edge.userDefaultDevice() });
const aliasEdge = edge({ device: edge.namedDevice("laptop") });
const poolEdge = edge({ device: edge.pool("team-workers", "least-loaded") });

describe("placement precedence", () => {
  it("resolves to implicit cloud when no binding is declared", () => {
    const r = resolver({}, []);
    const result = r.resolve({ serverName: "custom", groupIds: [] });
    expect(result).toEqual({ targetName: "cloud", kind: "cloud", source: "implicit-cloud" });
  });

  it("resolves a global binding", () => {
    const r = resolver({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
    ]);
    const result = r.resolve({ serverName: "custom", groupIds: [] });
    expect(result.source).toBe("global");
    expect(result.targetName).toBe("personal-device");
    expect(result.kind).toBe("edge");
  });

  it("a group binding overrides a global binding", () => {
    const r = resolver({ "personal-device": personalEdge, "team-workers": poolEdge }, [
      { serverName: "custom", scope: "global", targetName: "team-workers" },
      { serverName: "custom", scope: "group", groupId: "developers", targetName: "personal-device" },
    ]);
    const result = r.resolve({ serverName: "custom", subjectId: "alice", groupIds: ["developers"] });
    expect(result.source).toBe("group");
    expect(result.targetName).toBe("personal-device");
  });

  it("a user binding overrides a group binding", () => {
    const r = resolver({ "personal-device": personalEdge, "alice-device": aliasEdge }, [
      { serverName: "custom", scope: "group", groupId: "developers", targetName: "personal-device" },
      { serverName: "custom", scope: "user", userId: "alice", targetName: "alice-device" },
    ]);
    const result = r.resolve({ serverName: "custom", subjectId: "alice", groupIds: ["developers"] });
    expect(result.source).toBe("user");
    expect(result.targetName).toBe("alice-device");
  });

  it("an allowed explicit session target is selected", () => {
    const r = resolver({ "personal-device": personalEdge, "team-workers": poolEdge }, [
      { serverName: "custom", scope: "group", groupId: "developers", targetName: "personal-device" },
      { serverName: "custom", scope: "global", targetName: "team-workers" },
    ]);
    const result = r.resolve({
      serverName: "custom",
      subjectId: "alice",
      groupIds: ["developers"],
      requestedTarget: "team-workers",
    });
    expect(result.source).toBe("explicit");
    expect(result.targetName).toBe("team-workers");
  });

  it("an explicit cloud target is always eligible", () => {
    const r = resolver({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "group", groupId: "developers", targetName: "personal-device" },
    ]);
    const result = r.resolve({
      serverName: "custom",
      subjectId: "alice",
      groupIds: ["developers"],
      requestedTarget: "cloud",
    });
    expect(result).toEqual({ targetName: "cloud", kind: "cloud", source: "explicit" });
  });
});

describe("explicit target authorization", () => {
  it("rejects an explicit target that is not among eligible bindings", () => {
    const r = resolver({ "personal-device": personalEdge, "team-workers": poolEdge }, [
      { serverName: "custom", scope: "group", groupId: "developers", targetName: "personal-device" },
    ]);
    let caught: unknown;
    try {
      r.resolve({ serverName: "custom", subjectId: "alice", groupIds: ["developers"], requestedTarget: "team-workers" });
    } catch (error) {
      caught = error;
    }
    expect(isEdgeError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("EDGE_UNAUTHORIZED_TARGET");
    // No inaccessible target or device details leaked. @pk
    const details = (caught as { details?: Record<string, unknown> }).details;
    expect(details).toEqual({ serverName: "custom" });
  });
});

describe("group ambiguity rejection and convergence", () => {
  it("deduplicates matching groups that converge on one target", () => {
    const r = resolver({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "group", groupId: "developers", targetName: "personal-device" },
      { serverName: "custom", scope: "group", groupId: "internal", targetName: "personal-device" },
    ]);
    const result = r.resolve({ serverName: "custom", subjectId: "alice", groupIds: ["developers", "internal"] });
    expect(result.source).toBe("group");
    expect(result.targetName).toBe("personal-device");
  });

  it("rejects dynamic group overlap with different targets", () => {
    const r = resolver({ "personal-device": personalEdge, "team-workers": poolEdge }, [
      { serverName: "custom", scope: "group", groupId: "developers", targetName: "personal-device" },
      { serverName: "custom", scope: "group", groupId: "ops", targetName: "team-workers" },
    ]);
    let caught: unknown;
    try {
      r.resolve({ serverName: "custom", subjectId: "alice", groupIds: ["developers", "ops"] });
    } catch (error) {
      caught = error;
    }
    expect(isEdgeError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("EDGE_PLACEMENT_AMBIGUOUS");
  });
});

describe("placement does not grant capability access", () => {
  it("the resolver exposes no capability enumeration and only returns a target name", () => {
    const r = resolver({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
    ]);
    // A subject that could not see or authorize "custom" still receives only a
    // target *name* here; the caller is responsible for catalog/policy. The
    // resolver never lists tools, resources, servers, or device inventory.
    const result = r.resolve({ serverName: "custom", subjectId: "mallory", groupIds: [] });
    expect(Object.keys(result)).toEqual(["targetName", "kind", "source"]);
    expect(result).not.toHaveProperty("capabilities");
    expect(result).not.toHaveProperty("devices");
  });

  it("a hidden server resolves to the same target shape as a visible server", () => {
    const r = resolver({ "personal-device": personalEdge }, [
      { serverName: "custom", scope: "global", targetName: "personal-device" },
    ]);
    const visible = r.resolve({ serverName: "custom", subjectId: "alice", groupIds: [] });
    const hidden = r.resolve({ serverName: "custom", subjectId: "unknown-subject", groupIds: [] });
    // The presence of a placement binding does not change what capabilities a\n    // subject eventually sees; that is the catalog/policy's job (@@pk).
    expect(visible.targetName).toBe(hidden.targetName);
  });
});

describe("static placement overlap detection", () => {
  it("reports statically overlapping groups binding the same server to different targets", () => {
    const overlaps = detectStaticPlacementOverlaps({
      subjectGroups: new Map([["alice", ["developers", "ops"]]]),
      bindings: [
        { serverName: "custom", scope: "group", groupId: "developers", targetName: "personal-device" },
        { serverName: "custom", scope: "group", groupId: "ops", targetName: "team-workers" },
      ],
    });
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].serverName).toBe("custom");
    expect(overlaps[0].subjectId).toBe("alice");
    expect([...overlaps[0].targets].sort()).toEqual(["personal-device", "team-workers"]);
  });

  it("does not report converging group bindings", () => {
    const overlaps = detectStaticPlacementOverlaps({
      subjectGroups: new Map([["alice", ["developers", "ops"]]]),
      bindings: [
        { serverName: "custom", scope: "group", groupId: "developers", targetName: "personal-device" },
        { serverName: "custom", scope: "group", groupId: "ops", targetName: "personal-device" },
      ],
    });
    expect(overlaps).toEqual([]);
  });

  it("suppresses overlap when a user binding resolves the conflict", () => {
    const overlaps = detectStaticPlacementOverlaps({
      subjectGroups: new Map([["alice", ["developers", "ops"]]]),
      bindings: [
        { serverName: "custom", scope: "group", groupId: "developers", targetName: "personal-device" },
        { serverName: "custom", scope: "group", groupId: "ops", targetName: "team-workers" },
        { serverName: "custom", scope: "user", userId: "alice", targetName: "alice-device" },
      ],
      userBindings: new Set(["custom|alice"]),
    });
    expect(overlaps).toEqual([]);
  });

  it("ignores subjects in a single group", () => {
    const overlaps = detectStaticPlacementOverlaps({
      subjectGroups: new Map([["alice", ["developers"]]]),
      bindings: [
        { serverName: "custom", scope: "group", groupId: "developers", targetName: "personal-device" },
        { serverName: "custom", scope: "group", groupId: "ops", targetName: "team-workers" },
      ],
    });
    expect(overlaps).toEqual([]);
  });
});

function mockResolver(devices: Partial<DeviceResolver> = {}): DeviceResolver {
  return {
    resolveSessionDevice: devices.resolveSessionDevice,
    resolveUserDefaultDevice: devices.resolveUserDefaultDevice,
    resolveNamedAlias: devices.resolveNamedAlias ?? (async () => null),
    resolvePool: devices.resolvePool ?? (async () => null),
  };
}

const ctx = (overrides: Partial<DeviceResolverContext> = {}): DeviceResolverContext => ({
  targetName: "personal-device",
  ...overrides,
});

function findDiagnostic(diagnostics: readonly FentarisDiagnostic[], code: string): FentarisDiagnostic | undefined {
  return diagnostics.find((d) => d.code === code);
}

function stdioServer(name: string) {
  return new McpServer({ name, transport: new StdioTransport({ command: "node" }) });
}

describe("McpProxy placement integration", () => {
  it("emits a static overlap diagnostic for conflicting group bindings", () => {
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [stdioServer("custom")],
      groups: [
        group({ id: "developers", users: [user("alice")], policy: Policy.allowAll() }),
        group({ id: "ops", users: [user("alice")], policy: Policy.allowAll() }),
      ],
    });
    proxy.target("personal-device", edge({ device: edge.userDefaultDevice() }));
    proxy.target("team-workers", edge({ device: edge.pool("team-workers") }));
    proxy.group("developers").mcp("custom").target("personal-device");
    proxy.group("ops").mcp("custom").target("team-workers");
    const diagnostics = proxy.validateEdgeConfiguration();
    const overlap = findDiagnostic(diagnostics, "FENTARIS_CONFIG_PLACEMENT_AMBIGUOUS");
    expect(overlap).toBeDefined();
    expect(overlap?.severity).toBe("error");
  });

  it("suppresses the overlap diagnostic when a user binding resolves it", () => {
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [stdioServer("custom")],
      groups: [
        group({ id: "developers", users: [user("alice")], policy: Policy.allowAll() }),
        group({ id: "ops", users: [user("alice")], policy: Policy.allowAll() }),
      ],
    });
    proxy.target("personal-device", edge({ device: edge.userDefaultDevice() }));
    proxy.target("team-workers", edge({ device: edge.pool("team-workers") }));
    proxy.target("alice-device", edge({ device: edge.namedDevice("laptop") }));
    proxy.group("developers").mcp("custom").target("personal-device");
    proxy.group("ops").mcp("custom").target("team-workers");
    proxy.user("alice").mcp("custom").target("alice-device");
    expect(findDiagnostic(proxy.validateEdgeConfiguration(), "FENTARIS_CONFIG_PLACEMENT_AMBIGUOUS")).toBeUndefined();
  });

  it("exposes a placement resolver that resolves a global binding", () => {
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [stdioServer("custom")],
    });
    proxy.target("personal-device", edge({ device: edge.userDefaultDevice() }));
    proxy.mcp("custom").target("personal-device");
    const result = proxy.resolvePlacement({ serverName: "custom", subjectId: "alice", groupIds: [] });
    expect(result.targetName).toBe("personal-device");
    expect(result.kind).toBe("edge");
    expect(result.source).toBe("global");
  });

  it("restores implicit cloud placement for legacy no-binding declarations", () => {
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [stdioServer("custom")],
    });
    const result = proxy.resolvePlacement({ serverName: "custom", groupIds: [] });
    expect(result).toEqual({ targetName: "cloud", kind: "cloud", source: "implicit-cloud" });
  });
});

describe("logical device selectors", () => {
  it("resolves a user default device", async () => {
    const expected: DeviceResolution = { edgeNodeId: "node-1" };
    const r = mockResolver({ resolveUserDefaultDevice: async () => expected });
    const result = await resolveDeviceSelector(edge.userDefaultDevice().toJSON(), ctx({ subjectId: "alice" }), r);
    expect(result).toEqual(expected);
  });

  it("resolves a named alias", async () => {
    const expected: DeviceResolution = { edgeNodeId: "node-2", alias: "laptop" };
    const r = mockResolver({ resolveNamedAlias: async (alias) => (alias === "laptop" ? expected : null) });
    const result = await resolveDeviceSelector(edge.namedDevice("laptop").toJSON(), ctx(), r);
    expect(result).toEqual(expected);
  });

  it("resolves a shared pool with the declared strategy", async () => {
    const expected: DeviceResolution = { edgeNodeId: "node-3" };
    let observedPool: string | undefined;
    let observedStrategy: string | undefined;
    const r = mockResolver({
      resolvePool: async (pool, strategy) => {
        observedPool = pool;
        observedStrategy = strategy;
        return expected;
      },
    });
    const result = await resolveDeviceSelector(edge.pool("team-workers", "least-loaded").toJSON(), ctx(), r);
    expect(result).toEqual(expected);
    expect(observedPool).toBe("team-workers");
    expect(observedStrategy).toBe("least-loaded");
  });

  it("resolves a session device", async () => {
    const expected: DeviceResolution = { edgeNodeId: "node-4" };
    const r = mockResolver({ resolveSessionDevice: async (c) => (c.requestedDeviceId === "dev-x" ? expected : null) });
    const result = await resolveDeviceSelector(
      edge.sessionDevice().toJSON(),
      ctx({ requestedDeviceId: "dev-x" }),
      r,
    );
    expect(result).toEqual(expected);
  });

  it("falls back to the next selector when the first is ineligible", async () => {
    const expected: DeviceResolution = { edgeNodeId: "node-2" };
    const r = mockResolver({
      resolveUserDefaultDevice: async () => null,
      resolveNamedAlias: async (alias) => (alias === "laptop" ? expected : null),
    });
    const selector = edge.userDefaultDevice().or(edge.namedDevice("laptop")).toJSON();
    const result = await resolveDeviceSelector(selector, ctx({ subjectId: "alice" }), r);
    expect(result).toEqual(expected);
  });

  it("returns null and EDGE_UNAVAILABLE when no eligible device is found", async () => {
    const r = mockResolver({
      resolveUserDefaultDevice: async () => null,
      resolveNamedAlias: async () => null,
    });
    const selector = edge.userDefaultDevice().or(edge.namedDevice("laptop")).toJSON();
    const result = await resolveDeviceSelector(selector, ctx({ subjectId: "alice" }), r);
    expect(result).toBeNull();

    let caught: unknown;
    try {
      await requireDevice(selector, ctx({ subjectId: "alice" }), r);
    } catch (error) {
      caught = error;
    }
    expect(isEdgeError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("EDGE_UNAVAILABLE");
    // No private device inventory is exposed. @pk
    expect((caught as { details?: Record<string, unknown> }).details).toEqual({ targetName: "personal-device" });
  });
});