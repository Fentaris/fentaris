# `@fentaris/core`

Runtime and TypeScript API for routing upstream MCP servers through one Fentaris endpoint.

## Install

```bash
npm install @fentaris/core
```

## Quick start

```ts
import { Policy, fentaris, stdio } from "@fentaris/core";

const app = fentaris({
  policy: Policy.allowAll(),
});

app.mcp("filesystem", {
  transport: stdio({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  }),
});

await app.start();
```

The default endpoint is `http://localhost:4000/mcp`. `Policy.allowAll()` is suitable for local development only; configure authentication and an allow-list policy before exposing the endpoint.

See the [Fentaris documentation](https://fentaris.mintlify.app) for transports, policy, auth, secrets, middleware, and observability.

## Inbound OAuth conformance

Configure `identity: oauthIdentityStrategy({ issuer, resource, scopes })` to authenticate inbound MCP clients with an external authorization server. Fentaris serves protected resource metadata and bearer challenges on HTTP and SSE; it does not issue tokens. See the [OAuth guide](../../docs/guides/oauth.mdx) for JWT verification, introspection, user mapping and API-key fallback.

The local mcpjam conformance suite is opt-in:

```sh
FENTARIS_MCPJAM=1 pnpm --filter @fentaris/core test test/conformance
```

The default test run skips this suite. For verification against packed packages, use `pnpm verify:oauth:practical` from the repository root; see [the campaign guide](../../scripts/oauth-verification/README.md).
