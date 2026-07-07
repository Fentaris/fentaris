import { describe, expect, it } from "vitest";
import {
  FentarisConfigError,
  assertValidFentarisConfig,
  createProxy,
  credential,
  credentialEnv,
  defineFentarisConfig,
  formatFentarisDiagnostics,
  group,
  mcp,
  policy,
  user,
  validateFentarisConfig,
} from "../src/index.js";
import type { FentarisTransport } from "../src/index.js";
import type { McpServer } from "../src/server/index.js";

class TestTransport implements FentarisTransport {
  async listTools() {
    return { tools: [] };
  }

  async callTool() {
    return { content: [{ type: "text" as const, text: "ok" }] };
  }

  async close() {}
}

describe("config validation", () => {
  it("defines config without normalizing or throwing", () => {
    const badConfig = { servers: [{} as McpServer] };
    expect(defineFentarisConfig(badConfig)).toBe(badConfig);
  });

  it("returns structured diagnostics for shape, duplicates, policy visibility, identity, credentials, and transports", () => {
    const github = mcp("github", { transport: new TestTransport(), auth: { type: "bearer", credential: credential("token") } });
    const result = validateFentarisConfig({
      servers: [
        github,
        mcp("github", { transport: new TestTransport() }),
        { name: "", getCredentialBindings: () => [], transport: new TestTransport() } as unknown as McpServer,
        { name: "broken", getCredentialBindings: () => [] } as unknown as McpServer,
      ],
      identity: { required: true } as never,
      policy: policy("global").mcp("missing").allow("*"),
      groups: [
        group({
          id: "engineering",
          users: [user("u1")],
          policy: policy("engineering").mcp("linear").allow("*"),
          servers: [mcp("github", { transport: new TestTransport() }), mcp("linear", { transport: new TestTransport() })],
        }),
        group({
          id: "product",
          users: [user("u1")],
          policy: policy("product").mcp("github").allow("*"),
          servers: [mcp("github", { transport: new TestTransport() })],
        }),
        group({
          id: "engineering",
          users: [user("u2")],
          policy: policy("duplicate").mcp("*").allow("*"),
        }),
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "FENTARIS_CONFIG_DUPLICATE_SERVER",
      "FENTARIS_CONFIG_SERVER_EMPTY_NAME",
      "FENTARIS_CONFIG_DUPLICATE_GROUP",
      "FENTARIS_CONFIG_SERVER_SCOPE_AMBIGUOUS",
      "FENTARIS_CONFIG_OVERLAPPING_GROUP_SERVER_AMBIGUOUS",
      "FENTARIS_CONFIG_POLICY_SERVER_NOT_VISIBLE",
      "FENTARIS_CONFIG_POLICY_WILDCARD_BROAD",
      "FENTARIS_CONFIG_IDENTITY_REQUIRED_WITHOUT_STRATEGY",
      "FENTARIS_CONFIG_CREDENTIAL_MISSING",
      "FENTARIS_CONFIG_SERVER_TRANSPORT_MISSING",
    ]));
  });

  it("throws FentarisConfigError for invalid high-level startup", () => {
    expect(() =>
      createProxy({
        servers: [
          mcp("github", { transport: new TestTransport() }),
          mcp("github", { transport: new TestTransport() }),
        ],
      }),
    ).toThrow(FentarisConfigError);
  });

  it("allows warning-only configs to start and exposes warnings through validation", () => {
    const config = defineFentarisConfig({
      policy: policy("wide").mcp("*").allow("*"),
    });

    const result = validateFentarisConfig(config);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(() => assertValidFentarisConfig(config)).not.toThrow();
    expect(createProxy(config)).toBeTruthy();
  });

  it("can defer policy server visibility for app composition", () => {
    const config = defineFentarisConfig({
      groups: [
        group({
          id: "engineering",
          users: [user("u1")],
          policy: policy("engineering").mcp("runtime").allow("*"),
        }),
      ],
    });

    const result = validateFentarisConfig(config, { requirePolicyServerVisibility: false });

    expect(result.valid).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).not.toContain("FENTARIS_CONFIG_POLICY_SERVER_NOT_VISIBLE");
    expect(() => assertValidFentarisConfig(config, { requirePolicyServerVisibility: false })).not.toThrow();
    expect(validateFentarisConfig(config).valid).toBe(false);
  });

  it("preserves existing valid global MCP behavior", () => {
    const proxy = createProxy({
      servers: [mcp("custom", { transport: new TestTransport() })],
    });

    expect(proxy).toBeTruthy();
  });

  it("accepts global server credentials supplied by a group or user", () => {
    const groupCredentialConfig = {
      servers: [
        mcp("github", {
          transport: new TestTransport(),
          auth: { type: "bearer" as const, credential: credential("github.token") },
        }),
      ],
      groups: [
        group({
          id: "support",
          users: [user("alice")],
          credentials: { "github.token": credentialEnv("GROUP_GITHUB_TOKEN") },
          policy: policy("support").mcp("github").allow("*"),
        }),
      ],
    };
    const userCredentialConfig = {
      servers: [
        mcp("github", {
          transport: new TestTransport(),
          auth: { type: "bearer" as const, credential: credential("github.token") },
        }),
      ],
      groups: [
        group({
          id: "support",
          users: [
            user("alice", {
              credentials: { "github.token": credentialEnv("USER_GITHUB_TOKEN") },
            }),
          ],
          policy: policy("support").mcp("github").allow("*"),
        }),
      ],
    };

    expect(validateFentarisConfig(groupCredentialConfig).valid).toBe(true);
    expect(validateFentarisConfig(userCredentialConfig).valid).toBe(true);
  });

  it("accepts scoped server credentials supplied by a user in the same group", () => {
    const result = validateFentarisConfig({
      groups: [
        group({
          id: "support",
          users: [
            user("alice", {
              credentials: { "github.token": credentialEnv("USER_GITHUB_TOKEN") },
            }),
          ],
          servers: [
            mcp("github", {
              transport: new TestTransport(),
              auth: { type: "bearer", credential: credential("github.token") },
            }),
          ],
          policy: policy("support").mcp("github").allow("*"),
        }),
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).not.toContain("FENTARIS_CONFIG_CREDENTIAL_MISSING");
  });

  it("validates CLI MCP account selector defaults and allowed entries", () => {
    const valid = validateFentarisConfig({
      servers: [mcp("github", { transport: new TestTransport() })],
      cli: {
        mcpAccounts: {
          github: { default: "user:alice", allowed: ["user:alice", "group:support"] },
        },
      },
    });
    expect(valid.valid).toBe(true);

    const invalid = validateFentarisConfig({
      servers: [mcp("github", { transport: new TestTransport() })],
      cli: {
        mcpAccounts: {
          github: { default: "user:alice", allowed: ["group:support"] },
          empty: { default: "", allowed: [] },
          malformed: { default: "alice", allowed: ["alice"] },
        },
      },
    });

    expect(invalid.valid).toBe(false);
    expect(invalid.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "FENTARIS_CONFIG_CLI_MCP_ACCOUNT_DEFAULT_NOT_ALLOWED",
      "FENTARIS_CONFIG_CLI_MCP_ACCOUNT_DEFAULT_MISSING",
      "FENTARIS_CONFIG_CLI_MCP_ACCOUNT_ALLOWED_EMPTY",
      "FENTARIS_CONFIG_CLI_MCP_ACCOUNT_SELECTOR_INVALID",
    ]));
  });

  it("throws structured diagnostics for invalid scoped handles", () => {
    const proxy = createProxy({
      servers: [mcp("global", { transport: new TestTransport() })],
      groups: [
        group({
          id: "engineering",
          users: [user("u1")],
          policy: policy("engineering").mcp("global").allow("*"),
          servers: [mcp("linear", { transport: new TestTransport() })],
        }),
        group({
          id: "product",
          users: [user("u2")],
          policy: policy("product").mcp("stripe").allow("*"),
          servers: [mcp("stripe", { transport: new TestTransport() })],
        }),
      ],
    });

    expect(() => proxy.group("missing").use((_ctx, next) => next())).toThrow(FentarisConfigError);
    expect(() => proxy.mcp("missing")).toThrow(FentarisConfigError);
    expect(() => proxy.group("engineering").mcp("missing").tool("*", (_ctx, next) => next())).toThrow(FentarisConfigError);
    expect(() => proxy.group("engineering").mcp("stripe").tool("*", (_ctx, next) => next())).toThrow(FentarisConfigError);
  });
});

