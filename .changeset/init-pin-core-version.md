---
"@fentaris/cli": minor
---

`fentaris init` now pins `@fentaris/core` to a known version range (currently `^2.0.0`) instead of `latest`. This makes local SDK/CLI integration tests deterministic and prevents a generated project from silently running a different core than the one this CLI was released against. Pass `--core-version <range>` to override the default; semver ranges, dist tags, and `workspace:*`/`file:` references are all accepted.
