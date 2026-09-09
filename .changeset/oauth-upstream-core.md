---
"@fentaris/core": minor
---

Perform OAuth 2.1 against upstream MCP servers declared with `auth: oauth()`.

Fentaris now handles protected-resource and authorization-server discovery, dynamic client registration, PKCE, token exchange, and refresh for native Streamable HTTP and SSE upstreams, with one authorization per Fentaris user by default. `oauth.clientCredentials(...)` covers machine-to-machine access and `oauth({ provider })` exposes the MCP SDK provider for full control.

Tokens, client registrations, and discovery state persist in an encrypted `<authDir>/oauth-tokens.enc.json` store that the proxy and the CLI share without a restart; a pluggable `OAuthTokenStore` replaces it. A pending authorization reaches the human through MCP URL elicitation with a structured tool-result fallback, completes on a Fentaris-hosted callback route, and the original tool call is retried. `tools/list` omits an upstream that still needs a login instead of failing, and `fentaris__auth_status` and `fentaris__auth_login` let an agent see and start a login. Authorization-server traffic passes the same network guardrails as the upstream URL, OAuth tokens are exempt from the startup credential readiness gate, and new `FENTARIS_CONFIG_OAUTH_*` diagnostics validate the configuration.
