# Personal Edge routing

This application factory demonstrates one logical `filesystem` tool surface routed to a user's default device. The first edge-dependent call pins the downstream session; a reconnect may advance the same device generation, but Fentaris never silently moves the session to another device.

Enroll the computer without a global install:

```bash
npx @fentaris/edge join https://fentaris.example --name "Alice Laptop"
```

Supply production `DeviceResolver` and Edge transport adapters to `createPersonalEdgeApp(...)`, then start the returned proxy through the normal exposure API.

[`src/managed-installation.ts`](./src/managed-installation.ts) shows two intentionally separate cases: a custom installer pinned to an exact Git commit and a desktop application that remains a manual prerequisite. Replace the placeholder repository, immutable commit, verification target, and vendor instructions with reviewed values before assigning either recipe.
