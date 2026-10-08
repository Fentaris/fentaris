import { LocalOAuthTokenStore, McpDiscoveryService, oauthTokensExpireAt, updateMcpConnectionState, type McpDiscoveryResult, type McpDiscoveryRow, type McpServer } from "@fentaris/core";
import { openMcpContext, type McpCliContext } from "../domain/mcp/context.js";
import { connectOAuth, revokeOAuth } from "../domain/mcp/oauth.js";
import { canPrompt, chooseAction, completeInput, commandResult, commandValue } from "../shared/input.js";
import type { CliCommand, CliOptions, Runtime } from "../shared/types.js";

export async function runMcp(command: CliCommand, runtime: Runtime): Promise<number> {
  const options = await completeOptionValues(command.options, runtime, command.args);
  const context = await openMcpContext(runtime, options);
  try {
    if (command.args[0] === "auth") return runAuthentication(context, command.args.slice(1), options);
    return runRead(context, command.args, options);
  } finally { await context.close(); }
}

async function completeOptionValues(options: CliOptions, runtime: Runtime, args: string[]): Promise<CliOptions> {
  const result = { ...options };
  for (const name of ["account", "timeout", "secret", "credential", "port", "from-session", "key"]) if (typeof options[name] === "string" && !(options[name] as string).trim()) throw new Error(`Invalid empty value for --${name}.`);
  for (const name of ["account", "timeout", "secret", "credential", "port", "from-session", "key"]) if (options[name] === true) {
    const supplied = Object.entries(options).filter(([key, value]) => key !== name && typeof value === "string" && key !== "key").map(([key, value]) => `--${key} ${commandValue(value as string)}`);
    const input = await completeInput(runtime, options, [{ name, question: name === "key" ? "Vault unlock key" : `Value for --${name}`, secret: name === "key" }], ["fentaris mcp", ...args, ...supplied, `--${name} <VALUE>`].join(" "));
    result[name] = input[name];
  }
  if (typeof result.timeout === "string" && (!/^\d+$/.test(result.timeout) || Number(result.timeout) < 1 || Number(result.timeout) > 300000)) throw new Error("Timeout must be a positive integer no greater than 300000 milliseconds.");
  if (typeof result.account === "string") validateAlias(result.account);
  if (typeof result.port === "string" && (!/^\d+$/.test(result.port) || Number(result.port) > 65535)) throw new Error("OAuth callback port must be an integer from 0 to 65535.");
  if (typeof result["from-session"] === "string" && result["from-session"] !== "shared" && !/^user:.+/.test(result["from-session"])) throw new Error("Migration requires an explicit legacy session, shared or user:<id>.");
  if (typeof result.secret === "string" && result.secret.startsWith("fentaris.internal.oauth.")) throw new Error("OAuth lifecycle references cannot be used as ordinary named secrets.");
  return result;
}

async function runRead(context: McpCliContext, args: string[], options: CliOptions): Promise<number> {
  const family = args[0];
  let server = family === "get" || family === "tools" ? args[1] : undefined;
  let toolName: string | undefined;
  if (family === "get" && !server) server = await chooseServer(context, options, "fentaris mcp get <MCP>");
  if (family === "tools" && ["get", "schema"].includes(args[1])) {
    const input = await completeInput(context.runtime, { ...options, tool: args[2] ?? true }, [{ name: "tool", question: "Proxied tool name" }], `fentaris mcp tools ${args[1]} <MCP__TOOL> --account <ACCOUNT>`);
    toolName = input.tool;
    const delimiter = toolName.indexOf("__");
    if (delimiter < 1 || !toolName.slice(delimiter + 2)) throw new Error("Tool name must be a complete proxied name such as gmail__search_messages.");
    server = toolName.slice(0, delimiter);
    const selected = await selectConnection(context, server, options, `fentaris mcp tools ${args[1]} ${toolName} --account <ACCOUNT>`);
    options = { ...options, account: selected.account };
  }
  const result = await discover(context, options, server);
  let data: unknown;
  if (toolName) {
    const tools = result.connections.flatMap((row) => row.tools);
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      if (result.exitCode) { printDiscovery(context.runtime, result, options, "tools"); return result.exitCode; }
      throw new Error(`Tool "${toolName}" is unavailable on the selected connection${options.offline ? "; cached offline metadata may be absent" : ""}. Run fentaris mcp tools ${server} --account ${options.account}.`);
    }
    data = args[1] === "schema" ? { name: tool.name, ...((options.input === true || options.output !== true) ? { inputSchema: tool.inputSchema } : {}), ...((options.output === true || options.input !== true) ? { outputSchema: tool.outputSchema ?? null } : {}) } : tool;
  }
  if (data !== undefined) context.runtime.out.log(options.json === true ? JSON.stringify({ ...result, data }) : JSON.stringify(data, null, 2));
  else printDiscovery(context.runtime, result, options, family === "tools" ? "tools" : family === "get" ? "details" : "inventory");
  return result.exitCode;
}

