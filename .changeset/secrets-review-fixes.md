---
"@fentaris/cli": patch
"@fentaris/core": patch
---

Fix secrets manifest generation and local secrets presence checks.

Generated projects now allow `.fentaris/secrets.manifest.json` to be committed while keeping local secret files ignored, and `fentaris secrets manifest` creates the auth directory before writing the manifest. The local secrets backend no longer reports arbitrary user-scoped credentials as present when a user only has API keys.
