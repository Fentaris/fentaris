# `@fentaris/edge`

`@fentaris/edge` runs governed MCP workloads on enrolled computers while the
Fentaris proxy retains policy, placement, and lifecycle control.

Edge execution is alpha/preview. Validate service lifecycle, reconnect,
recovery, and local consent on every target operating system before rollout.

## Install

```sh
npm install @fentaris/edge
```

Most users should operate Edge through the central CLI:

```sh
fentaris edge join https://control.example --name "Build Mac" --json
fentaris edge status --json
```

The legacy `fentaris-edge` binary remains available for compatibility. Prefer
`fentaris edge` for new automation.

## Runtime requirements

- Node.js 20 or newer for published packages.
- An explicit executable/package allowlist for launched MCP workloads.
- Local approval for managed installations and setup operations.
- HTTPS for non-loopback control-plane connections.

See the [Edge documentation](https://fentaris.dev/reference/edge) and
[repository](https://github.com/Fentaris/fentaris) for setup, recovery, and
rollback guidance.
