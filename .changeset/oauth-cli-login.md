---
"@fentaris/cli": minor
---

Add `fentaris auth login|status|logout` for upstream OAuth 2.1 servers.

`fentaris auth login <mcp> [--as user:<id>] [--print-url] [--port] [--json]` runs the whole flow in-process against a loopback redirect and writes tokens to the project's encrypted OAuth store, which a running proxy picks up without a restart. `--print-url` and `--non-interactive` never open a browser. `fentaris auth status` lists stored authorizations without printing token values, `fentaris auth logout` removes one, and `fentaris tools auth login` now performs the same real browser login instead of returning a delegated stub.
