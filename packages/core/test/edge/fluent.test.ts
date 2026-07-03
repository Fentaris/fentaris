import { describe, expect, it } from "vitest";
import { McpProxy } from "../../src/proxy/McpProxy.js";
import { McpServer } from "../../src/server/McpServer.js";
import { StdioTransport } from "../../src/transports/client/StdioTransport.js";
import { FentarisConfigError } from "../../src/config/index.js";
import { Policy, group, user } from "../../src/governance.js";
import {
  cloud,
  edge,
  runtime,
  type FentarisDiagnostic,
  type SetupSchema,
} from "../../src/index.js";

function diagnosticProxy(servers: McpServer[] = []) {
  return new McpProxy({
    policy: Policy.allowAll(),
    servers,
  });
}

function find(diagnostics: readonly FentarisDiagnostic[], code: string): FentarisDiagnostic | undefined {
  return diagnostics.find((d) => d.code === code);
}

function stdioServer(name: string, opts: { args?: (string | ReturnType<typeof runtime.input>)[]; env?: Record<string, string | ReturnType<typeof runtime.secret>> } = {}) {
  return new McpServer({
    name,
    transport: new StdioTransport({
      command: "node",
      ...(opts.args ? { args: opts.args } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    }),
  });
}

describe("app.target registration", () => {
  it("registers a reusable edge target without creating an MCP server", () => {
    const proxy = diagnosticProxy();
    proxy.target("personal-device", edge({ device: edge.userDefaultDevice() }));
    const target = proxy.resolveTarget("personal-device");
    expect(target.kind).toBe("edge");
    expect(proxy.resolveTarget("cloud")).toEqual({ kind: "cloud" });
  });

  it("rejects a reserved target name", () => {
    const proxy = diagnosticProxy();
    expect(() => proxy.target("cloud", cloud)).toThrow(FentarisConfigError);
  });

  it("rejects an invalid target name", () => {
    const proxy = diagnosticProxy();
    expect(() => proxy.target("Bad Name!", cloud)).toThrow(FentarisConfigError);
    expect(() => proxy.target("trailing-", cloud)).toThrow(FentarisConfigError);
  });

  it("rejects a duplicate target", () => {
    const proxy = diagnosticProxy();
    proxy.target("personal", edge({ device: edge.userDefaultDevice() }));
    expect(() => proxy.target("personal", edge({ device: edge.userDefaultDevice() }))).toThrow(FentarisConfigError);
  });

  it("rejects an unknown target on retrieval", () => {
    const proxy = diagnosticProxy();
    expect(() => proxy.resolveTarget("nope")).toThrow(FentarisConfigError);
  });
});

describe("fluent target bindings", () => {
  it("records a global target binding via app.mcp(name).target()", () => {
    const proxy = diagnosticProxy([stdioServer("custom")]);
    proxy.target("personal", edge({ device: edge.userDefaultDevice() }));
    proxy.mcp("custom").target("personal");
    expect(find(proxy.validateEdgeConfiguration(), "FENTARIS_CONFIG_PLACEMENT_UNKNOWN_TARGET")).toBeUndefined();
  });

  it("records a group-scoped target binding independently from policy", () => {
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [stdioServer("custom")],
      groups: [group({ id: "developers", users: [user("alice")], policy: Policy.allowAll() })],
    });
    proxy.target("personal", edge({ device: edge.userDefaultDevice() }));
    proxy.group("developers").mcp("custom").target("personal");
    expect(proxy.validateEdgeConfiguration().filter((d) => d.severity === "error")).toEqual([]);
  });

  it("records a user-scoped target binding via app.user(id).mcp(name).target()", () => {
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [stdioServer("custom")],
      groups: [group({ id: "developers", users: [user("alice")], policy: Policy.allowAll() })],
    });
    proxy.target("alice-device", edge({ device: edge.namedDevice("laptop") }));
    proxy.user("alice").mcp("custom").target("alice-device");
    expect(proxy.validateEdgeConfiguration().filter((d) => d.severity === "error")).toEqual([]);
  });

  it("preserves backward-compatible no-target declarations as implicit cloud", () => {
    const proxy = diagnosticProxy([stdioServer("custom")]);
    expect(proxy.validateEdgeConfiguration()).toEqual([]);
  });

  it("surfaces a missing target on a placement binding", () => {
    const proxy = diagnosticProxy([stdioServer("custom")]);
    proxy.mcp("custom").target("undeclared");
    expect(find(proxy.validateEdgeConfiguration(), "FENTARIS_CONFIG_PLACEMENT_UNKNOWN_TARGET")).toBeDefined();
  });

  it("rejects conflicting target bindings for the same scope", () => {
    const proxy = diagnosticProxy([stdioServer("custom")]);
    proxy.target("a", edge({ device: edge.userDefaultDevice() }));
    proxy.target("b", edge({ device: edge.namedDevice("laptop") }));
    proxy.mcp("custom").target("a");
    // Force a second binding for the same global scope to exercise the duplicate check. @pk
    proxy.registerPlacementBinding({ serverName: "custom", scope: "global", targetName: "b" });
    expect(find(proxy.validateEdgeConfiguration(), "FENTARIS_CONFIG_PLACEMENT_DUPLICATE")).toBeDefined();
  });

  it("warns about an unresolved user handle with bindings", () => {
    const proxy = diagnosticProxy([stdioServer("custom")]);
    proxy.target("ghost-device", edge({ device: edge.namedDevice("laptop") }));
    proxy.user("ghost").mcp("custom").target("ghost-device");
    expect(find(proxy.validateEdgeConfiguration(), "FENTARIS_CONFIG_USER_UNRESOLVED")).toBeDefined();
  });
});

