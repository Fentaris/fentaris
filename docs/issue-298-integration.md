# Issue #298 integration contract for #297

This contract describes implemented code in issue #298. Issue #297 remains responsible for MCP command names, named connections/accounts, discovery, upstream login flows, and connection authorization. Existing policy is still authoritative. An incoming user ID, a legacy user/group credential scope, and an upstream account alias are different namespaces.

## Published core API

Implementation: `packages/core/src/secrets/project-vault.ts`. Public exports: `@fentaris/core` (also re-exported by `packages/core/src/secrets/index.ts`).

```ts
ProjectVault.open(options: ProjectVaultOptions): Promise<ProjectVault>
ProjectVault.relocate(options: ProjectVaultOptions & {previousRoot: string}): Promise<ProjectVault>
vault.set(reference: string, value: string, options?: {
  consumer?: SecretConsumer; replaceSource?: boolean
}): Promise<void>
vault.bind(reference: string, source: ProjectSecretSource, options?: {
  consumer?: SecretConsumer; replaceSource?: boolean
}): Promise<void>
vault.inventory(options?: {offline?: boolean}): Promise<ProjectSecretMetadata[]>
vault.get(reference: string, options?: {offline?: boolean}): Promise<ProjectSecretMetadata | undefined>
vault.resolve(reference: string): Promise<string | undefined> // internal credential resolution only
vault.remove(reference: string, options?: {force?: boolean}): Promise<SecretConsumer[]>
vault.detachConsumer(reference: string, consumer: SecretConsumer): Promise<void>
vault.oauthStore(account: string): OAuthTokenStore
vault.migrateLegacyOAuth(options: {
  file: string; key: string;
  mappings: Array<{server: string; session: OAuthSessionKey; account: string}>
}): Promise<{records: number; verified: true; legacyPreserved: true}>
```

`ProjectVaultOptions = {root: string; dir?: string; env?: NodeJS.ProcessEnv; unlockKey?: string; credentialStore?: SystemCredentialStore; externalProviders?: Record<string, ExternalSecretProvider>}`. `dir` defaults to `.fentaris` and must resolve inside the canonical project root. Opening has no write/prompt side effects. `SystemCredentialStore` implements `get(projectId): Promise<string|undefined>` and `set(projectId,key): Promise<void>`. `ExternalSecretProvider` implements `resolve(locator): Promise<string|undefined>`; offline inventory never calls it.

```ts
type ProjectSecretSource =
  | {type: "vault"}
  | {type: "environment"; name: string}
  | {type: "external"; provider: string; locator: string};
type SecretConsumer = {
  kind: "mcp" | "configuration"; server: string; account?: string
};
type ProjectSecretMetadata = {
  reference: string; source: ProjectSecretSource; consumers: SecretConsumer[];
  updatedAt?: string; present: boolean;
  state: "present" | "missing" | "locked" | "unresolvable" | "unverified";
  remoteValidity: "unverified"; nextActions: string[]
};
```

Names (references, server/account/user/key/provider names) accept 1–128 letters, digits, dots, underscores, or hyphens, with an alphanumeric first character. Environment variable names use conventional identifier syntax. External public locators permit letters, digits, dots, underscores, colons, slashes, and hyphens, up to 2048 characters. Do not put credentials into locators or metadata.

For connect: use `set(reference,value,{consumer:{kind:"mcp",server,account}})` to store a value and its consumer atomically, or `bind(reference,source,{consumer})` for an explicit existing source. Keep the reference in public connection configuration. Do not create a raw-value config field. A failed/cancelled input phase must precede any mutation. For disconnect: call `detachConsumer` for that exact connection/account. Do not remove the value, since other consumers may share it. Source replacement always requires `replaceSource:true`; no automatic copying or fallback exists.

