---
"@fentaris/edge": patch
---

Keep the local Edge control socket within macOS path limits when the process temporary directory is deeply nested, and persist the bound address so CLI commands find the running control socket even when invoked with a different `TMPDIR`.
