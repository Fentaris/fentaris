---
"@fentaris/core": patch
"@fentaris/cli": patch
---

Harden guided secrets setup and credential readiness: reject empty prompts, print generated API keys immediately after successful writes, skip no-op setup reruns, treat legacy manifests without source metadata as local during checks, and align whitespace/env locator behavior.