SDK source: `credentialVault(reference: string, options?: CredentialVaultOptions): CredentialVaultSource`, implemented in `packages/core/src/credentials/credentials.ts`. The exported `CredentialVaultOptions = Omit<ProjectVaultOptions,"root"> & {root?:string}` passes environment, unlock key, credential-store and external-provider adapters into runtime resolution. It participates in the existing `CredentialSource`/resolution abstraction and resolves the explicit reference source. Incoming key enforcement uses `projectVaultIdentityStrategy(options: ProjectVaultOptions): IdentityStrategy`; it never adds policy, groups, accounts, or connection permissions. The strategy reuses authenticated verifier data while the complete vault contents remain unchanged, rereads the file on every request, and rechecks expiry each time. Any metadata or envelope change invalidates the cache, including revocation by another process; failed authentication of modified metadata never falls back to a cached verifier.

## OAuth lifecycle

`vault.oauthStore(account)` implements the **existing** `OAuthTokenStore` from `packages/core/src/auth/oauth/store.ts`, including optional atomic `update`:

```ts
get(server, session): Promise<OAuthStoreRecord | undefined>
set(server, session, record): Promise<void>
delete(server, session): Promise<void>
update(server, session, apply): Promise<OAuthStoreRecord>
list(): Promise<OAuthStoreEntry[]>
```

Account is selected explicitly by the adapter factory; records are isolated by `[server, account, session]`. Session remains the existing `OAuthSessionKey` (`"shared"` or `user:<id>`); never reinterpret it as an account alias. Persist the existing `OAuthStoreRecord` including registrations, discovery, access/refresh tokens, obtained-at/expiry metadata. Lifecycle records are encrypted internal data: they never appear in ordinary secrets inventory or manual set/remove commands. `list` exposes only existing redacted OAuth metadata.

OAuth writes are queued per vault instance across account adapters. Independent instances/processes wait up to five seconds for the shared file lock, then reread and merge under that lock. A stale lock times out without deletion or token-store fallback; preserve it for operator recovery. Failed updates do not poison subsequent queued writes. Interactive/manual secret writes still return a retryable concurrency error immediately.

Authenticated reads share a cached decrypted snapshot while the complete file remains unchanged. OAuth `get` returns an independent copy, so callers cannot mutate cached records. File changes from local or other-process writes force reauthentication; reads of tampered metadata fail without using the old cache. Mutations always load a fresh working payload under the file lock.

The SDK resolver retains a vault per `CredentialVaultSource` declaration with unchanged options, so repeated upstream credential lookups also share authenticated reads. Changing its project location or adapter/unlock options opens a fresh vault. Default project discovery still runs per resolution; it cannot reuse a declaration's previous project after the working project changes.

Explicit legacy OAuth migration maps each `{server,session}` to an account and retains the original encrypted file/key. Existing targets, missing records, or failed unlocks abort before replacement. No OAuth migration is automatic. Account-scoped adapters can be injected into the existing OAuth manager/store abstraction by #297; #298 does not implement account-aware manager selection or pretend a single adapter handles every account.

## Shared CLI contract

Implementation: `packages/cli/src/shared/input.ts`; exported by `packages/cli/src/index.ts`.

```ts
canPrompt(runtime: Runtime, options?: CliOptions): boolean
completeInput(runtime: Runtime, options: CliOptions, fields: Array<{
  name: string; value: unknown; label: string; secret?: boolean
}>, next: string): Promise<Record<string,string>>
chooseAction(runtime: Runtime, options: CliOptions, actions: string[], next: string): Promise<string>
commandResult(runtime: Runtime, options: CliOptions, data: unknown, human: string[], ok?: boolean): void
commandError(runtime: Runtime, json: boolean, error: unknown): void
sanitizeCommandMessage(message: string): string
```

Mark each relevant command spec `progressive:true` in `packages/cli/src/shared/cli-spec.ts`. `parseCommand` puts boolean `true` into a recognized missing value-taking option, keeping the following flag untouched. Treat `undefined`/`true` as missing and supplied strings as authoritative; validate explicit values before other prompts. Unknown/duplicate flags and excess positional arguments fail parsing. `Runtime.nonInteractive` is true in non-TTY default execution. JSON mode also disables all prompts. Bare commands must use explicit action selection or a read-only inventory.

`CommandInputError` exposes `code:"MISSING_INPUT"`, `missingFields:string[]`, and `nextActions:string[]`. Shared JSON output is one `{ok,data}` result or `{ok:false,error:{code,message,...}}` error; error messages sanitize credential URLs/headers. Do not print progress on stdout in JSON mode or print a result and then throw a second result. `VaultWriteVerificationError` carries `stored:true,verified:false` after a persisted write that fails read-back verification. Report both facts; no raw key is delivered after that failure.

