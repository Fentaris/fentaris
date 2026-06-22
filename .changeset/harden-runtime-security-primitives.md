---
"@fentaris/core": minor
---

Harden runtime security primitives by routing declared API key checks through the shared timing-safe comparison helper, enforcing rate limits through atomic consume operations, and redacting token-like values before logger and profiler sink dispatch.
