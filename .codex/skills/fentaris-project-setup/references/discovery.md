# Discovery

Use this reference before creating a new Fentaris project. The goal is to help the user understand the proxy model and choose a setup workflow, not to interrogate them.

## Short Introduction

When the user is new to Fentaris, explain this mental model:

- MCP clients usually need to know every server they connect to.
- Fentaris puts one controlled proxy endpoint in front of those MCP servers.
- The client connects to one stable URL, while Fentaris handles upstream server configuration, naming, users/groups, policy, secrets, logging, and runtime checks.

Keep the explanation grounded in their case. For example:

- Solo local setup: "You get one local endpoint and can add/remove MCP servers without reconfiguring every client."
- Team setup: "The team shares one governed MCP entrypoint instead of each machine having a different MCP setup."
- Cloud or internal service: "The app can apply identity, policy, and audit rules at the edge before MCP tools run."

## Discovery Questions

Ask only the unanswered questions needed for the next decision. Prefer 3-6 questions at a time.

### Users And Access

- Is this for one developer, a small team, or users of an application?
- Should different users or groups see different tools?
- Are users known locally, passed from an existing app, or not defined yet?
- Is there an existing auth boundary, such as API keys, headers from your backend, or a gateway?

### Machines And Runtime

- Will the proxy run on the same machine as the MCP client, on a shared machine, or in cloud/server infrastructure?
- Do users need to connect from different computers?
- Should it be local-only for now, or shaped for a future shared deployment?
- Which package manager and TypeScript style does the project use?

### MCP Servers

- Which MCP servers should be connected first?
- For each server, is it stdio, Streamable HTTP, SSE/HTTP, or unknown?
- Which servers require credentials?
- Which tools should be allowed initially, and which should be blocked?

### Governance

- Are policies needed now, or is this an initial local prototype?
- Are approvals needed for sensitive tools?
- Should calls be logged for debugging, audit, or both?
- Are there staging/production differences to plan for?

## Current Limits To Surface

- OAuth 2.1 is not supported yet. Do not promise OAuth 2.1 setup. If the user asks for OAuth, explain the current limit and suggest a temporary architecture with API keys, trusted upstream identity headers, or an external auth boundary.
- Fentaris deploy is not available yet. Do not run deploy commands. Shape the project so it can move cleanly to a future CLI deploy flow.

## Recommendation Shape

After discovery, recommend one workflow:

```md
I would set this up as a <workflow name>.

Reason:
- <why this fits users/runtime>
- <why this fits MCP servers/auth>
- <what we keep flexible for later>

Initial project shape:
- Endpoint: <local/shared/cloud-shaped>
- Users/auth: <local users/API key/header identity/none yet>
- MCP servers: <list>
- Policies: <starting policy>
- Validation: <checks to run>
```

Then ask for confirmation only if a decision is risky or irreversible. Otherwise proceed with the setup.
