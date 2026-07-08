---
"@fentaris/core": minor
"@fentaris/cli": minor
---

Add agent-native MCP tool discovery and auth inspection. Core now validates `cli.mcpAccounts` selectors and exposes `AgentToolDiscoveryService` with stable JSON envelopes, policy-filtered effective tool listing, search, detail, schema inspection, account status, login affordances, pagination, and response budgeting. The CLI adds `fentaris tools list/search/get/schema` and `fentaris tools auth list/status/login`.
