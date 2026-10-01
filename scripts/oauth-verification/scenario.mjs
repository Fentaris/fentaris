import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fentaris, Policy, mcp, oauth, oauthTokens, streamableHttp, oauthIdentityStrategy, headerIdentityStrategy, FentarisAuth, apiKeyIdentityStrategy } from "@fentaris/core";
import { startAuthorizationServer } from "./authorizationServer.mjs";
import { startProtectedMcpServer } from "./protectedMcpServer.mjs";
import { connectElicitingClient } from "./elicitingClient.mjs";
import { runLogged } from "./verification-lib.mjs";

const [id, project, logs] = process.argv.slice(2);
const commands = [], clients = [], apps = [], secrets = [process.env.FENTARIS_AUTH_KEY, process.env.OAUTH_API_KEY, process.env.OAUTH_CLIENT_SECRET];
const credentialFiles = [];
const as = await startAuthorizationServer({ jwtAccessTokens: id.startsWith("04-") || id.startsWith("05-") || id.startsWith("06-") });
let upstream;
const json = async (file, data) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
const portOf = (server) => server.address().port;
async function freePort() {
  const server = createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = portOf(server); await new Promise((resolve) => server.close(resolve)); return port;
}
async function startApp(options) {
  const app = fentaris(options); apps.push(app);
  const server = await app.start(); return { app, url: `http://127.0.0.1:${portOf(server)}/mcp` };
}
async function connect(url, headers) {
  const client = await connectElicitingClient({ url, headers }); clients.push(client); return client;
}
async function jam(args, suffix) {
  try {
    const record = await runLogged({ command: process.execPath, args: [path.join(project, "node_modules/@mcpjam/cli/dist/index.js"), ...args], cwd: project, logs, id: `${id}-${suffix}`, env: { MCPJAM_TELEMETRY_DISABLED: "1" }, timeoutMs: 90_000 });
    commands.push(record); return record;
  } catch (error) { if (error.record) commands.push(error.record); throw error; }
}
async function cliLogin(cwd, port) {
  const args = [path.join(project, "node_modules/@fentaris/cli/dist/index.js"), "auth", "login", "protected", "--as", "user:alice", "--print-url", "--port", String(port), "--timeout", "60", "--json"];
  const stdout = [], stderr = []; let approved = false, consent;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI login timed out")); }, 70_000);
    child.stdout.on("data", (chunk) => {
      stdout.push(chunk); const text = Buffer.concat(stdout).toString();
      const url = text.split(/\r?\n/).find((line) => line.startsWith(as.url) && line.includes("/authorize?"));
      if (url && !approved) { approved = true; consent = (async () => { const response = await fetch(url, { redirect: "manual" }); assert.equal(response.status, 302); const callback = await fetch(response.headers.get("location")); assert.equal(callback.status, 200); })(); consent.catch(() => child.kill("SIGTERM")); }
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  await consent;
  const stdoutPath = path.join(logs, `${id}-cli-login.stdout.log`), stderrPath = path.join(logs, `${id}-cli-login.stderr.log`);
  await writeFile(stdoutPath, Buffer.concat(stdout), { mode: 0o600 }); await writeFile(stderrPath, Buffer.concat(stderr), { mode: 0o600 });
  commands.push({ id: `${id}-cli-login`, command: [process.execPath, ...args], exitCode: code, expectedExitCodes: [0], stdoutPath, stderrPath });
  assert.equal(code, 0); assert.equal(approved, true);
}

try {
  if (id.startsWith("01-") || id.startsWith("02-") || id.startsWith("03-")) {
    upstream = await startProtectedMcpServer({ authorizationServer: as });
    const port = await freePort();
    let auth = oauth();
    if (id.startsWith("03-")) {
      as.preregister({ client_id: "service", client_secret: process.env.OAUTH_CLIENT_SECRET, redirect_uris: [], grant_types: ["client_credentials"] });
      auth = oauth.clientCredentials({ clientId: "service", clientSecret: process.env.OAUTH_CLIENT_SECRET });
    }
    if (id.startsWith("02-")) {
      const cliPort = await freePort();
      as.preregister({ client_id: "cli-fixture", redirect_uris: [`http://127.0.0.1:${cliPort}/callback`, `http://127.0.0.1:${port}/_fentaris/oauth/callback`] });
      const cwd = path.join(project, id); await mkdir(path.join(cwd, "src"), { recursive: true }); await mkdir(path.join(cwd, ".fentaris"));
      await json(path.join(cwd, "package.json"), { name: "oauth-cli-consumer", version: "0.0.0", type: "module", dependencies: { "@fentaris/core": "*" } });
      await json(path.join(cwd, "fentaris.json"), { name: "oauth-cli-consumer", entrypoint: "src/index.ts", packageManager: "pnpm", port, path: "/mcp", authDir: ".fentaris" });
      const authDir = path.join(cwd, ".fentaris");
      await json(path.join(authDir, "credentials.enc.json"), FentarisAuth.encryptCredentials({ users: {}, groups: {}, defaults: {} }, process.env.FENTARIS_AUTH_KEY));
      await writeFile(path.join(cwd, "src/index.ts"), `import {Policy, mcp, oauth, oauthTokens, streamableHttp, headerIdentityStrategy} from "@fentaris/core";\nexport default {port:${port}, host:"127.0.0.1", identity:headerIdentityStrategy(), policy:Policy.allowAll(), oauth:{store:oauthTokens.local({dir:${JSON.stringify(authDir)},key:process.env.FENTARIS_AUTH_KEY})},servers:[mcp("protected",{transport:streamableHttp({url:${JSON.stringify(upstream.url)},network:{allowPrivateNetworkUrls:true}}),auth:oauth({clientId:"cli-fixture"})})]};\n`);
      await cliLogin(cwd, cliPort);
      const config = (await import(pathToFileURL(path.join(cwd, "src/index.ts")).href)).default;
      let started = await startApp(config);
      let client = await connect(started.url, { "x-user-id": "alice" });
      assert.deepEqual((await client.client.callTool({ name: "protected__echo", arguments: { message: "cli" } })).content, [{ type: "text", text: "demo-user:cli" }]);
      assert.equal(client.elicitedUrls.length, 0);
      await client.close(); await started.app.close();
      const registrations = as.tokenRequests;
      started = await startApp(config); client = await connect(started.url, { "x-user-id": "alice" });
      assert.equal(Boolean((await client.client.callTool({ name: "protected__echo", arguments: { message: "restart" } })).isError), false);
      assert.equal(as.tokenRequests, registrations);
    } else {
      const started = await startApp({ port, host: "127.0.0.1", identity: headerIdentityStrategy(), policy: Policy.allowAll(), oauth: { store: oauthTokens.memory() }, servers: [mcp("protected", { transport: streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } }), auth })] });
      const first = await connect(started.url, { "x-user-id": "alice" });
      const result = await first.client.callTool({ name: "protected__echo", arguments: { message: "candidate" } });
      assert.equal(Boolean(result.isError), false);
      assert.deepEqual(result.content, [{ type: "text", text: `${id.startsWith("03-") ? "service:service" : "demo-user"}:candidate` }]);
      if (id.startsWith("01-")) { assert.equal(first.elicitedUrls.length, 1); assert.ok(as.registrations.length > 0); }
      else {
        const requests = as.tokenRequests;
        const second = await connect(started.url, { "x-user-id": "bob" });
        assert.equal(Boolean((await second.client.callTool({ name: "protected__echo", arguments: { message: "reuse" } })).isError), false);
        assert.equal(as.tokenRequests, requests); assert.deepEqual(upstream.callers, ["service:service", "service:service"]);
        assert.equal(first.elicitedUrls.length + second.elicitedUrls.length, 0);
      }
    }
  } else {
    const authDir = path.join(project, `${id}-auth`); await mkdir(authDir);
    await json(path.join(authDir, "credentials.enc.json"), FentarisAuth.encryptCredentials({ users: { "demo-user": { apiKeys: [process.env.OAUTH_API_KEY] } }, groups: {}, defaults: {} }, process.env.FENTARIS_AUTH_KEY));
    const apiAuth = await FentarisAuth.local({ dir: authDir, key: process.env.FENTARIS_AUTH_KEY });
    const identity = oauthIdentityStrategy({ issuer: as.url, scopes: ["mcp:tools"] });
    const app = fentaris({ port: 0, policy: Policy.allowAll(), identity: [identity, apiKeyIdentityStrategy({ auth: apiAuth })] }); apps.push(app);
    app.local("verification").tool("echo", { description: "Echo the authenticated subject", inputSchema: { type: "object", properties: {}, additionalProperties: false } }, (ctx) => ({ content: [{ type: "text", text: ctx.user.id ?? "anonymous" }] }));
    const server = await app.start(), url = `http://127.0.0.1:${portOf(server)}/mcp`;
    const base = new URL(url).origin;
    for (const route of ["/.well-known/oauth-authorization-server", "/authorize", "/token", "/register"]) assert.equal((await fetch(`${base}${route}`)).status, 404);
    const redirect = "http://127.0.0.1:9876/callback";
    const registration = id.startsWith("05-") ? "preregistered" : "dcr";
    const oauthArgs = ["--url", url, "--protocol-version", "2025-11-25", "--registration", registration, "--auth-mode", "headless", "--scopes", "mcp:tools", "--redirect-url", redirect];
    if (registration === "preregistered") { as.preregister({ client_id: "fixture", redirect_uris: [redirect] }); oauthArgs.push("--client-id", "fixture"); }
    if (id.startsWith("04-") || id.startsWith("05-")) {
      await jam(["oauth", "conformance", ...oauthArgs, "--verify-tools", "--conformance-checks", "--reporter", "json-summary"], "conformance");
      // Explicit cross-user session attack supplements the CLI negative checks.
      const client = await connect(url, { authorization: `Bearer ${as.issuedTokens.at(-1).token}` });
      const sid = client.client.transport?.sessionId;
      assert.ok(sid, "authenticated session must have an id");
      as.preregister({ client_id: "attacker", client_secret: process.env.OAUTH_CLIENT_SECRET, redirect_uris: [], grant_types: ["client_credentials"] });
      const tokenResponse = await fetch(`${as.url}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: "attacker", client_secret: process.env.OAUTH_CLIENT_SECRET, resource: url }) });
      const { access_token } = await tokenResponse.json();
      const hijack = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${access_token}`, "mcp-session-id": sid, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }) });
      assert.equal(hijack.status, 401); assert.match(hijack.headers.get("www-authenticate"), /invalid_token/);
    } else if (id.startsWith("06-")) {
      const file = path.join(project, `${id}-credentials.json`); credentialFiles.push(file);
      await jam(["oauth", "login", ...oauthArgs, "--verify-tools", "--credentials-out", file], "login");
      const credentials = JSON.parse(await readFile(file, "utf8")); secrets.push(credentials.accessToken, credentials.refreshToken, credentials.clientSecret);
      await jam(["tools", "list", "--url", url, "--credentials-file", file, "--format", "json"], "list");
      const call = await jam(["tools", "call", "--url", url, "--credentials-file", file, "--tool-name", "verification__echo", "--tool-args", "{}", "--format", "json"], "call");
      assert.match(await readFile(call.stdoutPath, "utf8"), /demo-user/);
    } else if (id.startsWith("07-")) {
      const record = await jam(["tools", "list", "--url", url, "--header", `x-fentaris-api-key: ${process.env.OAUTH_API_KEY}`, "--format", "json"], "api-key");
      record.command = record.command.map((arg) => arg.replaceAll(process.env.OAUTH_API_KEY, "[REDACTED]"));
      assert.match(await readFile(record.stdoutPath, "utf8"), /verification__echo/);
    } else throw new Error(`Unknown scenario ${id}`);
  }
  console.log(`PASS ${id}`);
} finally {
  for (const client of clients.reverse()) await client.close();
  for (const app of apps.reverse()) await app.close();
  await upstream?.close(); await as.close();
  for (const file of credentialFiles) await rm(file, { force: true });
  await json(path.join(project, `${id}.secrets.json`), [...secrets, ...as.sensitiveValues].filter(Boolean));
  await json(path.join(project, `${id}.commands.json`), commands.map((record) => ({ ...record, command: record.command.map((arg) => secrets.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), arg)) })));
}
