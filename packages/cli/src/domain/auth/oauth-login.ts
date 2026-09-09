import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  fentaris,
  LocalOAuthTokenStore,
  type McpProxy,
  type McpProxyOptions,
  type OAuthManager,
  type OAuthSessionKey,
  type OAuthStoreEntry,
} from "@fentaris/core";
import { loadProjectEnv } from "../project/env.js";
import { authDirectory } from "../secrets/backend.js";
import { authKeyFromRuntime } from "./local-store.js";
import type { CliOptions, ProjectDiscovery, Runtime } from "../../shared/types.js";
import { discoverSecretsProject } from "../project/project.js";

const defaultLoopbackPath = "/callback";

/**
 * Everything the CLI needs to drive OAuth against a project's upstream servers.
 */
export type OAuthCliContext = {
  project: ProjectDiscovery;
  app: McpProxy;
  manager: OAuthManager;
  store: LocalOAuthTokenStore;
  oauthServers: string[];
  sessionKeyFor(server: string, selector?: string): OAuthSessionKey;
  close(): Promise<void>;
};

export type OAuthLoginOutcome = {
  server: string;
  session: OAuthSessionKey;
  status: "authenticated" | "authorization-required" | "failed";
  authorizationUrl?: string;
  redirectUri?: string;
  reason?: string;
};

/**
 * Load the project config, open the shared encrypted token store, and build a manager
 * whose callback is a loopback listener owned by this CLI process.
 */
export async function openOAuthCliContext(
  runtime: Runtime,
  options: CliOptions,
  behavior: { port?: number; withCallback?: boolean } = {},
): Promise<OAuthCliContext> {
  const project = await discoverSecretsProject(runtime.cwd, { requireEntrypoint: true });
  const env = await loadProjectEnv(project.root, runtime.env);
  const key = await authKeyFromRuntime({ ...runtime, env }, options);
  const config = await loadProjectConfig(project);

  const store = new LocalOAuthTokenStore({ dir: authDirectory(project), key });
  // Reuse the proxy wiring so the CLI registers upstream servers exactly like the runtime.
  const app = fentaris({ ...config, oauth: { ...config.oauth, store } });
  const manager = app.oauth();
  if (!manager) {
    throw new Error("No MCP server in this project is declared with oauth().");
  }

  let listener: Server | undefined;
  if (behavior.withCallback !== false) {
    listener = await startLoopbackListener(manager, behavior.port);
    const address = listener.address() as AddressInfo;
    manager.setCallbackUrl(`http://127.0.0.1:${address.port}${defaultLoopbackPath}`);
  }

  return {
    project,
    app,
    manager,
    store,
    oauthServers: manager.servers(),
    sessionKeyFor(server, selector): OAuthSessionKey {
      const userId = selectorUserId(selector);
      return manager.sessionKeyFor(server, userId ? { id: userId } : {});
    },
    async close(): Promise<void> {
      if (listener) {
        await new Promise<void>((resolve) => {
          listener?.closeAllConnections?.();
          listener?.close(() => resolve());
        });
      }

      await app.close();
    },
  };
}

/**
 * Run one interactive login: begin the flow, surface the URL, and wait for the callback.
 */
export async function runOAuthLogin(
  context: OAuthCliContext,
  params: { server: string; selector?: string; printUrl: boolean; openBrowser: boolean; timeoutMs?: number },
  runtime: Runtime,
): Promise<OAuthLoginOutcome> {
  const session = context.sessionKeyFor(params.server, params.selector);
  const user = selectorUserId(params.selector) ? { id: selectorUserId(params.selector) as string } : {};
  const started = await context.manager.beginLogin(params.server, user);

  if (started.status === "authenticated") {
    return { server: params.server, session, status: "authenticated" };
  }

  if (!started.authorizationUrl || !started.state) {
    return { server: params.server, session, status: "failed", reason: "The authorization server did not return an authorization URL." };
  }

  if (params.printUrl || !params.openBrowser) {
    runtime.out.log(started.authorizationUrl);
  } else {
    openInBrowser(started.authorizationUrl, runtime);
  }

  const outcome = await context.manager.waitForCompletion(started.state, params.timeoutMs ?? 300_000);
  if (outcome.status === "completed") {
    return { server: params.server, session, status: "authenticated", redirectUri: context.manager.getCallbackUrl() };
  }

  return {
    server: params.server,
    session,
    status: "authorization-required",
    authorizationUrl: started.authorizationUrl,
    reason: outcome.status === "timeout" ? "Timed out waiting for the authorization callback." : outcome.reason,
  };
}

/**
 * Stored authorization state for every OAuth server in the project.
 */
export async function oauthStatusEntries(context: OAuthCliContext): Promise<
  Array<{ server: string; session: OAuthSessionKey; status: string; expiresAt?: string }>
> {
  const stored: OAuthStoreEntry[] = await context.manager.list();
  const rows = await Promise.all(
    context.oauthServers.flatMap((server) => {
      const sessions = stored.filter((entry) => entry.server === server).map((entry) => entry.session);
      const targets = sessions.length > 0 ? sessions : (["shared"] as OAuthSessionKey[]);
      return targets.map(async (session) => ({
        server,
        session,
        status: await context.manager.status(server, session),
        ...(expiryOf(stored, server, session) ? { expiresAt: expiryOf(stored, server, session) } : {}),
      }));
    }),
  );

  return rows;
}

function expiryOf(stored: OAuthStoreEntry[], server: string, session: OAuthSessionKey): string | undefined {
  const entry = stored.find((candidate) => candidate.server === server && candidate.session === session);
  return entry?.expiresAt ? new Date(entry.expiresAt).toISOString() : undefined;
}

/**
 * Selector form is `user:<id>`; anything else means the shared authorization.
 */
export function selectorUserId(selector: string | undefined): string | undefined {
  if (!selector) {
    return undefined;
  }

  const trimmed = selector.trim();
  return trimmed.startsWith("user:") ? trimmed.slice("user:".length) || undefined : undefined;
}

async function startLoopbackListener(manager: OAuthManager, port?: number): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== defaultLoopbackPath) {
        res.writeHead(404).end();
        return;
      }

      const state = url.searchParams.get("state") ?? "";
      try {
        await manager.completeCallback({
          state,
          ...(url.searchParams.get("code") ? { code: url.searchParams.get("code") as string } : {}),
          ...(url.searchParams.get("error") ? { error: url.searchParams.get("error") as string } : {}),
        });
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Signed in. You can close this tab.");
      } catch (error: unknown) {
        res
          .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          .end(error instanceof Error ? error.message : "Authorization failed.");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port ?? 0, "127.0.0.1", () => resolve());
  });

  return server;
}

async function loadProjectConfig(project: ProjectDiscovery): Promise<McpProxyOptions> {
  const entrypoint = pathToFileURL(join(project.root, project.config.entrypoint)).href;
  const module = (await import(`${entrypoint}?fentarisOAuth=${Date.now()}`)) as Record<string, unknown>;
  const config = module.fentarisConfig ?? module.config ?? module.default;
  if (!config || typeof config !== "object") {
    throw new Error("Project entrypoint must export a Fentaris config as default, config, or fentarisConfig.");
  }

  return config as McpProxyOptions;
}

function openInBrowser(url: string, runtime: Runtime): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.unref();
  } catch {
    runtime.out.log(url);
  }
}
