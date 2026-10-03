# `@fentaris/cli`

Create, run, inspect, and build Fentaris proxy projects.

## Install

```bash
npm install --global @fentaris/cli
```

## Quick start

```bash
fentaris init my-proxy
cd my-proxy
fentaris dev
```

The default `local` boilerplate is intentionally open for quick local editing. Use `fentaris init my-proxy --template team` for API-key identity, one group, and an explicit fail-closed tool allow-list. Generated configuration is exported from `src/index.ts`, so CLI discovery can inspect it without starting the proxy.

The generated proxy listens on `http://localhost:4000/mcp` by default.

New projects use `tsx watch` for their `dev` script, so `fentaris dev` restarts the proxy when its TypeScript source files change.

## Project checks

```bash
fentaris check --offline
fentaris doctor --runtime
fentaris build
```

Local projects allow all upstream operations and do not configure authentication. Add API-key auth and an allow-list policy before exposing the endpoint outside your machine, or start from the `team` boilerplate and provision its key with the documented `fentaris auth api-key add` command.

See the [CLI reference](https://fentaris.mintlify.app/reference/cli) for commands, options, diagnostics, and secrets management.
