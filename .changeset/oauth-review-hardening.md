---
"@fentaris/core": patch
"@fentaris/cli": patch
---

Harden the upstream OAuth 2.1 client against redirect-based SSRF and multi-writer token state.

Guarded upstream fetch now follows redirects manually so every hop, not just the first URL, passes the network guardrails; credentials are dropped across origins and a redirect loop is refused. Dynamic client registrations are kept per redirect URI so a CLI login and the proxy no longer invalidate each other, and a refresh reuses the exact client the tokens were issued to. PKCE verifiers are matched to their authorization URL by `code_challenge`, so two concurrent logins on one session cannot swap them. Token records are updated read-modify-write inside the store lock. The hosted callback completes with a caller-supplied `oauth({ provider })` instead of a rebuilt default provider, `oauth.publicUrl` keeps its path prefix behind a reverse proxy, and an OAuth `clientSecret` credential reference is now rejected at validation time unless application defaults declare it. `fentaris auth login` opens the browser without a shell, so Windows no longer truncates the authorization URL at the first `&`, and a missing opener falls back to printing the URL instead of terminating the CLI.
