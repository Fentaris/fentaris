import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import {
  Group,
  McpProxy,
  McpServer,
  FentarisAuth,
  Policy,
  User,
  allow,
  apiKeyIdentityStrategy,
  approval,
  bearer,
  credential,
  credentialEnv,
  group,
  header,
  mcp,
  policy,
  sensitive,
  user,
} from "../../src/index.js";
import type { FentarisTransport, MiddlewareContext, ToolApprovalRequest } from "../../src/types.js";

class EnvTransport implements FentarisTransport {
  readonly env: Record<string, string>;
  readonly callToolMock = vi.fn(async (params: CallToolRequest["params"], env: Record<string, string>): Promise<CallToolResult> => ({
    content: [{ type: "text", text: `${params.name}:${env.AUTHORIZATION ?? env.GITHUB_TOKEN ?? env["x-api-key"] ?? "none"}` }],
  }));

  constructor(env: Record<string, string> = {}) {
    this.env = env;
  }

  withEnv(env: Record<string, string>): EnvTransport {
    return new EnvTransport({ ...this.env, ...env });
  }

  async listTools(): Promise<ListToolsResult> {
    return {
      tools: [
        { name: "read", inputSchema: { type: "object" } },
        { name: "write", inputSchema: { type: "object" } },
        { name: "delete", inputSchema: { type: "object" } },
      ],
    };
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return this.callToolMock(params, this.env);
  }