describe("setup schema reconciliation", () => {
  it("accepts a setup schema matching runtime references", () => {
    const proxy = diagnosticProxy([
      stdioServer("custom", {
        args: ["--workspace", runtime.input("workspace")],
        env: { TOKEN: runtime.secret("token") },
      }),
    ]);
    proxy.mcp("custom").setup({
      workspace: edge.folder({ access: "read-write" }),
      token: edge.secret(),
    });
    expect(proxy.validateEdgeConfiguration().filter((d) => d.severity === "error")).toEqual([]);
  });

  it("reports an undeclared runtime reference", () => {
    const proxy = diagnosticProxy([
      stdioServer("custom", { args: ["--workspace", runtime.input("workspace")] }),
    ]);
    proxy.mcp("custom").setup({ token: edge.secret() });
    expect(find(proxy.validateEdgeConfiguration(), "EDGE_SETUP_UNDECLARED_REFERENCE")).toBeDefined();
  });

  it("rejects a secret runtime reference bound to a non-secret field", () => {
    const proxy = diagnosticProxy([
      stdioServer("custom", { env: { TOKEN: runtime.secret("token") } }),
    ]);
    proxy.mcp("custom").setup({ token: edge.string() });
    expect(find(proxy.validateEdgeConfiguration(), "EDGE_SETUP_INCOMPATIBLE_FIELD")).toBeDefined();
  });

  it("warns about an unused required setup field", () => {
    const proxy = diagnosticProxy([stdioServer("custom")]);
    proxy.mcp("custom").setup({ workspace: edge.folder() });
    expect(find(proxy.validateEdgeConfiguration(), "EDGE_SETUP_UNUSED_REQUIRED")).toBeDefined();
  });

  it("rejects an unsafe secret default in a hand-constructed schema", () => {
    const proxy = diagnosticProxy([stdioServer("custom")]);
    // Bypass builders to simulate a maliciously/hand-constructed unsafe schema. @pk
    const unsafeSchema: SetupSchema = {
      version: 1,
      fields: {
        // @ts-expect-error: secret fields must not carry a default; we test rejection. @pk
        token: { kind: "secret", name: "token", required: true, default: "leaked" },
      },
    };
    proxy.mcp("custom").setup(unsafeSchema);
    expect(find(proxy.validateEdgeConfiguration(), "EDGE_SETUP_UNSAFE_SECRET_DEFAULT")).toBeDefined();
  });

  it("ignores plain-string stdio configuration with no setup schema", () => {
    const proxy = diagnosticProxy([stdioServer("custom", { args: ["server.js"] })]);
    expect(proxy.validateEdgeConfiguration()).toEqual([]);
  });
});

describe("constructor-style declarations", () => {
  it("normalizes constructor-style targets, setup, and placements into the internal model", () => {
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [
        stdioServer("custom", { args: ["--workspace", runtime.input("workspace")] }),
      ],
      targets: {
        "personal-device": edge({ device: edge.userDefaultDevice() }),
      },
      setup: {
        custom: { workspace: edge.folder() },
      },
      placements: [{ serverName: "custom", scope: "global", targetName: "personal-device" }],
    });
    expect(proxy.resolveTarget("personal-device").kind).toBe("edge");
    expect(proxy.validateEdgeConfiguration().filter((d) => d.severity === "error")).toEqual([]);
  });
});
