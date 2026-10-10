---
"@fentaris/cli": major
"@fentaris/core": minor
---

Replace the CLI tools namespace with mcp, without a compatibility alias. Add administrative connection inventory, grouped bounded discovery, named upstream account selection, progressive authentication, offline/JSON contracts, and explicit legacy OAuth migration. Existing scripts must migrate to the new command surface.

Add named upstream accounts and runtime account restrictions independently of incoming client identities, shared-vault OAuth lifecycle records, safe temporary transport cleanup, and automatic project .env loading before configuration. Credentials and legacy authorizations remain separate; stored tokens alone do not establish remote validity.
