### Minor Changes

- 535b74e: Perform OAuth 2.1 against upstream MCP servers declared with `auth: oauth()`.

  Fentaris now handles protected-resource and authorization-server discovery, dynamic client registration, PKCE, token exchange, and refresh for native Streamable HTTP and SSE upstreams, with one authorization per Fentaris user by default. `oauth.clientCredentials(...)` covers machine-to-machine access and `oauth({ provider })` exposes the MCP SDK provider for full control.

  Tokens, client registrations, and discovery state persist in an encrypted `<authDir>/oauth-tokens.enc.json` store that the proxy and the CLI share without a restart; a pluggable `OAuthTokenStore` replaces it. A pending authorization reaches the human through MCP URL elicitation with a structured tool-result fallback, completes on a Fentaris-hosted callback route, and the original tool call is retried. `tools/list` omits an upstream that still needs a login instead of failing, and `fentaris__auth_status` and `fentaris__auth_login` let an agent see and start a login. Authorization-server traffic passes the same network guardrails as the upstream URL, OAuth tokens are exempt from the startup credential readiness gate, and new `FENTARIS_CONFIG_OAUTH_*` diagnostics validate the configuration.

### Patch Changes

- 4e49a38: Harden the upstream OAuth 2.1 client against redirect-based SSRF and multi-writer token state.

  Guarded upstream fetch now follows redirects manually so every hop, not just the first URL, passes the network guardrails; credentials are dropped across origins and a redirect loop is refused. Dynamic client registrations are kept per redirect URI so a CLI login and the proxy no longer invalidate each other, and a refresh reuses the exact client the tokens were issued to. PKCE verifiers are matched to their authorization URL by `code_challenge`, so two concurrent logins on one session cannot swap them. Token records are updated read-modify-write inside the store lock. The hosted callback completes with a caller-supplied `oauth({ provider })` instead of a rebuilt default provider, `oauth.publicUrl` keeps its path prefix behind a reverse proxy, and an OAuth `clientSecret` credential reference is now rejected at validation time unless application defaults declare it. `fentaris auth login` opens the browser without a shell, so Windows no longer truncates the authorization URL at the first `&`, and a missing opener falls back to printing the URL instead of terminating the CLI.
