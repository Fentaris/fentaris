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
