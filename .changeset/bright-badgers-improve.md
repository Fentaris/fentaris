---
"@fentaris/core": minor
"@fentaris/cli": patch
---

Improve the generated project and runtime DX: `fentaris()` now picks up local project defaults, deferred MCP declarations can satisfy policy validation before start, scoped middleware receives contextual types, and a concise `rateLimit({ max, per })` helper is available.

`fentaris dev` now runs the configured entrypoint directly, loads `.env`, and forwards termination signals to the child process.
