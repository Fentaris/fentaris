import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FentarisAuth } from "../src/auth.js";
import { credential, credentialEnv, credentialJson } from "../src/credentials/index.js";
import { mcp } from "../src/server/index.js";
import { oauth, oauthTokens } from "../src/auth/oauth/index.js";
import { streamableHttp } from "../src/transports/client/StreamableHttpMcpTransport.js";
import { group, Policy, user } from "../src/governance.js";
import { fentaris } from "../src/proxy/McpProxy.js";
import type { ProxyExposureHandle, ProxyExposureTransport, ProxyRuntime } from "../src/types/proxy.js";

class ProbeExposure implements ProxyExposureTransport {
  readonly listen = vi.fn(async (_runtime: ProxyRuntime): Promise<ProxyExposureHandle> => ({ close: async () => {} }));
}

describe("runtime credential readiness", () => {
  const tempDirs: string[] = [];
  const envNames = [
    "FENTARIS_TEST_DEFAULT_TOKEN",
    "FENTARIS_TEST_GROUP_TOKEN",
    "FENTARIS_TEST_USER_TOKEN",
    "FENTARIS_TEST_ADMIN_KEY",
    "FENTARIS_TEST_OPERATOR_KEY",
  ];

  afterEach(async () => {
    for (const name of envNames) delete process.env[name];
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("fails before opening a transport and aggregates missing declarations", async () => {
    const app = fentaris({
      policy: Policy.allowAll(),
      defaults: { credentials: { "default.token": credentialEnv(envNames[0]!) } },
      groups: [group({
        id: "operators",
        credentials: { "group.token": credentialEnv(envNames[1]!) },
        users: [
          user("admin", {
            credentials: { "user.token": credentialEnv(envNames[2]!) },
            apiKeys: [credentialEnv(envNames[3]!)],
          }),
          user("operator", { apiKeys: [credentialEnv(envNames[4]!)] }),
        ],
        policy: Policy.allowAll(),
      })],
    });
    const exposure = new ProbeExposure();

    const error = await app.listen(exposure).catch((caught: unknown) => caught) as { code?: string; message?: string; context?: unknown };
    expect(error.code).toBe("FENTARIS_CREDENTIALS_UNAVAILABLE");
    expect(error.message).toContain("default credential default.token");
    expect(error.message).toContain("group operators credential group.token");
    expect(error.message).toContain("user admin credential user.token");
    expect(error.message).toContain("user admin API key");
    expect(error.message).toContain("user operator API key");
    expect(error.context).toMatchObject({ requirements: expect.any(Array) });
    expect(exposure.listen).not.toHaveBeenCalled();
  });

  it("starts when every declared environment source is available", async () => {
    process.env[envNames[3]!] = "client-key";
    const app = fentaris({
      policy: Policy.allowAll(),
      groups: [group({ id: "admins", users: [user("admin", { apiKeys: [credentialEnv(envNames[3]!)] })], policy: Policy.allowAll() })],
    });
    const exposure = new ProbeExposure();

    await expect(app.listen(exposure)).resolves.toBeDefined();
    expect(exposure.listen).toHaveBeenCalledOnce();
    await app.close();
  });

  it("sanitizes local decryption failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-readiness-"));
    tempDirs.push(dir);
    const file = join(dir, "credentials.enc.json");
    await writeFile(file, JSON.stringify(FentarisAuth.encryptCredentials({ users: { admin: { apiKeys: ["hash"], credentials: {} } }, groups: {}, defaults: {} }, "correct-secret-key")));
    const app = fentaris({
      policy: Policy.allowAll(),
      groups: [group({
        id: "admins",
        users: [user("admin", { apiKeys: [credentialJson("users.admin.apiKeys.0", { file, key: "wrong-secret-key" })] })],
        policy: Policy.allowAll(),
      })],
    });
    const exposure = new ProbeExposure();

    const error = await app.listen(exposure).catch((caught: unknown) => caught) as { code?: string; message?: string };
    expect(error.code).toBe("FENTARIS_CREDENTIALS_UNAVAILABLE");
    expect(error.message).not.toContain("wrong-secret-key");
    expect(error.message).not.toContain(await readFile(file, "utf8"));
    expect(exposure.listen).not.toHaveBeenCalled();
  });

  it("starts without stored OAuth tokens", async () => {
    const app = fentaris({
      policy: Policy.allowAll(),
      oauth: { store: oauthTokens.memory() },
      servers: [mcp("linear", { transport: streamableHttp({ url: "https://mcp.linear.app/mcp" }), auth: oauth() })],
    });
    const exposure = new ProbeExposure();

    await expect(app.listen(exposure)).resolves.toBeDefined();
    expect(exposure.listen).toHaveBeenCalledOnce();
    await app.close();
  });

  it("includes a declared OAuth client secret source in the readiness gate", async () => {
    const app = fentaris({
      policy: Policy.allowAll(),
      oauth: { store: oauthTokens.memory() },
      defaults: { credentials: { "github.oauth.secret": credentialEnv(envNames[0]!) } },
      servers: [
        mcp("github", {
          transport: streamableHttp({ url: "https://api.githubcopilot.com/mcp/" }),
          auth: oauth({ clientId: "Iv1.abc", clientSecret: credential("github.oauth.secret") }),
        }),
      ],
    });
    const exposure = new ProbeExposure();

    const error = await app.listen(exposure).catch((caught: unknown) => caught) as { code?: string; message?: string };
    expect(error.code).toBe("FENTARIS_CREDENTIALS_UNAVAILABLE");
    expect(error.message).toContain("oauth client secret github.oauth.secret for server github");
    expect(exposure.listen).not.toHaveBeenCalled();
  });
});
