## Why

Several lower-level security primitives need hardening: one API key comparison path is not timing-safe, rate limit checks are not atomic under concurrency, and log redaction misses token-like values in generic fields. These issues undermine protections that other features depend on.

## What Changes

- Use timing-safe API key comparison consistently across all API key auth paths.
- Make rate limiter check-and-record operations atomic for each limiter key.
- Extend redaction beyond sensitive key names to token-like values in generic fields.
- Add focused tests for timing-safe comparison usage, concurrent limit enforcement, and value-pattern redaction.

## Capabilities

### New Capabilities

- `runtime-security-primitives`: Covers timing-safe credential comparison, atomic rate limit accounting, and value-based secret redaction.

### Modified Capabilities

- None.

## Impact

- Affects API key auth paths in `McpProxy`, rate limiter store contracts and middleware, and profiler/logger redaction utilities.
- May require small internal API changes to rate limit stores so checks and increments can happen atomically.
- Requires concurrency-sensitive tests for rate limiting.
