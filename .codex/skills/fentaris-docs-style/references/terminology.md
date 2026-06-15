# Terminology

Use these terms consistently.

- Product: `Fentaris`
- CLI binary: `fentaris`
- Core package: `@fentaris/core`
- CLI package: `@fentaris/cli`
- Project config file: `fentaris.json`
- Local runtime directory: `.fentaris/`
- Encrypted credential store: `.fentaris/credentials.enc.json`
- Default MCP endpoint: `http://localhost:4000/mcp`
- API key header: `x-fentaris-api-key`
- Generated API reference: `reference-auto`
- Preferred high-level proxy helper: `fentaris(...)`
- Preferred upstream server helper: `mcp(...)`
- Preferred stdio transport helper: `stdio(...)`
- Preferred HTTP upstream helper: `streamableHttp(...)`

Prefer "upstream MCP server" for servers behind the proxy, "client" for the MCP client connecting to Fentaris, and "policy" for allow rules.
