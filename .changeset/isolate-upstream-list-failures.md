---
"@fentaris/core": patch
---

Isolate per-upstream failures in runtime `resources/list`, `resources/templates/list`, and `prompts/list` as well as `tools/list`, so one refused, failing, or unauthorized upstream no longer fails the whole listing. Bound each upstream's contribution to an aggregated listing at 15 seconds so one unresponsive upstream cannot stall it into the client's request timeout, never start OAuth login while listing resources or prompts, and treat Edge `EDGE_SETUP_REQUIRED` and `EDGE_PROTOCOL` replies from one upstream as that upstream's failure.
