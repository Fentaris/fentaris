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
- [Use the SDK in an Existing Project](#use-the-sdk-in-an-existing-project)
- [Governance](#governance)
- [Local Auth](#local-auth)
- [Packages](#packages)
- [Development](#development)
- [License](#license)

</details>

## About

<b>Fentaris</b> is a centralized MCP proxy for routing multiple MCP servers through one controlled endpoint.

- **Unify** stdio, Streamable HTTP, SSE, and HTTP upstream MCP servers behind one proxy.
- **Protect** tool calls, resources, prompts, and completions with policy, identity, middleware, hooks, and rate limits.
- **Observe** every proxied operation with structured logging, lifecycle events, and per-request context.
- **Ship** generated proxy projects with the Fentaris CLI, local runtime files, and project checks.

Fentaris is designed for teams that want MCP servers to behave like production infrastructure: stable names, centralized governance, auditable calls, and predictable client-facing endpoints.

## Documentation

Visit our [docs](https://fentaris.mintlify.app) or jump to a [quickstart](https://fentaris.mintlify.app/getting-started/quickstart)

#### Skills for Coding Agents

 > Using Claude Code, Codex, Cursor or other AI coding agents?
 > 
 > [Install mcp-use skill for MCP Apps](https://www.skills.sh/fentaris/fentaris-skills/fentaris-project-setup)

For a complete runnable project with API-key users, groups, allow-list policy,
a remote MCP upstream, and app-owned local tools, see
[`examples/team-governed-proxy`](./examples/team-governed-proxy).


## Getting Started

Use the CLI when you want to start a new Fentaris proxy project:

```bash
npm install -g @fentaris/cli
fentaris init my-proxy
cd my-proxy
fentaris dev
```

The generated proxy listens on `http://localhost:4000/mcp` by default. Point your MCP client to that endpoint.


## Use the SDK in an Existing Project

Install the core package in an existing project:

```bash
npm add @fentaris/core
```

Build a proxy in a few lines:

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
[→ Full documentation](https://fentaris.mintlify.app)

Upstream tool names are still stable and namespaced by server. A filesystem tool is exposed to clients with a proxy name such as:

```txt
filesystem__list_directory
```

## Governance

Add users, groups, and policy:

```ts
import { fentaris, stdio, user } from "@fentaris/core";

const app = fentaris();

app.policy("read-only")
  .mcp("filesystem")
  .allow("list_directory");

app.group("operators")
  .users(user("alice", { email: "alice@example.com" }))
  .policy("read-only");

app.mcp("filesystem", {
  transport: stdio({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  }),
});

await app.start();
```

Block a sensitive tool:

```ts
app.mcp("filesystem").tool("write_file", (ctx, next) => {
  return ctx.subject?.hasGroup("admins")
    ? next()
    : ctx.deny("Admin required.");
});
```

Ask for approval before dangerous tools:

```ts
import { approval, policy } from "@fentaris/core";

const deploy = policy("deploy")
  .mcp("github")
  .allow("deploy_production", approval.manual({
    reason: "Production deploy requires approval",
  }));
```

Modify a tool result:

```ts
app.mcp("github").tool("search_issues", async (_ctx, next) => {
  const result = await next();
  if ("content" in result) {
    result.content.push({ type: "text", text: "Filtered by Fentaris" });
  }
  return result;
});
```

Observe every tool call:

```ts
app.on("tool:success", ({ ctx, durationMs }) => {
  ctx.log.info("tool.success", { tool: ctx.tool?.name, durationMs });
});
```

Policies can govern tool calls and MCP capabilities such as resources, prompts, and completion. Runtime routes can deny, approve, hide, log, or transform calls.

## Local Auth

Fentaris can resolve caller identity and upstream credentials from local encrypted files. Generated projects are discovered from `fentaris.json`; SDK-only projects are discovered from `package.json` when they depend on `@fentaris/core`.

```bash
export FENTARIS_AUTH_KEY="your-local-encryption-key"

fentaris secrets manifest --entrypoint src/index.ts
fentaris secrets set
fentaris secrets list
```

Credential values are not exposed to middleware, hooks, logs, or policy callbacks.

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