  async close(): Promise<void> {}
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("governance auth DX", () => {
  it("declares users and groups, resolves multi-group subjects, and validates conflicts", async () => {
    const alice = user("alice", { displayName: "Alice", tenantId: "tenant-1", metadata: { role: "admin" } });
    const admins = group({ id: "admins", users: [alice], policy: Policy.allowAll("admins") });
    const auditors = group({ id: "auditors", users: [alice], policy: Policy.allowAll("auditors") });
    const proxy = new McpProxy({
      groups: [admins, auditors],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });
    let seenGroups: string[] = [];

    proxy.use((_, ctx, next) => {
      seenGroups = ctx.subject?.groups.map((membership) => membership.id) ?? [];
      expect(ctx.subject?.hasGroup("admins")).toBe(true);
      expect(ctx.subject?.tenant).toEqual({ id: "tenant-1" });
      return next();
    });

    await proxy.callTool({ name: "github__read" }, { id: "alice" });
    expect(seenGroups).toEqual(["admins", "auditors"]);

    expect(
      () =>
        new McpProxy({
          groups: [
            group({ id: "first", users: [user("alice", { displayName: "Alice" })], policy: Policy.allowAll() }),
            group({ id: "second", users: [user("alice", { displayName: "Other Alice" })], policy: Policy.allowAll() }),
          ],
          servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
        }),
    ).toThrow(/conflicting metadata/);

    await expect(proxy.callTool({ name: "github__read" }, { id: "unknown" })).rejects.toThrow(/not declared/);
    expect(() => new Group({ id: "empty", users: [], policy: Policy.allowAll() })).toThrow(/at least one user/);
  });

  it("applies fluent group policies with wildcard allows, denies, approval, limiter, and sensitive metadata", async () => {
    const limiter = {
      metadata: { maxPerWindow: 1 },
      checkLimit: vi.fn(async () => true),
      recordCall: vi.fn(async () => undefined),
      getRemainingCalls: vi.fn(async () => 1),
    };
    const approvalRequests: unknown[] = [];
    const approvalHandler = vi.fn(async (request: ToolApprovalRequest, context: MiddlewareContext) => {
      approvalRequests.push({
        serverName: request.serverName,
        operation: request.operation,
        target: request.target,
        targetKind: request.targetKind,
        toolName: request.toolName,
        proxyToolName: request.proxyToolName,
        arguments: request.arguments,
        raw: request.raw,
      });
      return context.approval.approve({ reason: "owner-group" });
    });
    const allowPolicy = policy("writers")
      .mcp("github")
      .allow("*", { limiter, metadata: { scope: "repo" }, ...sensitive({ reason: "destructive" }) })
      .mcp("github")
      .deny("delete");
    const denyPolicy = policy("blocked").mcp("github").deny("write");
    const proxy = new McpProxy({
      groups: [
        group({ id: "writers", users: [user("alice")], policy: allowPolicy }),
        group({ id: "blocked", users: [user("alice")], policy: denyPolicy }),
        group({ id: "approvers", users: [user("alice")], policy: policy("approvers").mcp("github").allow("read", { approval: approvalHandler }) }),
      ],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });

    const tools = await proxy.listTools(undefined, { id: "alice" });
    expect(tools.tools.map((tool) => tool.name)).toEqual(["github__read"]);

    await proxy.callTool({ name: "github__read", arguments: { owner: "alice" } }, { id: "alice" });
    expect(approvalHandler).toHaveBeenCalledOnce();
    expect(approvalRequests).toEqual([
      {
        serverName: "github",
        operation: "tool:call",
        target: "read",
        targetKind: "tool",
        toolName: "read",
        proxyToolName: "github__read",
        arguments: { owner: "alice" },
        raw: { name: "github__read", arguments: { owner: "alice" } },
      },
    ]);

    const denied = await proxy.callTool({ name: "github__write" }, { id: "alice" });
    expect(denied.isError).toBe(true);
    expect(denied._meta?.error).toMatchObject({ message: expect.stringMatching(/denied/) });
  });

  it("denies approval callbacks through context helpers with structured metadata", async () => {
    const proxy = new McpProxy({
      groups: [
        group({
          id: "reviewed",
          users: [user("alice")],
          policy: policy("reviewed").mcp("github").allow(
            "delete",
            approval((request, context) =>
              context.approval.deny("Owner group required", {
                operation: request.operation,
                server: request.serverName,
                target: request.target,
              }),
            ),
          ),
        }),
      ],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });

    const result = await proxy.callTool({ name: "github__delete" }, { id: "alice" });

    expect(result.isError).toBe(true);
    expect(result._meta?.error).toMatchObject({ message: "Owner group required" });
    expect(JSON.stringify(result._meta)).toContain('"operation":"tool:call"');
    expect(JSON.stringify(result._meta)).toContain('"target":"delete"');
  });

  it("returns structured metadata for manual approval workflows", async () => {
    const proxy = new McpProxy({
      groups: [
        group({
          id: "reviewed",
          users: [user("alice")],
          policy: policy("reviewed").mcp("github").allow(
            "delete",
            approval.manual({
              requestId: (request, context) => `${context.user.id}:${request.serverName}:${request.toolName}`,
              url: "https://approvals.example/pending/1",
              reason: "Owner approval required",
              metadata: { workflow: "owner-review" },
            }),
          ),
        }),
      ],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });

    const result = await proxy.callTool({ name: "github__delete" }, { id: "alice" });

    expect(result.isError).toBe(true);
    expect(result._meta?.error).toMatchObject({ message: "Owner approval required" });
    expect(JSON.stringify(result._meta)).toContain("https://approvals.example/pending/1");
    expect(JSON.stringify(result._meta)).toContain("alice:github:delete");
  });

  it("loads encrypted local auth, resolves API keys, and keeps raw keys out of context", async () => {
    const auth = await createAuth({
      users: {
        alice: {
          apiKeys: ["old-key", "new-key"],
          credentials: { "github.token": "user-token" },
        },
      },
      groups: {},
      defaults: {},
    });
    const strategy = apiKeyIdentityStrategy({ auth });

    await expect(Promise.resolve(strategy.resolve({ headers: { "x-fentaris-api-key": "old-key" } }))).resolves.toEqual({ id: "alice" });
    await expect(Promise.resolve(strategy.resolve({ headers: { "x-fentaris-api-key": "new-key" } }))).resolves.toEqual({ id: "alice" });
    await expect(Promise.resolve(strategy.resolve({ headers: { "x-fentaris-api-key": "bad-key" } }))).resolves.toBeNull();
  });

  it("resolves credential precedence and injects upstream auth without exposing secrets", async () => {
    const auth = await createAuth({
      users: {
        alice: { apiKeys: ["key"], credentials: { "github.token": "user-token" } },
        bob: { apiKeys: ["bob-key"], credentials: {} },
        carol: { apiKeys: ["carol-key"], credentials: {} },
      },
      groups: {
        developers: { "github.token": "group-token" },
      },
      defaults: { "github.token": "default-token" },
    });
    const transport = new EnvTransport();
    const proxy = new McpProxy({
      auth,
      groups: [
        group({ id: "developers", users: [user("alice"), user("bob")], policy: Policy.allowAll("developers") }),
        group({ id: "guests", users: [user("carol")], policy: Policy.allowAll("guests") }),
      ],
      servers: [new McpServer({ name: "github", transport })],
    });
    const seen: Array<{ userSecret?: unknown; credentialReference?: string }> = [];

    proxy.use((_, ctx, next) => {
      seen.push({
        userSecret: ctx.user.secrets,
        credentialReference: ctx.credentialSources?.[0]?.reference,
      });
      return next();
    });

    await expect(proxy.callTool({ name: "github__read" }, { id: "alice" })).resolves.toMatchObject({
      content: [{ text: "read:Bearer user-token" }],
    });
    await expect(proxy.callTool({ name: "github__read" }, { id: "bob" })).resolves.toMatchObject({
      content: [{ text: "read:Bearer group-token" }],
    });
    await expect(proxy.callTool({ name: "github__read" }, { id: "carol" })).resolves.toMatchObject({
      content: [{ text: "read:Bearer default-token" }],
    });
    expect(seen).toEqual([
      { userSecret: undefined, credentialReference: "github.token" },
      { userSecret: undefined, credentialReference: "github.token" },
      { userSecret: undefined, credentialReference: "github.token" },
    ]);
  });

  it("declares API keys, credential sources, and server auth bindings in code", async () => {
    vi.stubEnv("ALICE_API_KEY", "alice-key");
    vi.stubEnv("SUPPORT_GITHUB_TOKEN", "support-token");
    vi.stubEnv("DEFAULT_STRIPE_KEY", "stripe-default");
    vi.stubEnv("DEFAULT_GITHUB_TOKEN", "internal-default");

    const proxy = new McpProxy({
      defaults: {
        credentials: {
          "stripe.apiKey": credentialEnv("DEFAULT_STRIPE_KEY"),
          "internal.token": credentialEnv("DEFAULT_GITHUB_TOKEN"),
        },
      },
      groups: [
        group({
          id: "support",
          users: [
            user("alice", {
              apiKeys: [credentialEnv("ALICE_API_KEY")],
            }),
          ],
          credentials: {
            "github.token": credentialEnv("SUPPORT_GITHUB_TOKEN"),
          },
          policy: Policy.allowAll("support"),
        }),
      ],
      servers: [
        mcp("github", {
          transport: new EnvTransport(),
          auth: bearer(credential("github.token")),
        }),
        mcp("stripe", {
          transport: new EnvTransport(),
          auth: header("x-api-key", credential("stripe.apiKey")),
        }),
        mcp("internal", {
          transport: new EnvTransport(),
          env: {
            GITHUB_TOKEN: credential("internal.token"),
          },
        }),
      ],
    });

    await expect(proxy.callTool({ name: "github__read" }, { id: "alice" })).resolves.toMatchObject({
      content: [{ text: "read:Bearer support-token" }],
    });
    await expect(proxy.callTool({ name: "stripe__read" }, { id: "alice" })).resolves.toMatchObject({
      content: [{ text: "read:stripe-default" }],
    });
    await expect(proxy.callTool({ name: "internal__read" }, { id: "alice" })).resolves.toMatchObject({
      content: [{ text: "read:internal-default" }],
    });
  });

  it("reports local auth validation and missing credential errors without secret values", async () => {
    await expect(createAuth({ users: {}, groups: {}, defaults: {} }, { servers: { github: { type: "unknown" } } })).rejects.toThrow(
      /Invalid upstream auth bindings file/,
    );

    const auth = await createAuth({ users: { alice: { apiKeys: ["key"], credentials: {} } }, groups: {}, defaults: {} });
    const proxy = new McpProxy({
      auth,
      groups: [group({ id: "users", users: [new User("alice")], policy: Policy.allowAll("users") })],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });
    const result = await proxy.callTool({ name: "github__read" }, { id: "alice" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("github.token");
    expect(JSON.stringify(result)).not.toContain("key");
  });

  it("supports permission helper objects", () => {
    expect(allow("read", { metadata: { scope: "repo" } })).toMatchObject({ tool: "read", effect: "allow" });
    expect(policy("named").mcp("github").allow("read").name).toBe("named");
  });

  it("keeps tool policy compatibility while accepting capability permissions", async () => {
    const globalPolicy = policy("global")
      .mcp("github")
      .allow("read")
      .mcp("github")
      .denyCapability({ operation: "resource:read", target: "file://secret.md", targetKind: "resource" });
    const groupPolicy = policy("group")
      .mcp("github")
      .allow("read")
      .mcp("github")
      .allowCapability({ operation: "prompt:get", target: "review", targetKind: "prompt" });

    await expect(
      globalPolicy.evaluate(
        { serverName: "github", toolName: "read", proxyToolName: "github__read", arguments: {}, raw: { name: "github__read" } },
        { id: "alice" },
      ),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      globalPolicy.evaluate(
        { serverName: "github", operation: "resource:read", target: "file://secret.md", targetKind: "resource" },
        { id: "alice" },
      ),
    ).resolves.toMatchObject({ allowed: false, reason: 'Operation "resource:read" denied by policy "global"' });
    await expect(
      groupPolicy.evaluate(
        { serverName: "github", operation: "prompt:get", target: "review", targetKind: "prompt" },
        { id: "alice" },
      ),
    ).resolves.toMatchObject({
      allowed: true,
      metadata: {
        matchedPermissions: [
          expect.objectContaining({
            operation: "prompt:get",
            target: "review",
            targetKind: "prompt",
          }),
        ],
      },
    });
  });

  it("exposes structured subject, auth, policy, and compatibility aliases", async () => {
    const alice = user("alice", {
      displayName: "Alice",
      email: "alice@example.com",
      tenant: { id: "tenant-1", plan: "pro" },
      metadata: { locale: "it" },
    });
    const proxy = new McpProxy({
      groups: [group({ id: "admins", users: [alice], policy: policy("admins").mcp("github").allow("read", { metadata: { scope: "repo" } }) })],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });
    const seen: unknown[] = [];

    proxy.use((ctx, next) => {
      seen.push({
        subjectId: ctx.subject?.id,
        email: ctx.subject?.email,
        metadata: ctx.subject?.metadata,
        tenant: ctx.subject?.tenant,
        groups: ctx.subject?.groups.map((membership) => membership.id),
        hasAdmins: ctx.subject?.hasGroup("admins"),
        authenticated: ctx.auth.authenticated,
        authUserId: ctx.auth.userId,
        allowed: ctx.policy.allowed,
        reason: ctx.policy.reason,
        matchedGroups: ctx.policy.matchedGroups,
        matchedPermissions: ctx.policy.matchedPermissions.map((permission) => ({
          policyName: permission.policyName,
          groupId: permission.groupId,
          serverName: permission.serverName,
          toolName: permission.toolName,
          effect: permission.effect,
          metadata: permission.metadata,
        })),
        canRead: ctx.policy.can("github", "read"),
        userAlias: ctx.user.id,
        decisionAlias: ctx.policyDecision === ctx.policy.decision,
        responseAlias: ctx.res === ctx.response,
      });
      return next();
    });

    await proxy.callTool({ name: "github__read" }, { id: "alice" });

    expect(seen).toEqual([
      {
        subjectId: "alice",
        email: "alice@example.com",
        metadata: { locale: "it" },
        tenant: { id: "tenant-1", plan: "pro" },
        groups: ["admins"],
        hasAdmins: true,
        authenticated: true,
        authUserId: "alice",
        allowed: true,
        reason: undefined,
        matchedGroups: ["admins"],
        matchedPermissions: [
          {
            policyName: "admins",
            groupId: "admins",
            serverName: "github",
            toolName: "read",
            effect: "allow",
            metadata: { scope: "repo" },
          },
        ],
        canRead: true,
        userAlias: "alice",
        decisionAlias: true,
        responseAlias: true,
      },
    ]);
  });

  it("keeps unauthenticated contexts explicit without creating an anonymous subject", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });
    const seen: unknown[] = [];

    proxy.use((ctx, next) => {
      seen.push({
        authenticated: ctx.auth.authenticated,
        subject: ctx.subject,
        policyCanRead: ctx.policy.can("github", "read"),
      });
      return next();
    });

    await proxy.callTool({ name: "github__read" });

    expect(seen).toEqual([{ authenticated: false, subject: undefined, policyCanRead: true }]);
  });

  it("reports denied policy metadata through the structured policy domain", async () => {
    const proxy = new McpProxy({
      groups: [group({ id: "blocked", users: [user("alice")], policy: policy("blocked").mcp("github").deny("delete") })],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });
    const seen: unknown[] = [];

    proxy.use((ctx, next) => {
      seen.push({
        allowed: ctx.policy.allowed,
        reason: ctx.policy.reason,
        matchedGroups: ctx.policy.matchedGroups,
        matchedPermissions: ctx.policy.matchedPermissions.map((permission) => ({
          policyName: permission.policyName,
          groupId: permission.groupId,
          serverName: permission.serverName,
          toolName: permission.toolName,
          effect: permission.effect,
        })),
      });
      return next();
    });

    const result = await proxy.callTool({ name: "github__delete" }, { id: "alice" });

    expect(result.isError).toBe(true);
    expect(seen).toEqual([
      {
        allowed: false,
        reason: 'Tool "delete" denied by policy "blocked"',
        matchedGroups: ["blocked"],
        matchedPermissions: [
          {
            policyName: "blocked",
            groupId: "blocked",
            serverName: "github",
            toolName: "delete",
            effect: "deny",
          },
        ],
      },
    ]);
  });

  it("checks capabilities with group policies, global policy, and no configured policy", async () => {
    const approval = vi.fn(async () => true);
    const groupProxy = new McpProxy({
      groups: [
        group({ id: "admins", users: [user("alice")], policy: policy("admins").mcp("github").allow("delete") }),
        group({ id: "blocked", users: [user("alice")], policy: policy("blocked").mcp("github").deny("delete") }),
        group({ id: "readers", users: [user("alice")], policy: policy("readers").mcp("github").allow("read", { approval }) }),
      ],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });
    const groupChecks: unknown[] = [];
    groupProxy.use((ctx, next) => {
      groupChecks.push({
        canRead: ctx.policy.can("github", "read"),
        canDelete: ctx.policy.can("github", "delete"),
        canWrite: ctx.policy.can("github", "write"),
      });
      return next();
    });

    const groupResult = await groupProxy.callTool({ name: "github__delete" }, { id: "alice" });

    const globalProxy = new McpProxy({
      policy: policy("global").mcp("github").allow("read").mcp("github").deny("delete"),
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });
    const globalChecks: unknown[] = [];
    globalProxy.use((ctx, next) => {
      globalChecks.push({
        canRead: ctx.policy.can("github", "read"),
        canDelete: ctx.policy.can("github", "delete"),
        canWrite: ctx.policy.can("github", "write"),
      });
      return next();
    });

    await globalProxy.callTool({ name: "github__read" });

    const permissiveProxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });
    const permissiveChecks: unknown[] = [];
    permissiveProxy.use((ctx, next) => {
      permissiveChecks.push(ctx.policy.can("github", "delete"));
      return next();
    });

    await permissiveProxy.callTool({ name: "github__read" });

    expect(groupChecks).toEqual([{ canRead: true, canDelete: false, canWrite: false }]);
    expect(globalChecks).toEqual([{ canRead: true, canDelete: false, canWrite: false }]);
    expect(permissiveChecks).toEqual([true]);
    expect(groupResult.isError).toBe(true);
    expect(approval).not.toHaveBeenCalled();
  });

  it("does not expose raw credential values through structured context domains", async () => {
    const auth = await createAuth({
      users: {
        alice: {
          apiKeys: ["raw-api-key"],
          credentials: { "github.token": "super-secret-token" },
        },
      },
      groups: {},
      defaults: {},
    });
    const proxy = new McpProxy({
      auth,
      groups: [group({ id: "admins", users: [user("alice")], policy: Policy.allowAll("admins") })],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });
    const inspected: string[] = [];

    proxy.use((ctx, next) => {
      inspected.push(JSON.stringify({
        subject: ctx.subject,
        auth: ctx.auth,
        policy: ctx.policy,
        credentials: ctx.credentials,
      }));
      return next();
    });

    await proxy.callTool({ name: "github__read" }, { id: "alice" });

    expect(inspected).toHaveLength(1);
    expect(inspected[0]).not.toContain("raw-api-key");
    expect(inspected[0]).not.toContain("super-secret-token");
    expect(inspected[0]).toContain("github.token");
  });
});

async function createAuth(
  credentials: Parameters<typeof FentarisAuth.encryptCredentials>[0],
  upstreamAuth: unknown = { servers: { github: { type: "bearer", credential: "github.token" } } },
): Promise<FentarisAuth> {
  const dir = await mkdtemp(join(tmpdir(), "fentaris-auth-"));
  const key = "test-key";
  await writeFile(join(dir, "credentials.enc.json"), JSON.stringify(FentarisAuth.encryptCredentials(credentials, key)));
  await writeFile(join(dir, "upstream-auth.json"), JSON.stringify(upstreamAuth));
  return FentarisAuth.local({ dir, key });
}
