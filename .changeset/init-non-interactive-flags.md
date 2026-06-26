---
"@fentaris/cli": patch
---

Fix `fentaris init --non-interactive` by supporting explicit scaffold inputs, including `--package-manager`, by failing early when the project name is missing, and by reporting unavailable explicit package managers before install runs.
