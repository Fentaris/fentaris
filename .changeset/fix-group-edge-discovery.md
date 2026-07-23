---
"@fentaris/core": patch
---

Avoid cloud discovery fallback for policy-hidden edge MCP servers during `tools/list`. Exact tool allows now win over a companion `*` deny in both discovery pre-filtering and group tool listing, matching call-time policy evaluation.
