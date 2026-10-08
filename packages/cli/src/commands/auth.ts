import { runIncomingAuth } from "./incoming-auth.js";
import { oauthStatusEntries, openOAuthCliContext, runOAuthLogin, selectorUserId, type OAuthCliContext } from "../domain/auth/oauth-login.js";
import type { CliCommand, CliOptions, Runtime } from "../shared/types.js";
import { section, style } from "../ui/format.js";

export async function runAuth(command: CliCommand, runtime: Runtime): Promise<void> {
  // Legacy upstream entry points remain available for #297 to relocate. They never manage incoming keys.
  if (command.args[0] === "login") return runAuthLogin(command, runtime);
  if (command.args[0] === "status") return runAuthStatus(command, runtime);
  if (command.args[0] === "logout") return runAuthLogout(command, runtime);
  return runIncomingAuth(command, runtime);
}

/**
 * `fentaris auth login <mcp>`: run the full OAuth flow with a loopback redirect.
 * @pk
 */
export async function runAuthLogin(command: CliCommand, runtime: Runtime): Promise<void> {
  const mcp = requireMcpArgument(command, "login");
  const selector = stringOption(command.options, "as");
  const port = portOption(command.options);
  const printUrl = command.options["print-url"] === true || runtime.nonInteractive === true;
  const timeoutMs = timeoutOption(command.options);

  const context = await openOAuthCliContext(runtime, command.options, port === undefined ? {} : { port });
  try {
    assertOAuthServer(context, mcp);
    const outcome = await runOAuthLogin(
      context,
      { server: mcp, ...(selector ? { selector } : {}), printUrl, openBrowser: !printUrl, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
      runtime,
    );

    if (command.options.json === true) {
      runtime.out.log(JSON.stringify({ ok: outcome.status === "authenticated", data: outcome }, null, 2));
      if (outcome.status !== "authenticated") {
        throw new Error(outcome.reason ?? "Authorization did not complete.");
      }
      return;
    }

    section(runtime, "Auth login");
    if (outcome.status === "authenticated") {
      runtime.out.log(`  ${style.pass(`Signed in to ${mcp} as ${outcome.session}.`)}`);
      return;
    }

    runtime.out.log(`  ${style.warn(outcome.reason ?? "Authorization did not complete.")}`);
    throw new Error(outcome.reason ?? "Authorization did not complete.");
  } finally {
    await context.close();
  }
}

/**
 * `fentaris auth status [mcp]`: report stored upstream authorizations.
 * @pk
 */
export async function runAuthStatus(command: CliCommand, runtime: Runtime): Promise<void> {
  const mcp = command.args[1]?.trim();
  const selector = stringOption(command.options, "as");
  const context = await openOAuthCliContext(runtime, command.options, { withCallback: false });
  try {
    if (mcp) {
      assertOAuthServer(context, mcp);
    }

    const entries = (await oauthStatusEntries(context)).filter(
      (entry) => (!mcp || entry.server === mcp) && (!selector || entry.session === context.sessionKeyFor(entry.server, selector)),
    );

    if (command.options.json === true) {
      runtime.out.log(JSON.stringify({ ok: true, data: entries }, null, 2));
      return;
    }

    section(runtime, "Upstream OAuth");
    if (entries.length === 0) {
      runtime.out.log(`  ${style.hint("No OAuth-protected MCP servers are configured.")}`);
      return;
    }

    for (const entry of entries) {
      const label = `${entry.server} ${style.hint("│")} ${entry.session}`;
      const status = entry.status === "authenticated" ? style.pass(entry.status) : style.warn(entry.status);
      runtime.out.log(`  ${label} ${style.hint("│")} ${status}${entry.expiresAt ? ` ${style.hint(`expires ${entry.expiresAt}`)}` : ""}`);
    }
  } finally {
    await context.close();
  }
}

/**
 * `fentaris auth logout <mcp>`: drop a stored upstream authorization.
 * @pk
 */
export async function runAuthLogout(command: CliCommand, runtime: Runtime): Promise<void> {
  const mcp = requireMcpArgument(command, "logout");
  const selector = stringOption(command.options, "as");
  const context = await openOAuthCliContext(runtime, command.options, { withCallback: false });
  try {
    assertOAuthServer(context, mcp);
    const session = context.sessionKeyFor(mcp, selector);
    await context.manager.logout(mcp, session);

    if (command.options.json === true) {
      runtime.out.log(JSON.stringify({ ok: true, data: { server: mcp, session, status: "requires-login" } }, null, 2));
      return;
    }

    section(runtime, "Auth logout");
    runtime.out.log(`  ${style.pass(`Removed the stored authorization for ${mcp} (${session}).`)}`);
  } finally {
    await context.close();
  }
}

function requireMcpArgument(command: CliCommand, action: string): string {
  const mcp = command.args[1]?.trim();
  if (!mcp) {
    throw new Error(`Usage: fentaris auth ${action} <mcp>`);
  }

  return mcp;
}

function assertOAuthServer(context: OAuthCliContext, mcp: string): void {
  if (!context.oauthServers.includes(mcp)) {
    throw new Error(
      context.oauthServers.length === 0
        ? `MCP server "${mcp}" is not declared with oauth(). No server in this project uses OAuth.`
        : `MCP server "${mcp}" is not declared with oauth(). Available: ${context.oauthServers.join(", ")}.`,
    );
  }
}

function stringOption(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  if (key === "as" && !selectorUserId(value) && value.trim() !== "shared") {
    throw new Error(`Selector "${value}" is not supported. Use user:<id> or shared.`);
  }

  return value.trim();
}

function timeoutOption(options: CliOptions): number | undefined {
  const value = options.timeout;
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const seconds = Number.parseInt(value, 10);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`Invalid --timeout value "${value}". Pass a positive number of seconds.`);
  }

  return seconds * 1000;
}

function portOption(options: CliOptions): number | undefined {
  const value = options.port;
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid --port value "${value}".`);
  }

  return parsed;
}