describe("config diagnostics rendering", () => {
  it("formats plain, pretty, compact, and JSON diagnostics", () => {
    const diagnostics = validateFentarisConfig({
      servers: [
        mcp("github", { transport: new TestTransport() }),
        mcp("github", { transport: new TestTransport() }),
      ],
    }).diagnostics;

    expect(formatFentarisDiagnostics(diagnostics, { format: "plain" })).toContain("Fentaris configuration diagnostics");
    expect(formatFentarisDiagnostics(diagnostics, { format: "pretty", color: "never", unicode: "never" })).toContain("`- ERROR");
    expect(formatFentarisDiagnostics(diagnostics, { format: "compact" })).toContain("FENTARIS_CONFIG_DUPLICATE_SERVER");
    expect(JSON.parse(formatFentarisDiagnostics(diagnostics, { format: "json" }))).toMatchObject([
      { code: "FENTARIS_CONFIG_DUPLICATE_SERVER" },
    ]);
  });

  it("does not render raw secret values", () => {
    const secret = "super-secret-token";
    const error = new FentarisConfigError([
      {
        severity: "error",
        code: "FENTARIS_CONFIG_CREDENTIAL_MISSING",
        title: "Credential reference cannot be resolved",
        message: 'Server "github" references credential "token", but no source is visible in this scope.',
        path: ["servers", 0],
      },
    ]);

    expect(error.toJSON().diagnostics[0]?.message).not.toContain(secret);
    expect(error.format({ format: "plain" })).not.toContain(secret);
  });

  it("serializes and formats FentarisConfigError", () => {
    const result = validateFentarisConfig({
      servers: [
        mcp("github", { transport: new TestTransport() }),
        mcp("github", { transport: new TestTransport() }),
      ],
    });
    const error = new FentarisConfigError(result.errors);

    expect(error.diagnostics).toHaveLength(1);
    expect(error.toJSON()).toMatchObject({ name: "FentarisConfigError" });
    expect(error.format({ format: "compact" })).toContain("FENTARIS_CONFIG_DUPLICATE_SERVER");
  });
});
