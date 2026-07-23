---
"@fentaris/cli": patch
---

Make `doctor --runtime` probe the already-running MCP endpoint without spawning a
second development server or reporting the expected listening port as a conflict.
