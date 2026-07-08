## 1. Public API Shape

- [x] 1.1 Define `User`, `Group`, `Policy`, and helper API names for the recommended DX
- [x] 1.2 Add TypeScript types for subject metadata, resolved subject, group membership, policy metadata, and credential source metadata
- [x] 1.3 Add `McpProxy` options for `groups` and `auth` without requiring a proxy-level users list
- [x] 1.4 Preserve compatibility with existing `user`, `identity`, `policy`, and `SimplePolicy` options where practical
- [x] 1.5 Export the new governance DX APIs from `packages/core/src/index.ts`

## 2. Subject And Group Runtime

- [x] 2.1 Implement user declarations with non-sensitive metadata only
- [x] 2.2 Implement group declarations that own users and a policy
- [x] 2.3 Build a subject index from configured groups during proxy initialization
- [x] 2.4 Validate duplicate user ids, conflicting user metadata, empty groups, and unknown authenticated users
- [x] 2.5 Add tests for single-group membership, multi-group membership, duplicate conflicts, and unknown users

## 3. Policy DX

- [x] 3.1 Implement the developer-facing `Policy` API with fluent server, allow, deny, and allowAll support
- [x] 3.2 Implement permission helpers for limiters, approvals, and sensitive metadata
- [x] 3.3 Define and implement effective policy merge semantics for multiple groups with deny precedence
- [x] 3.4 Ensure listTools filtering and callTool evaluation use effective group policies
- [x] 3.5 Add tests for allows, denies, wildcard permissions, deny overrides, multiple limits, approvals, and sensitive metadata

## 4. Local Auth Store

- [x] 4.1 Define encrypted credentials JSON schema for user API keys, user credentials, group credentials, and default credentials
- [x] 4.2 Define upstream auth binding JSON schema for bearer, header, and env auth bindings
- [x] 4.3 Implement `FentarisAuth.local({ dir, key })` to load both local auth files behind one API
- [x] 4.4 Implement encryption/decryption and validation for the local credentials file
- [x] 4.5 Add clear startup errors for missing files, invalid keys, invalid encrypted payloads, and invalid upstream bindings
- [x] 4.6 Add tests for successful load, missing files, invalid decryption key, schema validation, and redacted diagnostics

## 5. API-Key Identity

- [x] 5.1 Implement API-key identity strategy with configurable header name
- [x] 5.2 Resolve API keys from encrypted local auth storage to declared user ids
- [x] 5.3 Ensure missing or invalid API keys fail closed before policy or upstream calls
- [x] 5.4 Support multiple active API keys per user for rotation
- [x] 5.5 Ensure raw API keys are not exposed to middleware, hooks, logs, or policy callbacks
- [x] 5.6 Add tests for valid key, missing key, invalid key, key rotation, and secret redaction

## 6. Credential Resolution And Upstream Auth

- [x] 6.1 Implement credential lookup with user > group > default precedence
- [x] 6.2 Define and implement deterministic behavior for multiple groups that provide the same credential reference
- [x] 6.3 Resolve upstream auth bindings for server names during listTools and callTool
- [x] 6.4 Inject bearer/header/env auth through compatible upstream transports without application code reading raw secrets
- [x] 6.5 Return safe MCP errors when required upstream credentials are missing
- [x] 6.6 Add tests for credential precedence, group fallback, default fallback, ambiguity handling, missing credentials, and auth injection

## 7. Governance Context

- [x] 7.1 Add `context.subject` with subject id, metadata, groups, tenant metadata, and membership helpers
- [x] 7.2 Add policy decision metadata for matched groups, policy names, permission metadata, and denial reasons
- [x] 7.3 Add credential source metadata without exposing decrypted credential values
- [x] 7.4 Pass subject and policy context to middleware, hooks, approval callbacks, and logging helpers
- [x] 7.5 Preserve `context.user.id` compatibility for existing middleware during the migration path
- [x] 7.6 Add tests that middleware can read subject context and cannot access raw secrets

## 8. Documentation And Tooling

- [x] 8.1 Document the recommended DX with `FentarisAuth.local`, `user`, `group`, `policy`, `mcp.*`, and `proxy.use`
- [x] 8.2 Document local auth file layout and explain which file is encrypted and which is safe to review
- [x] 8.3 Document API-key identity and why spoofable user id headers are only for trusted internal setups
- [x] 8.4 Document credential precedence and upstream auth binding examples for bearer, header, and env
- [x] 8.5 Add or update CLI helpers for initializing local auth, setting user API keys, setting credentials, and inspecting redacted config if the CLI scope supports it

## 9. Verification

- [x] 9.1 Run `pnpm --filter @fentaris/core test`
- [x] 9.2 Run `pnpm --filter @fentaris/core build`
- [x] 9.3 Run repository lint/typecheck commands required by the project
- [x] 9.4 Verify `openspec status --change "governance-auth-dx"` reports the change as apply-ready
