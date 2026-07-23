---
"@fentaris/cli": patch
---

Generate pnpm projects as self-contained workspace roots and allow the `esbuild`
postinstall required by `tsx`, preventing installs from attaching to an ancestor
workspace or stopping for build approval.
