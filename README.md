<div align="center">
  <a href="https://github.com/fentaris-io/fentaris">
    <picture>
      <img alt="Fentaris logo" src="./static/logo_white.svg" width="90%">
    </picture>
  </a>
</div>

<p align="center">
  <a href="https://fentaris.mintlify.app" alt="Documentation">
    <img src="https://img.shields.io/badge/fentaris-docs-blue?labelColor=white" /></a>
  <a href="./packages/core" alt="Core package">
    <img src="https://img.shields.io/badge/core-%40fentaris%2Fcore-blue?labelColor=white" /></a>
  <a href="./packages/cli" alt="CLI package">
    <img src="https://img.shields.io/badge/cli-%40fentaris%2Fcli-blue?labelColor=white" /></a>
  <a href="./packages/approval-telegram" alt="Telegram approval package">
    <img src="https://img.shields.io/badge/approval-telegram-blue?labelColor=white" /></a>
  <br/>
  <a href="./package.json" alt="TypeScript">
    <img src="https://img.shields.io/badge/typescript-6.x-blue?logo=typescript&labelColor=white" /></a>
  <a href="./pnpm-workspace.yaml" alt="pnpm workspace">
    <img src="https://img.shields.io/badge/pnpm-workspace-orange?logo=pnpm&labelColor=white" /></a>
  <a href="./package.json" alt="Node.js runtime">
    <img src="https://img.shields.io/badge/node-20%2B-green?logo=nodedotjs&labelColor=white" /></a>
  <a href="./packages/core/package.json" alt="License">
    <img src="https://img.shields.io/badge/license-MIT-green" /></a>
</p>
<details>
<summary>Table of contents</summary>

- [About](#about)
- [Documentation](#documentation)
    - [Skills for Coding Agents](#skills-for-coding-agents)
- [Getting Started](#getting-started)
- [Examples](#examples)
- [Packages](#packages)
- [Development](#development)
- [License](#license)

</details>

## About

<b>Fentaris</b> is a control plane for your MCP servers — one place to run, route, and manage every MCP server behind a single, stable endpoint.

- **Unify** stdio, Streamable HTTP, SSE, and HTTP upstream MCP servers behind one proxy.
- **Manage** which servers and tools are exposed, to whom, and how they behave — without touching client configs.
- **Observe** every proxied operation with structured logging, lifecycle events, and per-request context.
- **Protect** tool calls, resources, prompts, and completions with policy, identity, middleware, hooks, and rate limits.
- **Authenticate** clients and upstream MCP servers with API keys, bearer tokens, custom headers, and OAuth 2.1.

Fentaris is designed for teams that want MCP servers to behave like production infrastructure: stable names, centralized management, auditable calls, and predictable client-facing endpoints.

## Documentation

Visit our [docs](https://fentaris.mintlify.app) or jump to a [quickstart](https://fentaris.mintlify.app/getting-started/quickstart)

#### Skills for Coding Agents

 > Using Claude Code, Codex, Cursor or other AI coding agents?
 > 
 > [Install the Fentaris skill for coding agents](https://www.skills.sh/fentaris/fentaris-skills/fentaris-project-setup)

For a complete runnable project with API-key users, groups, allow-list policy,
a remote MCP upstream, and app-owned local tools, see
[`examples/team-governed-proxy`](./examples/team-governed-proxy).


## Getting Started

Use the CLI to start a new Fentaris proxy project:

```bash
npm install -g @fentaris/cli
fentaris init my-proxy
cd my-proxy
fentaris dev
```

The generated proxy listens on `http://localhost:4000/mcp` by default. Point your MCP client to that endpoint.

Under the hood, a Fentaris proxy is just a few lines of code:

```ts
import { fentaris, stdio } from "@fentaris/core";

const app = fentaris();

app.mcp("filesystem", {
  transport: stdio({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  }),
});

await app.start();
```

Upstream tool names stay stable and namespaced by server, no matter how many servers you add. A filesystem tool is exposed to clients with a proxy name such as:

```txt
filesystem__list_directory
```

[→ Full documentation](https://fentaris.mintlify.app)

## Examples

Add another server behind the same endpoint:

```ts
app.mcp("github", {
  transport: stdio({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }),
});
```

Restrict who can call what:

```ts
app.policy("read-only")
  .mcp("filesystem")
  .allow("list_directory");

app.group("operators")
  .users(user("alice", { email: "alice@example.com" }))
  .policy("read-only");
```

Require approval before a risky action runs:

```ts
const deploy = policy("deploy")
  .mcp("github")
  .allow("deploy_production", approval.manual({
    reason: "Production deploy requires approval",
  }));
```

Observe every tool call:

```ts
app.on("tool:success", ({ ctx, durationMs }) => {
  ctx.log.info("tool.success", { tool: ctx.tool?.name, durationMs });
});
```

Runtime routes can deny, approve, hide, log, or transform calls to any tool, resource, prompt, or completion.

Authenticate clients with an API key, and let Fentaris handle OAuth 2.1 for upstream servers automatically:

```bash
fentaris auth api-key add alice --generate
```

```ts
app.mcp("linear", {
  transport: streamableHttp({ url: "https://mcp.linear.app/mcp" }),
  auth: oauth(),
});
```

Credential values are never exposed to middleware, hooks, logs, or policy callbacks.

## Packages

| Package | Description |
| --- | --- |
| [`@fentaris/core`](./packages/core) | Proxy runtime, MCP server wrapper, transports, policy, auth, logging, and middleware APIs. |
| [`@fentaris/cli`](./packages/cli) | Project generator and local development commands. |
| [`@fentaris/approval-telegram`](./packages/approval-telegram) | Telegram approval adapter for Fentaris policies. |

## Development

Run the project for development:

```
fentaris dev
```

From a clean clone, install the locked dependency graph and run the same validation used by CI:

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs lint, typecheck, build, and every package test in that order.

Before promoting a release, verify the exact npm tarballs in clean projects:

```bash
pnpm verify:release
```

This packs Core, CLI, Edge, and Telegram approval, validates their manifests and
entrypoints, installs them in an empty project, generates and builds a real CLI
project, and exercises upgrade, downgrade, reinstall, and re-upgrade from the
previous published package set. It requires access to the npm registry.

Generate docs reference:

```bash
pnpm docs:generate
```

## License

[MIT](./LICENSE.txt), as declared by the published Fentaris packages.
