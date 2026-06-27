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

The generated proxy listens on `http://localhost:4000/mcp` by default.

## Project checks

```bash
fentaris check --offline
fentaris doctor --runtime
fentaris build
```

Generated projects allow all upstream operations and do not configure authentication. Add API-key auth and an allow-list policy before exposing the endpoint outside your machine.

See the [CLI reference](https://fentaris.mintlify.app/reference/cli) for commands, options, diagnostics, and secrets management.