async function discover(context: McpCliContext, options: CliOptions, server?: string): Promise<McpDiscoveryResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const clear = options.json !== true && options.offline !== true ? context.runtime.progress?.("Contacting MCP connections…") : undefined;
  try {
    const service = new McpDiscoveryService(context.config, { secrets: (ref) => context.vault.resolve(ref), oauthStore: context.tokenStore });
    const result = await service.discover({ server, account: typeof options.account === "string" ? options.account : undefined, offline: options.offline === true, timeoutMs: typeof options.timeout === "string" ? Number(options.timeout) : 5000, signal: controller.signal, cache: context.cache });
    if (options.offline !== true) {
      for (const row of result.connections) if (row.toolMetadata.source === "verified") context.cache[`${row.server}\u0000${row.account}`] = { checkedAt: row.toolMetadata.checkedAt!, tools: row.tools };
      await context.saveCache(context.cache);
    }
    return result;
  } finally { clear?.(); process.off("SIGINT", abort); process.off("SIGTERM", abort); }
}

async function runAuthentication(context: McpCliContext, args: string[], options: CliOptions): Promise<number> {
  let action = args[0];
  let fromMenu = false;
  if (!action) {
    const inventory = await discover(context, options);
    printDiscovery(context.runtime, inventory, options, "inventory");
    if (!canPrompt(context.runtime, options)) return inventory.exitCode;
    action = await chooseAction(context.runtime, options, ["get", "connect", "disconnect", "migrate"], "fentaris mcp auth <ACTION> <MCP> --account <ACCOUNT>");
    fromMenu = true;
  }
  const server = args[1] ?? await chooseServer(context, options, `fentaris mcp auth ${action} <MCP> --account <ACCOUNT>`);
  const selected = await selectConnection(context, server, options, `fentaris mcp auth ${action} ${server} --account <ACCOUNT>`);
  const { account, connection } = selected;
  if (action === "get") {
    const result = await discover(context, { ...options, account }, server);
    printDiscovery(context.runtime, result, options, "details"); return result.exitCode;
  }
  if (options.offline === true) throw new Error("--offline is available only on read commands; authentication changes require an explicit connect/disconnect/migrate command.");
  if (fromMenu && !await context.runtime.prompt.confirm(`${action[0].toUpperCase()}${action.slice(1)} MCP "${server}" account "${account}"?`)) throw new Error("Command cancelled before any changes were made.");
  const consumer = { kind: "mcp" as const, server, account };
  if (action === "disconnect") {
    if (!connection.getOAuthAuth() && connection.getCredentialBindings().length === 0) {
      commandResult(context.runtime, options, { server, account, status: "unnecessary", remoteRevocation: "unnecessary" }, `No Fentaris-managed authorization exists for ${server} (${account}).`);
      return 0;
    }
    if (connection.getOAuthAuth() && !context.config.oauth?.store) await context.vault.ensureUnlocked?.(options, `fentaris mcp auth disconnect ${server} --account ${account}`);
    const remoteRevocation = connection.getOAuthAuth() ? await revokeOAuth(context, connection, account) : "unnecessary";
    if (connection.getOAuthAuth()) await context.tokenStore.delete(server, `account:${account}`);
    for (const binding of connection.getCredentialBindings()) await context.vault.detachConsumer(binding.credential.reference, consumer);
    const clientSecret = connection.getOAuthAuth()?.clientSecret;
    if (typeof clientSecret === "object") await context.vault.detachConsumer(clientSecret.reference, consumer);
    await saveBinding(context, server, account, { disconnected: true });
    commandResult(context.runtime, options, { server, account, status: "disconnected", remoteRevocation, sharedSecretsPreserved: true }, `Disconnected ${server} (${account}). Remote OAuth revocation: ${remoteRevocation}. Shared secrets were preserved.`);
    return remoteRevocation === "failed" ? 3 : 0;
  }
  if (action === "migrate") {
    if (!connection.getOAuthAuth()) throw new Error("Only OAuth connections have legacy authorization sessions to migrate.");
    const input = await completeInput(context.runtime, options, [{ name: "from-session", question: "Exact legacy OAuth session (shared or user:<id>)", validate: (value) => { if (value !== "shared" && !/^user:.+/.test(value)) throw new Error("Migration requires an explicit legacy session, shared or user:<id>."); } }], `fentaris mcp auth migrate ${server} --account ${account} --from-session <LEGACY_SESSION>`);
    const from = input["from-session"] as "shared" | `user:${string}`;
    await context.vault.ensureUnlocked?.(options, `fentaris mcp auth migrate ${server} --account ${account} --from-session ${from}`);
    const key = context.runtime.env.FENTARIS_VAULT_UNLOCK_KEY ?? context.runtime.env.FENTARIS_AUTH_KEY;
    const legacy = context.legacy ?? (key ? new LocalOAuthTokenStore({ dir: context.directory, key }) : undefined);
    const record = await legacy?.get(server, from) ?? await context.tokenStore.get(server, from);
    if (!record?.tokens) throw new Error("The selected legacy session has no stored tokens. Nothing was changed.");
    if (await context.tokenStore.get(server, `account:${account}`)) throw new Error("The destination account already has OAuth state. Migration never overwrites an existing account.");
    await context.tokenStore.set(server, `account:${account}`, record);
    await saveBinding(context, server, account, { disconnected: false });
    commandResult(context.runtime, options, { server, account, status: "migrated", fromSession: from, legacyPreserved: true, remoteValidity: "unverified" }, `Copied legacy session ${from} to ${server} (${account}). The original is preserved for rollback; remote validity is unverified.`);
    return 0;
  }
  if (action !== "connect") throw new Error(`Unknown MCP authentication action "${action}".`);
  const auth = connection.authentication();
  if (auth?.type === "oauth" && (options.secret !== undefined || options.credential !== undefined)) throw new Error("OAuth lifecycle tokens are managed by connect. Configure a client-secret reference in oauth() rather than supplying credential bindings.");
  const bindings = connection.getCredentialBindings();
  const suppliedBindings: Record<string, string> = {};
  for (const entry of typeof options.credential === "string" ? options.credential.split(",") : []) {
    const separator = entry.indexOf("=");
    const slot = entry.slice(0, separator); const reference = entry.slice(separator + 1);
    if (separator < 1 || !reference.trim() || suppliedBindings[slot] || !bindings.some((binding) => (binding.type === "bearer" ? "bearer" : binding.type === "header" ? binding.header : binding.env) === slot)) throw new Error("Each --credential must name a distinct configured SLOT=REFERENCE.");
    suppliedBindings[slot] = reference;
  }
  if (options.secret && options.credential) throw new Error("Choose --secret for one reference or --credential for explicit slots.");
  if (typeof options.secret === "string" && bindings.length !== 1) throw new Error("--secret reuses one credential reference. For credential bundles, complete each configured reference through connect.");

  if ((auth?.type === "managed") || ((!auth || auth.type === "none") && bindings.length === 0)) {
    commandResult(context.runtime, options, { server, account, status: auth?.type === "managed" ? "server-managed" : "unnecessary", remoteValidity: "unverified" }, auth?.type === "managed" ? `Authentication for ${server} (${account}) is managed by the upstream server. Fentaris cannot inspect or verify it.` : `No Fentaris-managed authentication is required for ${server} (${account}).`);
    return 0;
  }
  if (auth?.type === "oauth" && !context.config.oauth?.store) await context.vault.ensureUnlocked?.(options, `fentaris mcp auth connect ${server} --account ${account}`);
  const session = auth?.type === "oauth" ? await context.tokenStore.get(server, `account:${account}`) : undefined;
  const resolve = async (reference: string) => {
    try { return await context.vault.resolve(reference); }
    catch (error) {
      if (!context.vault.ensureUnlocked || !(error instanceof Error) || !error.message.startsWith("The project vault is locked")) throw error;
      await context.vault.ensureUnlocked(options, `fentaris mcp auth connect ${server} --account ${account}`);
      return context.vault.resolve(reference);
    }
  };
  let connected = Boolean(session?.tokens?.access_token);
  if (auth?.type !== "oauth") {
    connected = true;
    for (const binding of bindings) if (!await resolve(binding.credential.reference)) connected = false;
  }
  if (connected && options.reauth !== true && !context.state.connections.find((entry) => entry.server === server && entry.account === account)?.disconnected) {
    const expiry = session?.tokens ? oauthTokensExpireAt(session.tokens) : undefined;
    const state = expiry !== undefined && expiry <= Date.now() ? session?.tokens?.refresh_token ? "refresh-needed" : "expired" : "unverified";
    commandResult(context.runtime, options, { server, account, status: "already-connected", remoteValidity: state, nextCommand: `fentaris mcp auth connect ${server} --account ${account} --reauth` }, `${server} (${account}) already has credentials. Authorization state: ${state}; use --reauth to replace authorization explicitly.`);
    return 0;
  }
  const updates: Record<string, string> = {};
  if (auth?.type === "oauth") {
    const reference = typeof auth.clientSecret === "object" ? auth.clientSecret.reference : undefined;
    let clientSecret = reference ? await context.vault.resolve(reference) : undefined;
    let pendingSecret = false;
    if (reference && !clientSecret) {
      const input = await completeInput(context.runtime, options, [{ name: "oauth-client-secret", question: `OAuth client secret for ${reference}`, secret: true }], `fentaris secrets set ${reference} --value-stdin && fentaris mcp auth connect ${server} --account ${account}`);
      clientSecret = input["oauth-client-secret"]; pendingSecret = true;
    }
    await connectOAuth(context, connection, account, options, { clientSecret, commit: pendingSecret ? async () => { await context.vault.set(reference!, clientSecret!, { consumer }); } : undefined });
  }
  else {
    const missing: string[] = [];
    for (const binding of bindings) {
      const slot = binding.type === "bearer" ? "bearer" : binding.type === "header" ? binding.header : binding.env;
      const supplied = suppliedBindings[slot] ?? (typeof options.secret === "string" ? options.secret : undefined);
      let reference = supplied ?? binding.credential.reference;
      if (!reference.trim() || reference.startsWith("fentaris.internal.oauth.")) throw new Error("Choose a valid user-managed secret reference.");
      const existing = await resolve(reference);
      if (supplied && !existing) throw new Error(`Secret reference "${reference}" is unavailable. Next command: fentaris secrets set ${commandValue(reference)}`);
      if (!existing || (options.reauth === true && !supplied)) {
        if (existing && options.reauth === true && (context.config.defaults?.credentials?.[reference] || (context.state.sources[reference] && context.state.sources[reference].type !== "vault") || sharedReference(context, reference, server, account))) {
          const slot = binding.type === "bearer" ? "token" : binding.type === "header" ? binding.header : binding.env;
          reference = `${server}.${account}.${slot}`;
          if (sharedReference(context, reference, server, account)) throw new Error("The replacement reference is shared. Store a separate named secret and connect with --secret.");
        }
        if (!missing.includes(reference)) missing.push(reference);
      }
      updates[slot] = reference;
    }
    const followup = `fentaris mcp auth connect ${server} --account ${account} --reauth ${Object.entries(updates).map(([slot, ref]) => `--credential ${commandValue(`${slot}=${ref}`)}`).join(" ")}`;
    const input = await completeInput(context.runtime, options, missing.map((reference) => ({ name: `credential:${reference}`, question: `Credential for ${reference}`, secret: true })), [...missing.map((ref, index) => `printf '%s' "$MCP_CREDENTIAL_${index + 1}" | fentaris secrets set ${commandValue(ref)} --value-stdin`), followup].join(" && "));
    const pending = missing.map((reference) => ({ reference, value: input[`credential:${reference}`] }));
    // All required input is complete before any credential/connection writes.
    if (pending.length) await context.vault.ensureUnlocked?.(options, `fentaris mcp auth connect ${server} --account ${account}`);
    for (const entry of pending) await context.vault.set(entry.reference, entry.value, { consumer });
    for (const reference of Object.values(updates)) {
      const configured = context.config.defaults?.credentials?.[reference];
      if (configured?.type === "json" && !context.state.sources[reference]) continue; // Keep the explicit existing file source.
      const source = context.state.sources[reference] ?? (configured?.type === "env" ? { type: "environment" as const, name: configured.name } : { type: "vault" as const });
      await context.vault.bind(reference, source, { consumer });
    }
  }
  await saveBinding(context, server, account, { disconnected: false, ...(Object.keys(updates).length ? { bindings: updates } : {}) });
  commandResult(context.runtime, options, { server, account, status: "connected", remoteValidity: auth?.type === "oauth" ? "authorized" : "unverified", nextCommand: `fentaris mcp get ${server} --account ${account}` }, `Connected ${server} (${account}). ${auth?.type === "oauth" ? "OAuth authorization completed." : "Credentials are stored; remote validity is unverified."}`);
  return 0;
}

