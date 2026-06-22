# Configuration

## Setup Sequence

1. Create or select the project directory.
2. Install or use the Fentaris CLI.
3. Generate the project with `fentaris init <project-name>` when starting fresh.
4. Configure `fentaris.json` for project discovery, runtime entrypoint, port, host, endpoint path, and local auth directory.
5. Edit the TypeScript entrypoint with high-level declarations:
   - `fentaris(...)` as the app boundary.
   - `mcp(...)` for upstream servers.
   - `policy(...)`, `group(...)`, and `user(...)` for access control.
   - Built-in transport helpers such as stdio or Streamable HTTP where appropriate.
6. Add secrets through Fentaris secret commands or the project's established secret workflow. Do not embed secret values in code.
7. Add scripts or docs that match the generated project style.

## Preferred Implementation Pattern

Prefer a single readable app boundary:

```ts
import { fentaris, group, mcp, policy, stdio, user } from "@fentaris/core";

const supportPolicy = policy("support")
  .mcp("github")
  .allow("create_issue");

const app = fentaris({
  servers: [
    mcp("github", {
      displayName: "GitHub",
      transport: stdio({ command: "github-mcp-server" }),
    }),
  ],
  groups: [
    group({
      id: "support",
      users: [user("alice")],
      policy: supportPolicy,
    }),
  ],
  host: process.env.FENTARIS_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4000),
  path: "/mcp",
  autoLog: true,
});

await app.start();
```

Adapt the example to the user's actual upstreams and package manager. Do not copy it blindly when the generated project already has a suitable structure.

## Validation

Run the narrowest meaningful checks first:

- `fentaris check --offline` for static project checks.
- `fentaris doctor` for project/environment diagnostics.
- `fentaris doctor --runtime` after the proxy is running.
- Existing `build`, `typecheck`, or `test` scripts.

When the CLI supports `--non-interactive`, use it for agent-driven runs with explicit inputs. If a command prompts for a secret or production decision, ask the user.

## Documentation Lookup

Use local docs when inside the Fentaris repository. Otherwise, consult `https://fentaris.mintlify.app` for current CLI commands, config fields, and API examples when unsure.