Project discovery wrapper: `packages/cli/src/domain/secrets/vault.ts`, exported as `openProjectVault(project: ProjectDiscovery, runtime: Runtime): Promise<ProjectVault>`. It uses `project.root`, `project.config.authDir`, loaded environment, and optional `runtime.vaultOptions` (`credentialStore`, `externalProviders`). Upstream flows should use this wrapper rather than an additional storage/prompt implementation.

Core environment exports from `packages/core/src/secrets/environment.ts`:

```ts
findEnvironmentProjectRoot(from?: string): string
loadProjectEnvironment(root: string, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
applyProjectEnvironment(root?: string): void
```

`packages/core/src/secrets/environment-bootstrap.ts` runs at the beginning of the public core entry point. CLI `main` loads project environment before route/config import and restores temporary process changes afterward. Existing process/base environment, including empty strings, wins over `.env`. The CLI project env wrapper delegates to this same loader. For custom launchers, load before dynamically importing configuration.

## Storage/schema and migration boundary

`<authDir>/vault.json` is version 1: `{version:1,projectId:UUID,root:canonicalRoot,references:[{reference,source,consumers,updatedAt,present}],keys:[IncomingKeyMetadata],encrypted?:EncryptedEnvelope}`. `EncryptedEnvelope` is the existing version-2 AES-256-GCM/PBKDF2 envelope. Its payload is `{projectId,metadataDigest,values:Record<reference,string>,verifiers:Record<keyId,"sha256:...">,oauth:Record<JSON tuple [server,account,session],OAuthStoreRecord>}`. Reference/key metadata is authenticated by the encrypted digest. Public-only source bindings can exist without encrypted content or an unlock key. OAuth record layout is internal; use the store API instead of editing the payload.

Do not change `vault.json` directly or create a second key beside it. macOS Keychain uses service `com.fentaris.project-vault`, account `projectId`; servers/CI configure `FENTARIS_VAULT_KEY` explicitly. Existing encrypted vaults never regenerate keys. Writes lock and atomically replace files; retry concurrent write failures after the current writer finishes.

Legacy `SecretsManifest` stays version 1 with the additive source `{type:"vault",reference?:string}`. Note that its pre-existing environment discriminator is `"env"`, whereas the new reference source discriminator is `"environment"`. Do not silently reinterpret old `scope:"user:..."|"group:..."` entries as account aliases. CLI static configuration inventory adds read-only configuration consumers without importing modules; #297 should register named MCP consumers explicitly. `migrateLegacy` and `secrets migrate` require explicit public scoped mappings and retain old encrypted stores. See `docs/guides/project-vault.mdx` for verified migration and rollback.

CLI inventory preserves distinct sources for the same logical reference across configuration scopes. Its rows can add `configurationScopes:string[]`; these are legacy/default configuration scopes, never upstream accounts. A `credentialVault` declaration follows the registered reference's effective source, while each direct `credentialEnv` declaration checks its exact variable independently. Multiple bindings produce multiple inventory rows; `secrets get --json` adds `data.bindings` when needed while retaining `data.secret` for the primary row. Reads never register or replace these bindings.

Static scanning cannot execute runtime options in `credentialVault`. Nonempty explicit options produce an `unresolvable` configuration binding with next actions, rather than being satisfied by the default CLI vault. Inspect custom locations/adapters through `ProjectVault` with those exact options. Scanner diagnostics do not contain option expressions or raw values.

## Integration checks to run after combining #297 and #298

Verify named account connect binds/stores atomically; refresh updates only the selected account; disconnect preserves a shared credential; a user cannot select an unauthorized connection merely by knowing its reference; `.env` precedes configuration import; both families use identical missing-value/JSON/noninteractive/offline behavior. #298 independently tests vault/OAuth account isolation, lifecycle updates and legacy mapping, input completion/cancellation, source/environment precedence, shared consumers, one-time key delivery, and real HTTP expiry/revocation. It does not claim the independent #297 command implementation is completed.
