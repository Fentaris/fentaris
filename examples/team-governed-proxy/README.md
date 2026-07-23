# Team-governed Fentaris proxy

This runnable example exposes one governed endpoint at
`http://127.0.0.1:4100/mcp` with two MCP namespaces:

- `specification`: a public remote Streamable HTTP server.
- `workspace`: app-owned local tools declared with `app.local(...)`.

Two API-key users demonstrate policy-filtered discovery and execution:

| User | Group | Allowed |
| --- | --- | --- |
| `reader` | `readers` | specification tools and `workspace__status` |
| `maintainer` | `maintainers` | reader access plus `workspace__release_notes` |

## Install and validate

```bash
pnpm install
pnpm build
pnpm check
pnpm doctor
```

All four commands should exit successfully before provisioning local identity.

## Provision API-key identities

Choose an encryption key outside the repository and keep it in the same shell
session. Do not put it in `.env`, source code, documentation, or Git:

```bash
export FENTARIS_AUTH_KEY="<choose-a-local-encryption-key>"
pnpm exec fentaris auth api-key add reader --generate --non-interactive
pnpm exec fentaris auth api-key add maintainer --generate --non-interactive
```

Save each generated API key when it is printed; Fentaris stores only its hash.
For the smoke tests below, set `READER_API_KEY` or `MAINTAINER_API_KEY` in the
client shell without committing either value.

The encrypted `.fentaris/credentials.enc.json` file and encryption key are
local state and must not be committed. The committed
`.fentaris/secrets.manifest.json` contains schema only.

## Start the proxy

```bash
pnpm dev
```

Expected startup output includes:

```txt
Proxy ready
Listening on: http://127.0.0.1:4100/mcp
```

In a second shell, keep the same `FENTARIS_AUTH_KEY` available and export the
same client API key used for the curl tests so doctor can authenticate:

```bash
export FENTARIS_API_KEY="$READER_API_KEY"
pnpm exec fentaris doctor --runtime --non-interactive
```

`FENTARIS_AUTH_KEY` unlocks the local encrypted store; `FENTARIS_API_KEY` is
the raw client key sent as `x-fentaris-api-key`. Without the latter, runtime
probing returns HTTP 401 on this example.

Expected result: the MCP initialize check passes for
`http://127.0.0.1:4100/mcp`.

## Test an authenticated MCP session

Initialize as the reader and save the returned session header:

```bash
curl -sS -D reader-headers.txt -o reader-initialize.json \
  -X POST http://127.0.0.1:4100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "x-fentaris-api-key: $READER_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

READER_SESSION="$(grep -i '^mcp-session-id:' reader-headers.txt | tr -d '\r' | cut -d' ' -f2)"
```

Send the initialized notification and list visible tools:

```bash
curl -sS -X POST http://127.0.0.1:4100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "x-fentaris-api-key: $READER_API_KEY" \
  -H "mcp-session-id: $READER_SESSION" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -sS -X POST http://127.0.0.1:4100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "x-fentaris-api-key: $READER_API_KEY" \
  -H "mcp-session-id: $READER_SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

The reader result includes `workspace__status` and hides
`workspace__release_notes`. Remote `specification__*` tools appear when the
public upstream is reachable.

Calling the hidden maintainer tool directly as the reader is denied before its
local handler runs:

```bash
curl -sS -X POST http://127.0.0.1:4100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "x-fentaris-api-key: $READER_API_KEY" \
  -H "mcp-session-id: $READER_SESSION" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workspace__release_notes","arguments":{}}}'
```

Expected result: the MCP tool result has `isError: true`, with Fentaris error
code `-32030` and denial reason `not-permitted` in `_meta.error`. Repeat the
session with `MAINTAINER_API_KEY`; the maintainer tool is listed and returns:

```txt
Release notes are visible to maintainers only.
```

You can also use MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

Point it at `http://127.0.0.1:4100/mcp` and set the
`x-fentaris-api-key` request header.
