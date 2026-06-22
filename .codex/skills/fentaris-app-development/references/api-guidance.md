# API Guidance

## Default API Tier

Prefer the high-level application builders from `@fentaris/core`:

- `fentaris(...)` for the app boundary.
- `mcp(...)` for upstream declarations.
- `policy(...)`, `group(...)`, and `user(...)` for authorization.
- Built-in transport helpers for stdio and HTTP-style upstreams.

This style keeps servers, users, groups, policies, endpoint settings, logging, and hooks readable in one app model.

## Import Rules

- Use `@fentaris/core` for application code.
- Use `@fentaris/core/extensions` only when implementing custom extension contracts or avoiding name collisions with top-level helpers.
- Avoid `@fentaris/core/dist/*` and source-layout paths.

## Advanced Wiring

Fentaris also exposes lower-level proxy and transport construction for explicit wiring. Do not choose it by default. Use it only when:

- The user explicitly requests direct proxy/transport wiring.
- The app already uses that style and consistency matters.
- A custom downstream exposure or transport requirement cannot be represented through high-level declarations.

When using advanced wiring, check the official docs first because this surface is more fragile during alpha.

## Plugins

Experimental plugin contracts exist, but they are not a production plugin runtime. Do not build a user solution around plugin loading unless the user is explicitly exploring experimental contracts.
