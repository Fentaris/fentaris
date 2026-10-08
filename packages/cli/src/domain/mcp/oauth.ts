import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { OAuthManager, MemoryOAuthTokenStore, bounded, type OAuthSessionKey, type McpServer } from "@fentaris/core";
import { browserLaunchCommand } from "../auth/oauth-login.js";
import type { McpCliContext } from "./context.js";
import { canPrompt, CommandInputError } from "../../shared/input.js";
import type { CliOptions } from "../../shared/types.js";

/** Transactional OAuth: intermediate registration and tokens remain private until consent completes. */
export async function connectOAuth(context: McpCliContext, connection: McpServer, account: string, options: CliOptions, credentials?: { clientSecret?: string; commit?: () => Promise<void> }): Promise<void> {
  const auth = connection.getOAuthAuth();
  if (auth?.grant !== "client_credentials" && !canPrompt(context.runtime, options) && options["print-url"] !== true) throw new CommandInputError(["oauth-authorization"], `fentaris mcp auth connect ${connection.name} --account ${account} --print-url --non-interactive`);
  const transport = connection.transport as typeof connection.transport & { upstreamUrl?: string; createGuardedFetch?: () => typeof fetch };
  if (!auth || !transport.upstreamUrl || !transport.createGuardedFetch) throw new Error("This connection does not provide an OAuth-capable upstream transport.");
  const session: OAuthSessionKey = `account:${account}`;
  const buffer = new MemoryOAuthTokenStore();
  const previous = await context.tokenStore.get(connection.name, session);
  if (previous) await buffer.set(connection.name, session, options.reauth === true ? { ...previous, tokens: undefined } : previous);
  const manager = new OAuthManager({ store: buffer });
  const controller = new AbortController();
  const guardedFetch = transport.createGuardedFetch();
  manager.register(connection.name, { auth, serverUrl: transport.upstreamUrl, fetchFn: (input, init) => guardedFetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }), resolveClientSecret: typeof auth.clientSecret === "object" ? async () => credentials?.clientSecret ?? context.vault.resolve((auth.clientSecret as { reference: string }).reference) : undefined });
  let listener: Server | undefined;
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    if (auth.grant !== "client_credentials") {
      const configured = auth.redirectUrl ? new URL(auth.redirectUrl) : undefined;
      if (configured && (configured.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(configured.hostname) || configured.username || configured.password || configured.search || configured.hash)) throw new Error("CLI OAuth requires an HTTP loopback redirect URL without credentials, query, or fragment. Configure oauth({ redirectUrl: 'http://127.0.0.1:<PORT>/callback' }) or omit redirectUrl for an ephemeral callback.");
      const host = configured?.hostname === "[::1]" ? "::1" : configured?.hostname ?? "127.0.0.1";
      const path = configured?.pathname ?? "/callback";
      const configuredPort = configured ? Number(configured.port || 80) : undefined;
      const port = typeof options.port === "string" ? Number(options.port) : configuredPort ?? 0;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("OAuth callback port must be an integer from 0 to 65535.");
      if (configuredPort !== undefined && port !== configuredPort) throw new Error("--port must match the configured OAuth redirect URL. Update redirectUrl or omit --port.");
      listener = createServer((req, res) => {
        void (async () => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          if (url.pathname !== path) { res.writeHead(404).end(); return; }
          try {
            await manager.completeCallback({ state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? undefined, error: url.searchParams.get("error") ?? undefined });
            res.writeHead(200, { "content-type": "text/plain" }).end("Account connected. You can close this tab.");
          } catch { res.writeHead(400).end("Authorization failed. Return to the CLI for recovery instructions."); }
        })();
      });
      await new Promise<void>((resolve, reject) => { listener!.once("error", reject); listener!.listen(port, host, resolve); });
      manager.setCallbackUrl(configured?.href ?? `http://127.0.0.1:${(listener.address() as AddressInfo).port}${path}`);
    }
    const user = { upstreamAccounts: { [connection.name]: account } };
    const started = await bounded(() => manager.beginLogin(connection.name, user), 60000, controller.signal).catch((error) => {
      throw new Error(controller.signal.aborted ? "Authorization cancelled before any connection changes were committed." : "The provider could not start OAuth authorization. Existing authorization was preserved; check provider configuration and retry connect.", { cause: error });
    });
    if (started.status !== "authenticated") {
      if (!started.authorizationUrl || !started.state) throw new Error("Authorization did not provide a usable browser flow.");
      if (options["print-url"] === true) context.runtime.out.error(started.authorizationUrl);
      else {
        const [command, args] = browserLaunchCommand(process.platform, started.authorizationUrl);
        const child = spawn(command, [...args], { stdio: "ignore", detached: true, shell: false });
        child.once("error", () => context.runtime.out.error(`Open this authorization URL in your browser: ${started.authorizationUrl}`)); child.unref();
      }
      const timeout = typeof options.timeout === "string" ? Number(options.timeout) : 300000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) throw new Error("OAuth timeout must be an integer from 1 to 300000 milliseconds.");
      const result = await bounded(() => manager.waitForCompletion(started.state!, timeout), timeout + 50, controller.signal);
      if (result.status !== "completed") throw new Error("Authorization did not complete. Existing account credentials were preserved; retry connect.");
    }
    if (controller.signal.aborted) throw new Error("Authorization cancelled before any connection changes were committed.");
    const record = await buffer.get(connection.name, session);
    if (!record?.tokens) throw new Error("Authorization completed without usable tokens.");
    await credentials?.commit?.();
    await context.tokenStore.set(connection.name, session, record);
  } finally {
    controller.abort();
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    manager.pending.clear(connection.name, session);
    if (listener) { listener.closeAllConnections(); await new Promise<void>((resolve) => listener!.close(() => resolve())); }
  }
}

export async function revokeOAuth(context: McpCliContext, connection: McpServer, account: string): Promise<"revoked" | "unsupported" | "failed" | "unnecessary"> {
  const record = await context.tokenStore.get(connection.name, `account:${account}`);
  const token = record?.tokens?.refresh_token ?? record?.tokens?.access_token;
  if (!token) return "unnecessary";
  const endpoint = (record?.discovery?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
  if (!endpoint) return "unsupported";
  const transport = connection.transport as typeof connection.transport & { createGuardedFetch?: () => typeof fetch };
  if (!transport.createGuardedFetch) return "unsupported";
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) return "failed";
    const body = new URLSearchParams({ token, token_type_hint: record?.tokens?.refresh_token ? "refresh_token" : "access_token" });
    const auth = connection.getOAuthAuth();
    const configuredSecret = typeof auth?.clientSecret === "object" ? await context.vault.resolve(auth.clientSecret.reference) : auth?.clientSecret;
    const client = record?.clientInformation ?? (auth?.clientId ? { client_id: auth.clientId, client_secret: configuredSecret } : undefined);
    if (client?.client_id) body.set("client_id", client.client_id);
    const metadata = record?.discovery?.authorizationServerMetadata as { revocation_endpoint_auth_methods_supported?: string[]; token_endpoint_auth_methods_supported?: string[] } | undefined;
    const methods = metadata?.revocation_endpoint_auth_methods_supported ?? metadata?.token_endpoint_auth_methods_supported ?? [];
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (client?.client_secret && methods.includes("client_secret_basic")) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString("base64")}`;
    else if (client?.client_secret) body.set("client_secret", client.client_secret);
    const response = await transport.createGuardedFetch()(url, { method: "POST", body, headers, signal: AbortSignal.timeout(5000) });
    return response.ok ? "revoked" : "failed";
  } catch { return "failed"; }
}