function sharedReference(context: McpCliContext, reference: string, server: string, account: string): boolean {
  return context.servers.some((candidate) => candidate.accountNames().some((alias) => (candidate.name !== server || alias !== account) && candidate.account(alias).getCredentialBindings().some((binding) => binding.credential.reference === reference)));
}

async function saveBinding(context: McpCliContext, server: string, account: string, changes: { disconnected?: boolean; bindings?: Record<string, string> }) {
  const sourceChanges = Object.entries(context.state.sources).filter(([ref, source]) => JSON.stringify(source) !== JSON.stringify(context.initialSources[ref]));
  context.state = await updateMcpConnectionState(context.directory, (state) => {
    for (const [ref, source] of sourceChanges) {
      if (state.sources[ref] && JSON.stringify(state.sources[ref]) !== JSON.stringify(source)) throw new Error("A credential source changed during account setup. Reload and retry; unrelated bindings were preserved.");
      state.sources[ref] = source;
    }
    const previous = state.connections.find((entry) => entry.server === server && entry.account === account);
    state.connections = state.connections.filter((entry) => entry.server !== server || entry.account !== account);
    state.connections.push({ ...previous, server, account, ...changes, updatedAt: Date.now() });
    return state;
  });
}
async function chooseServer(context: McpCliContext, options: CliOptions, next: string): Promise<string> {
  const choices = [...new Set(context.servers.map((server) => server.name))];
  if (!choices.length) throw new Error("No MCP servers are configured. Add an MCP declaration to the project configuration before connecting.");
  return (await completeInput(context.runtime, options, [{ name: "server", question: "MCP server", choices }], next)).server;
}
async function selectConnection(context: McpCliContext, serverName: string, options: CliOptions, next: string): Promise<{ account: string; connection: McpServer }> {
  const matches = context.servers.filter((server) => server.name === serverName);
  if (matches.length !== 1) throw new Error(matches.length ? `MCP "${serverName}" is ambiguous across configuration scopes.` : `Unknown configured MCP "${serverName}".`);
  const server = matches[0];
  const names = server.accountNames();
  if (names.length === 0) throw new Error(`MCP "${serverName}" has no configured upstream accounts.`);
  const supplied = typeof options.account === "string" ? options.account : names.length === 1 ? names[0] : true;
  const result = await completeInput(context.runtime, { ...options, account: supplied }, [{ name: "account", question: "Upstream account", choices: names, validate: validateAlias }], next);
  return { account: result.account, connection: server.account(result.account) };
}
function validateAlias(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error("Account aliases must contain letters, numbers, dots, underscores, or hyphens. Downstream user:/group: selectors are not account aliases.");
}
function authLabel(row: McpDiscoveryRow): string {
  const method = row.authentication.method === "bearer" ? "Bearer token" : row.authentication.method === "header" ? "API key" : row.authentication.method === "oauth" ? "OAuth" : row.authentication.method === "none" ? "None" : row.authentication.method === "managed" ? "Server managed" : "Credential bundle";
  return ["none", "server-managed"].includes(row.authentication.state) ? method : `${method}: ${row.authentication.state}${row.authentication.verified ? "" : " (unverified)"}`;
}
function printDiscovery(runtime: Runtime, result: McpDiscoveryResult, options: CliOptions, mode: "inventory" | "tools" | "details") {
  if (options.json === true) { runtime.out.log(JSON.stringify(result)); return; }
  if (mode === "inventory") runtime.out.log("MCP                          STATUS                 AUTHENTICATION                 TOOLS");
  for (const row of result.connections) {
    const label = `${row.server}${row.account ? ` (${row.account})` : ""}`;
    const count = row.toolCount === null ? "—" : `${row.toolCount}${row.toolMetadata.source === "cached" ? ` (cached ${Math.ceil((row.toolMetadata.ageMs ?? 0) / 1000)}s ago)` : ""}`;
    if (mode === "inventory") runtime.out.log(`${label.padEnd(29)}${row.status.padEnd(23)}${authLabel(row).padEnd(31)}${count}`);
    if (mode === "details") {
      runtime.out.log(`${label}\nDescription: ${row.description ?? "Not provided"}\nTransport: ${row.transport}\nEndpoint: ${row.endpoint ?? "Local/custom transport"}\nConfiguration: ${row.configuration.valid ? "Valid" : "Invalid"}\nAuthentication: ${authLabel(row)}\nProvider identity: ${row.authentication.providerIdentity ? JSON.stringify(row.authentication.providerIdentity) : "Unavailable"}\nPermissions: ${row.authentication.permissions?.join(", ") ?? "Unavailable"}\nConnectivity: ${row.connectivity}\nTools: ${count}`);
      for (const error of row.configuration.errors) runtime.out.log(`Configuration error: ${error}`);
    }
    if (mode === "tools") {
      runtime.out.log(`\n${label}${row.toolMetadata.source === "cached" ? ` — cached ${Math.ceil((row.toolMetadata.ageMs ?? 0) / 1000)}s ago` : ""}`);
      for (const tool of row.tools) runtime.out.log(`  ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`);
      if (!row.tools.length) runtime.out.log(`  ${row.error?.message ?? (row.connectivity === "reachable" ? "This server exposes no tools." : options.offline ? "No cached tools are available; live discovery is disabled." : row.status)}`);
    }
    if (row.error) runtime.out.log(`${label}: ${row.error.message}`);
    for (const recovery of row.recovery) runtime.out.log(`  Next: ${recovery}`);
  }
  runtime.out.log(`\n${result.summary.message} ${result.summary.verifiedTools} tools verified; ${result.summary.cachedTools} cached tool descriptions (remote availability unverified).`);
}
