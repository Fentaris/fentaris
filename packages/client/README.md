# @fentaris/client

`frs` is the end-user CLI for a running Fentaris proxy. You sign in once as a Fentaris user. After that, you, or a coding agent working in your shell, can discover and use the MCP tools, resources, and prompts the proxy grants you.

Every operation goes through the proxy's MCP endpoint, so policy, approvals, upstream credentials, rate limits, and audit apply exactly as they do for any other MCP client. `frs` never contacts upstream MCP servers directly.

`frs` is not the project tool. To create, run, and operate a Fentaris project, use [`@fentaris/cli`](../cli) (`fentaris`). `frs` needs no project directory, only the proxy URL.

## Install

```bash
npm install -g @fentaris/client
frs --version

# or, without a global install
npx @fentaris/client --help
```

Requires Node.js 24 or later.

## Sign in

```bash
# OAuth 2.1: opens the browser, then stores the tokens
frs auth login https://proxy.example/mcp

# API key, read from standard input (never pass it as an argument)
printf '%s' "$FENTARIS_API_KEY" | frs auth login https://proxy.example/mcp --with-api-key

frs auth status
frs auth logout
```

**OAuth login.** The CLI reads the proxy's protected resource metadata (`/.well-known/oauth-protected-resource`) and the authorization server metadata. It then runs the authorization code flow with PKCE and a loopback redirect on `127.0.0.1`, and requests the token for the proxy's resource. It selects the OAuth client in this order:

1. `--client-id`;
2. the client the operator advertises for the CLI (see [Operator setup](#operator-setup));
3. dynamic client registration, when the authorization server supports it.

Use `--print-url` (or `--non-interactive`) to print the authorization URL instead of opening a browser. Use `--port` when the client is registered with a fixed redirect URI.

**Profiles.** Each sign-in is saved as a profile. Use `--profile <name>` on any command, or switch the default:

```bash
frs auth login https://team.example/mcp --profile team
frs profile list
frs profile use team
frs profile remove team --yes
```

## Use tools, resources, and prompts

```bash
frs tools list --mcp github --limit 20
frs tools search "create issue"
frs tools get github__create_issue
frs tools schema github__create_issue --input
frs tools call github__create_issue --args '{"title":"Bug"}'
frs tools call search__query --arg q=fentaris --arg limit=5
jq -n '{title: "Bug"}' | frs tools call github__create_issue --args-file -

frs resources list --mcp docs
frs resources read 'fentaris://resources/docs/file%3A%2F%2Freadme.md'
frs resources read <uri> --output-file logo.png

frs prompts list
frs prompts get github__review --arg pr=12
```

Tool and prompt names are the proxied names, `<server>__<name>`. `--mcp <server>` filters by server.

If a tool needs your authorization for an upstream account, the CLI prints the authorization URL and opens it in your browser. The original call finishes after you sign in. With `--non-interactive`, it fails with `UPSTREAM_AUTH_REQUIRED` instead, and puts the URL in the error details.

The CLI works the same against proxies that use [compact discovery](../core).

## Agents and automation

Add `--json` to any command to get exactly one envelope on stdout:

```json
{ "ok": true, "data": {}, "pagination": null, "warnings": [], "nextActions": [] }
{ "ok": false, "error": { "code": "POLICY_DENIED", "message": "…", "details": {} }, "warnings": [], "nextActions": [] }
```

A typical agent loop is `frs tools search <keywords> --json`, then `frs tools schema <tool> --input --json`, then `frs tools call <tool> --args '<json>' --json`. Each response lists the next useful commands in `nextActions`. Use `--raw` with `tools call` to print only the MCP result.

Environment variables are used for a single invocation and are never stored:

| Variable | Purpose |
| --- | --- |
| `FENTARIS_URL` | Proxy MCP endpoint; overrides the profile URL. |
| `FENTARIS_API_KEY` | API key sent in `x-fentaris-api-key` (or `FENTARIS_API_KEY_HEADER`). |
| `FENTARIS_ACCESS_TOKEN` | OAuth bearer token. |
| `FENTARIS_PROFILE` | Profile to use. |
| `FENTARIS_CLIENT_CONFIG_DIR` | Configuration directory. [default: `$XDG_CONFIG_HOME/fentaris-client` or `~/.config/fentaris-client`] |
| `FENTARIS_CLIENT_CREDENTIAL_STORE` | `file` forces the owner-only file store; `system` (the default) prefers the system keychain. |

Stored credentials are sent only to the URL they were issued for. If `FENTARIS_URL` points elsewhere, the CLI does not send them.

### Exit codes

| Code | Meaning | Error codes |
| --- | --- | --- |
| 0 | Success | |
| 1 | The tool returned an error, or an unexpected failure | `TOOL_ERROR`, `INTERNAL_ERROR` |
| 2 | Invalid usage or input | `INVALID_ARGUMENTS`, `UNKNOWN_COMMAND`, `NOT_FOUND` |
| 3 | Authentication | `NOT_LOGGED_IN`, `AUTH_REQUIRED`, `UNAUTHORIZED`, `LOGIN_FAILED`, `OAUTH_CLIENT_REQUIRED`, `UPSTREAM_AUTH_REQUIRED` |
| 4 | Policy or approval denial | `POLICY_DENIED` |
| 5 | Proxy unreachable or upstream failure | `PROXY_UNREACHABLE`, `UPSTREAM_ERROR`, `PROTOCOL_ERROR` |
| 6 | Timeout (`--timeout`, default 120000 ms) | `TIMEOUT` |

The proxy does not reveal tools you cannot see, so calling one fails with `POLICY_DENIED`.

## Credential storage

| Platform | Store |
| --- | --- |
| macOS | Keychain (service `fentaris-client`), through the `security` tool |
| Linux with a Secret Service keyring | `secret-tool` (libsecret) |
| Otherwise | `credentials.json` with mode `0600` in the configuration directory, with a warning |

Secrets are passed to the system tools on stdin, so they never appear in the process list. Profile metadata in `config.json` contains no secrets.

## Operator setup

For OAuth, the proxy uses `oauthIdentityStrategy`. To let `frs` sign in without dynamic client registration, register a public client in your authorization server. Give it a loopback redirect URI, for example `http://127.0.0.1:8765/callback`. Then advertise that client:

```ts
import { oauthIdentityStrategy } from "@fentaris/core";

oauthIdentityStrategy({
  issuer: "https://auth.example.com/",
  cli: { clientId: "frs-public-client", audience: "https://proxy.example/mcp", scopes: ["openid", "offline_access"] },
});
```

The protected resource metadata then includes `fentaris_cli`. `audience` is appended to the authorization request for issuers that require it. If the client is registered with a fixed port, users sign in with `frs auth login <url> --port 8765`.

## License

MIT
