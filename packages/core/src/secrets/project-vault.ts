import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { FentarisAuth } from "../auth/auth.js";
import { decryptEnvelope, encryptedEnvelopeSchema, encryptEnvelope, parseWithError } from "../auth/envelope.js";
import { oauthTokensExpireAt, type OAuthTokenStore, type OAuthStoreRecord, type OAuthSessionKey } from "../auth/oauth/store.js";
import type { IdentityStrategy } from "../types/policy.js";
import { systemCredentialStore, type SystemCredentialStore } from "./system-credential-store.js";

const nameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const consumerSchema = z.object({ kind: z.enum(["mcp", "configuration"]), server: nameSchema, account: nameSchema.optional() }).strict();
const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("vault") }).strict(),
  z.object({ type: z.literal("environment"), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
  z.object({ type: z.literal("external"), provider: nameSchema, locator: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,2047}$/) }).strict(),
]);
const referenceSchema = z.object({ reference: nameSchema, source: sourceSchema, consumers: z.array(consumerSchema), updatedAt: z.iso.datetime(), present: z.boolean() }).strict();
const keySchema = z.object({ id: nameSchema, name: nameSchema, user: nameSchema, createdAt: z.iso.datetime(), expiresAt: z.iso.datetime().optional(), revokedAt: z.iso.datetime().optional() }).strict();
const stateSchema = z.object({
  version: z.literal(1), projectId: z.uuid(), root: z.string(), references: z.array(referenceSchema), keys: z.array(keySchema), encrypted: encryptedEnvelopeSchema.optional(),
}).strict();
const payloadSchema = z.object({ projectId: z.uuid(), metadataDigest: z.string().optional(), values: z.record(nameSchema, z.string().min(1)), verifiers: z.record(nameSchema, z.string().regex(/^sha256:[a-f0-9]{64}$/)), oauth: z.record(z.string(), z.custom<OAuthStoreRecord>((value) => value !== null && typeof value === "object" && "updatedAt" in value && typeof value.updatedAt === "number")).default({}) }).strict();

export type SecretConsumer = z.infer<typeof consumerSchema>;
export type ProjectSecretSource = z.infer<typeof sourceSchema>;
export type IncomingKeyMetadata = z.infer<typeof keySchema>;
export type ProjectSecretMetadata = Omit<z.infer<typeof referenceSchema>, "updatedAt"> & {
  updatedAt?: string;
  state: "present" | "missing" | "locked" | "unresolvable" | "unverified";
  remoteValidity: "unverified";
  nextActions: string[];
};
export type ExternalSecretProvider = { resolve(locator: string): Promise<string | undefined> };
export type ProjectVaultOptions = {
  root: string; dir?: string; env?: NodeJS.ProcessEnv; unlockKey?: string;
  credentialStore?: SystemCredentialStore; externalProviders?: Record<string, ExternalSecretProvider>;
};
type State = z.infer<typeof stateSchema>;
type Payload = z.infer<typeof payloadSchema>;
/** A write was saved but subsequent read-back verification failed. No secret data is carried by the error. */
export class VaultWriteVerificationError extends Error {
  readonly stored = true;
  readonly verified = false;
  constructor() { super("Vault write succeeded, but read-back verification failed. Preserve the encrypted snapshot and inspect secrets check before retrying; revoke an undisplayed incoming key by ID."); }
}

/** Project-isolated source bindings and encrypted values. References confer no access rights. */
export class ProjectVault {
  private relocationRoot?: string;
  private authenticationCache?: { snapshot: string; verifiers: Promise<Payload["verifiers"]> };
  private constructor(readonly options: ProjectVaultOptions, readonly root: string, readonly file: string) {}
  static async open(options: ProjectVaultOptions): Promise<ProjectVault> {
    const root = await realpath(options.root);
    const dir = path.resolve(root, options.dir ?? ".fentaris");
    if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) throw new Error("The vault directory must be inside its project. Cross-project sharing requires an explicit external source.");
    let ancestor = dir;
    while (true) {
      try {
        const actual = await realpath(ancestor);
        if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) throw new Error("The vault directory resolves outside its project.");
        break;
      } catch (error) { if (!isMissing(error)) throw error; ancestor = path.dirname(ancestor); }
    }
    return new ProjectVault(options, root, path.join(dir, "vault.json"));
  }
  /** Explicitly adopt a copied vault after a project move; keep the signed original for rollback. */
  static async relocate(options: ProjectVaultOptions & { previousRoot: string }): Promise<ProjectVault> {
    const vault = await ProjectVault.open(options);
    vault.relocationRoot = path.resolve(options.previousRoot);
    const state = await vault.state();
    if (state.root !== vault.relocationRoot || !state.encrypted) throw new Error("Relocation requires an existing encrypted vault from the explicitly supplied previous project root.");
    await vault.payload(state);
    await writeFile(`${vault.file}.relocation-backup`, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await vault.mutate((saved) => { saved.root = vault.root; });
    vault.relocationRoot = undefined;
    return vault;
  }
  private async state(): Promise<State> {
    let source: string;
    try { source = await readFile(this.file, "utf8"); }
    catch (error) {
      if (!isMissing(error)) throw new Error("Unable to read the project vault.", { cause: error });
      return { version: 1, projectId: randomUUID(), root: this.root, references: [], keys: [] };
    }
    let input: unknown;
    try { input = JSON.parse(source); } catch { throw new Error("Invalid project vault JSON. Restore the previous encrypted snapshot."); }
    const state = parseWithError(stateSchema, input, "Invalid project vault schema");
    if (state.root !== this.root && state.root !== this.relocationRoot) throw new Error("This vault belongs to another project location. Use explicit relocation or migrate; credentials were not unlocked.");
    return state;
  }
  private async unlock(state: State, create = false): Promise<string> {
    const explicit = this.options.unlockKey ?? (this.options.env ?? process.env).FENTARIS_VAULT_KEY;
    if (explicit !== undefined) {
      if (!explicit.trim()) throw new Error("FENTARIS_VAULT_KEY must not be empty.");
      return explicit;
    }
    const store = this.options.credentialStore ?? systemCredentialStore();
    let key: string | undefined;
    try { key = await store.get(state.projectId); } catch { throw new Error("System credential storage is unavailable. Configure FENTARIS_VAULT_KEY explicitly; no plaintext fallback was used."); }
    if (key) return key;
    if (state.encrypted || !create) throw new Error("Vault is locked. Restore its system credential or configure FENTARIS_VAULT_KEY; an existing vault key will never be regenerated.");
    const generated = randomBytes(32).toString("base64url");
    try { await store.set(state.projectId, generated); } catch { throw new Error("System credential storage is unavailable. Configure FENTARIS_VAULT_KEY explicitly; no plaintext fallback was used."); }
    return generated;
  }
  private async payload(state: State, create = false): Promise<{ payload: Payload; key: string }> {
    const key = await this.unlock(state, create);
    const payload = state.encrypted
      ? parseWithError(payloadSchema, decryptEnvelope(state.encrypted, key, "Unable to unlock the project vault. The encrypted data was preserved."), "Invalid encrypted vault payload")
      : { projectId: state.projectId, values: {}, verifiers: {}, oauth: {} };
    if (state.encrypted && payload.metadataDigest !== metadataDigest(state)) throw new Error("Vault reference or key metadata was modified outside the vault. Restore the previous snapshot.");
    if (payload.projectId !== state.projectId) throw new Error("Vault project identity does not match its encrypted payload.");
    return { payload, key };
  }
  private async mutate<T>(operation: (state: State, payload: Payload) => T | Promise<T>, secrets = true): Promise<T> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await open(`${this.file}.lock`, "wx", 0o600); } catch { throw new Error("Another vault write is in progress. Retry after it finishes; inspect a stale vault.json.lock after a crash."); }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const state = await this.state();
      const loaded = state.encrypted ? await this.payload(state) : undefined;
      const payload: Payload = loaded?.payload ?? { projectId: state.projectId, values: {}, verifiers: {}, oauth: {} };
      const result = await operation(state, payload);
      if (secrets || state.encrypted) {
        const key = loaded?.key ?? await this.unlock(state, true);
        payload.metadataDigest = metadataDigest(state);
        state.encrypted = encryptEnvelope(payloadSchema.parse(payload), key);
        // Verify before replacing the recoverable previous state.
        parseWithError(payloadSchema, decryptEnvelope(state.encrypted, key, "Vault verification failed before writing."), "Invalid vault payload");
      }
      await writeFile(temporary, JSON.stringify(stateSchema.parse(state), null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file);
      try {
        const saved = await this.state();
        if (JSON.stringify(saved) !== JSON.stringify(stateSchema.parse(state))) throw new Error("Saved metadata differs.");
        if (saved.encrypted) await this.payload(saved);
      } catch { throw new VaultWriteVerificationError(); }
      return result;
    } finally {
      await rm(temporary, { force: true });
      await lock.close();
      await rm(`${this.file}.lock`, { force: true });
    }
  }
  async inventory(options: { offline?: boolean } = {}): Promise<ProjectSecretMetadata[]> {
    const state = await this.state();
    let values: Payload["values"] | undefined;
    if (state.encrypted) {
      try { values = (await this.payload(state)).payload.values; } catch { /* Locked is a resolution state, never a remotely verified result. */ }
    }
    return Promise.all(state.references.map(async (entry): Promise<ProjectSecretMetadata> => {
      let resolution: ProjectSecretMetadata["state"] = "missing";
      if (state.encrypted && !values) resolution = "locked";
      else if (entry.source.type === "vault") {
        if (entry.present && state.encrypted) {
          resolution = values ? values[entry.reference] ? "present" : "missing" : "locked";
        }
      } else if (entry.source.type === "environment") {
        resolution = (this.options.env ?? process.env)[entry.source.name] ? "present" : "missing";
      } else if (options.offline) resolution = "unverified";
      else {
        try { resolution = await this.resolve(entry.reference) ? "present" : "missing"; }
        catch { resolution = "unresolvable"; }
      }
      const nextActions = resolution === "present" ? [] : resolution === "locked" ? ["Configure FENTARIS_VAULT_KEY or restore the system credential."]
        : entry.source.type === "environment" ? [`Set ${entry.source.name} in the process environment or project .env.`]
        : entry.source.type === "external" ? [`Configure provider ${entry.source.provider} and check its locator; remote validity is unverified.`]
        : [`fentaris secrets set ${entry.reference}`];
      return { ...entry, present: resolution === "present", state: resolution, remoteValidity: "unverified", nextActions };
    }));
  }
  async get(reference: string, options: { offline?: boolean } = {}): Promise<ProjectSecretMetadata | undefined> {
    assertVaultName(reference, "Secret reference");
    return (await this.inventory(options)).find((entry) => entry.reference === reference);
  }
  /** Internal resolution path. Never put its result into output or metadata. */
  async resolve(reference: string): Promise<string | undefined> {
    assertVaultName(reference, "Secret reference");
    const state = await this.state();
    // Authenticate public bindings before using any source in an encrypted vault.
    const loaded = state.encrypted ? await this.payload(state) : undefined;
    const entry = state.references.find((candidate) => candidate.reference === reference);
    if (!entry) return undefined;
    if (entry.source.type === "environment") return (this.options.env ?? process.env)[entry.source.name] || undefined;
    if (entry.source.type === "external") {
      const provider = this.options.externalProviders?.[entry.source.provider];
      if (!provider) throw new Error("External secret provider is not configured. Configure the explicitly bound provider.");
      try { return await provider.resolve(entry.source.locator); }
      catch { throw new Error("External secret provider resolution failed. Check provider configuration; its error details were redacted."); }
    }
    return loaded?.payload.values[reference];
  }
  async set(reference: string, value: string, options: { consumer?: SecretConsumer; replaceSource?: boolean } = {}): Promise<void> {
    assertVaultName(reference, "Secret reference");
    if (!value) throw new Error("Secret value must not be empty.");
    const consumer = options.consumer ? parseWithError(consumerSchema, options.consumer, "Invalid secret consumer") : undefined;
    await this.mutate((state, payload) => {
      const existing = state.references.find((entry) => entry.reference === reference);
      if (existing && existing.source.type !== "vault" && !options.replaceSource) throw new Error("This reference is bound to another source. Use an explicit source binding; values were not copied.");
      payload.values[reference] = value;
      if (existing) { existing.source = { type: "vault" }; existing.present = true; existing.updatedAt = new Date().toISOString(); }
      else state.references.push({ reference, source: { type: "vault" }, present: true, updatedAt: new Date().toISOString(), consumers: [] });
      const entry = state.references.find((item) => item.reference === reference)!;
      if (consumer && !entry.consumers.some((item) => JSON.stringify(item) === JSON.stringify(consumer))) entry.consumers.push(consumer);
    });
  }
  /** Explicit source change. Never copies a value or falls back to another store. */
  async bind(reference: string, source: ProjectSecretSource, options: { replaceSource?: boolean; consumer?: SecretConsumer } = {}): Promise<void> {
    assertVaultName(reference, "Secret reference");
    const parsed = parseWithError(sourceSchema, source, "Invalid secret source");
    const consumer = options.consumer ? parseWithError(consumerSchema, options.consumer, "Invalid secret consumer") : undefined;
    await this.mutate((state, payload) => {
      let entry = state.references.find((candidate) => candidate.reference === reference);
      if (entry && JSON.stringify(entry.source) !== JSON.stringify(parsed)) {
        if (!options.replaceSource) throw new Error("Reference source differs. Explicitly choose replaceSource to change it; no credentials were copied.");
        delete payload.values[reference];
      }
      if (!entry) { entry = { reference, source: parsed, consumers: [], present: false, updatedAt: new Date().toISOString() }; state.references.push(entry); }
      entry.source = parsed;
      entry.present = parsed.type === "vault" && Boolean(payload.values[reference]);
      entry.updatedAt = new Date().toISOString();
      if (consumer && !entry.consumers.some((item) => JSON.stringify(item) === JSON.stringify(consumer))) entry.consumers.push(consumer);
    }, false);
  }
  async remove(reference: string, options: { force?: boolean } = {}): Promise<SecretConsumer[]> {
    assertVaultName(reference, "Secret reference");
    return this.mutate((state, payload) => {
      const entry = state.references.find((item) => item.reference === reference);
      if (!entry) return [];
      if (entry.source.type !== "vault") throw new Error("This value is managed by its explicitly bound source. Remove it in the environment or external provider; no local value was deleted.");
      if (entry.consumers.length && !options.force) throw new Error("Secret is in use. Inspect its consumers and explicitly confirm removal with --force.");
      // Preserve reference, source, and consumers so check can report affected users.
      delete payload.values[reference];
      entry.present = false;
      entry.updatedAt = new Date().toISOString();
      return entry.consumers;
    });
  }
  /** Disconnect a connection without deleting shared credentials. */
  async detachConsumer(reference: string, consumer: SecretConsumer): Promise<void> {
    const parsed = parseWithError(consumerSchema, consumer, "Invalid secret consumer");
    await this.mutate((state) => {
      const entry = state.references.find((item) => item.reference === reference);
      if (entry) entry.consumers = entry.consumers.filter((item) => JSON.stringify(item) !== JSON.stringify(parsed));
    }, false);
  }
  async keys(user?: string): Promise<IncomingKeyMetadata[]> {
    if (user !== undefined) assertVaultName(user, "User");
    return (await this.state()).keys.filter((entry) => !user || entry.user === user);
  }
  /** Only this intentional creation result contains the sensitive raw key. */
  async createKey(user: string, name: string, expiresAt?: string): Promise<{ key: IncomingKeyMetadata; sensitiveValue: string }> {
    assertVaultName(user, "User"); assertVaultName(name, "Key name");
    if (expiresAt !== undefined && (!z.iso.datetime().safeParse(expiresAt).success || Date.parse(expiresAt) <= Date.now())) throw new Error("Expiry must be a future ISO 8601 UTC timestamp.");
    return this.mutate((state, payload) => {
      if (state.keys.some((item) => item.user === user && item.name === name && !item.revokedAt)) throw new Error("An active key with this user and name already exists. Revoke its ID or choose another name.");
      const key = { id: `fk_${randomUUID().replaceAll("-", "")}`, user, name, createdAt: new Date().toISOString(), ...(expiresAt ? { expiresAt } : {}) };
      const sensitiveValue = `fentaris_${randomBytes(32).toString("base64url")}`;
      payload.verifiers[key.id] = FentarisAuth.hashApiKey(sensitiveValue);
      state.keys.push(key);
      return { key, sensitiveValue };
    });
  }
  async revokeKey(id: string): Promise<IncomingKeyMetadata> {
    assertVaultName(id, "Key ID");
    return this.mutate((state, payload) => {
      const key = state.keys.find((item) => item.id === id);
      if (!key) throw new Error("Incoming key ID was not found. Run fentaris auth keys list.");
      key.revokedAt ??= new Date().toISOString();
      delete payload.verifiers[id];
      return key;
    });
  }
  async authenticate(value: string): Promise<string | null> {
    const state = await this.state();
    if (!state.encrypted) return null;
    // Compare the complete parsed file, including authenticated metadata, on every
    // request. File timestamps alone cannot detect tampering or immediate revocation.
    const snapshot = JSON.stringify(state);
    if (this.authenticationCache?.snapshot !== snapshot) {
      const cache = { snapshot, verifiers: this.payload(state).then(({ payload }) => ({ ...payload.verifiers })) };
      this.authenticationCache = cache;
      void cache.verifiers.catch(() => { if (this.authenticationCache === cache) this.authenticationCache = undefined; });
    }
    const verifiers = await this.authenticationCache.verifiers;
    for (const key of state.keys) {
      if (key.revokedAt || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now())) continue;
      const verifier = verifiers[key.id];
      if (verifier && FentarisAuth.compareApiKey(verifier, value)) return key.user;
    }
    return null;
  }
  identityStrategy(): IdentityStrategy {
    return { name: "project-vault-api-key", resolve: async (request) => {
      const value = request.headers?.["x-fentaris-api-key"];
      if (!value) return null;
      const user = await this.authenticate(value);
      return user ? { id: user } : null;
    } };
  }
  /** OAuth records are encrypted internal lifecycle data, excluded from manually editable references. */
  oauthStore(account: string): OAuthTokenStore {
    assertVaultName(account, "Upstream account alias");
    const locator = (server: string, session: OAuthSessionKey): string => {
      assertVaultName(server, "MCP server");
      if (session !== "shared" && !/^user:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session)) throw new Error("Invalid OAuth session namespace.");
      return JSON.stringify([server, account, session]);
    };
    const read = async (): Promise<Payload["oauth"]> => { const state = await this.state(); return state.encrypted ? (await this.payload(state)).payload.oauth : {}; };
    return {
      get: async (server, session) => (await read())[locator(server, session)],
      set: async (server, session, record) => { const id = locator(server, session); await this.mutate((_state, payload) => { payload.oauth[id] = { ...record, updatedAt: record.updatedAt || Date.now() }; }); },
      delete: async (server, session) => { const id = locator(server, session); await this.mutate((_state, payload) => { delete payload.oauth[id]; }); },
      update: async (server, session, apply) => { const id = locator(server, session); return this.mutate((_state, payload) => {
        let updated: OAuthStoreRecord;
        try { updated = apply(payload.oauth[id] ?? { updatedAt: 0 }); }
        catch { throw new Error("OAuth lifecycle update failed; provider details were redacted and the previous record was preserved."); }
        const next = { ...updated, updatedAt: Date.now() }; payload.oauth[id] = next; return next;
      }); },
      list: async () => Object.entries(await read()).flatMap(([id, record]) => {
        const [server, storedAccount, session] = JSON.parse(id) as [string, string, OAuthSessionKey];
        if (storedAccount !== account) return [];
        const expiresAt = oauthTokensExpireAt(record.tokens);
        return [{ server, session, hasTokens: Boolean(record.tokens), hasClientInformation: Boolean(record.clientInformation), updatedAt: record.updatedAt, ...(expiresAt === undefined ? {} : { expiresAt }) }];
      }),
    };
  }
  /** Explicit legacy OAuth migration. Session scopes are not interpreted as upstream account names. */
  async migrateLegacyOAuth(options: { file: string; key: string; mappings: Array<{ server: string; session: OAuthSessionKey; account: string }> }): Promise<{ records: number; verified: true; legacyPreserved: true }> {
    let encrypted: unknown;
    try { encrypted = JSON.parse(await readFile(options.file, "utf8")); } catch { throw new Error("Unable to read the legacy OAuth store; no migration was performed."); }
    const legacy = decryptEnvelope(parseWithError(encryptedEnvelopeSchema, encrypted, "Invalid legacy OAuth envelope"), options.key, "Unable to unlock legacy OAuth store. Restore its original key.");
    const state = parseWithError(z.record(z.string(), z.record(z.string(), z.custom<OAuthStoreRecord>((value) => value !== null && typeof value === "object" && "updatedAt" in value))), legacy, "Invalid legacy OAuth state");
    return this.mutate((_state, payload) => {
      for (const mapping of options.mappings) {
        assertVaultName(mapping.server, "MCP server"); assertVaultName(mapping.account, "Upstream account alias");
        const record = state[mapping.server]?.[mapping.session];
        if (!record) throw new Error("Mapped legacy OAuth session was not found; no migration was written.");
        const id = JSON.stringify([mapping.server, mapping.account, mapping.session]);
        if (payload.oauth[id]) throw new Error("OAuth migration target exists. Reauthorize or choose an explicit unused upstream account; existing records were preserved.");
        payload.oauth[id] = record;
      }
      return { records: options.mappings.length, verified: true, legacyPreserved: true } as const;
    });
  }
  /** Legacy input remains untouched, including its unlock key, until operator verification. */
  async migrateLegacy(options: { file: string; key: string; mappings: Array<{ reference: string; scope: "default" | `user:${string}` | `group:${string}`; target: string }>; incomingKeys?: boolean }): Promise<{ references: number; keys: number; verified: true; legacyPreserved: true }> {
    let encrypted: unknown;
    try { encrypted = JSON.parse(await readFile(options.file, "utf8")); } catch { throw new Error("Unable to read legacy encrypted store; no migration was performed."); }
    const old = FentarisAuth.decryptCredentials(encrypted, options.key);
    for (const mapping of options.mappings) { assertVaultName(mapping.target, "Migration target"); assertVaultName(mapping.reference, "Legacy reference"); }
    return this.mutate((state, payload) => {
      let references = 0, keys = 0;
      for (const mapping of options.mappings) {
        if (state.references.some((item) => item.reference === mapping.target)) throw new Error("Migration target already exists. Choose a new target; existing data was preserved.");
        const value = mapping.scope === "default" ? old.defaults[mapping.reference]
          : mapping.scope.startsWith("user:") ? old.users[mapping.scope.slice(5)]?.credentials[mapping.reference]
          : old.groups[mapping.scope.slice(6)]?.[mapping.reference];
        if (!value) throw new Error("A mapped legacy credential is missing; no migration was written.");
        payload.values[mapping.target] = value;
        state.references.push({ reference: mapping.target, source: { type: "vault" }, present: true, consumers: [], updatedAt: new Date().toISOString() }); references++;
      }
      if (options.incomingKeys) for (const [user, entry] of Object.entries(old.users)) {
        assertVaultName(user, "Legacy user");
        for (const [index, verifier] of entry.apiKeys.entries()) {
          const key = { id: `fk_${randomUUID().replaceAll("-", "")}`, user, name: `legacy-${index + 1}`, createdAt: new Date().toISOString() };
          const hash = /^sha256:[a-f0-9]{64}$/.test(verifier) ? verifier : FentarisAuth.hashApiKey(verifier);
          if (state.keys.some((existing) => payload.verifiers[existing.id] === hash)) {
            if (state.keys.some((existing) => existing.user !== user && payload.verifiers[existing.id] === hash)) throw new Error("Legacy key is shared by different incoming users. Resolve this ambiguity explicitly before migration.");
            continue;
          }
          state.keys.push(key); payload.verifiers[key.id] = hash; keys++;
        }
      }
      return { references, keys, verified: true, legacyPreserved: true } as const;
    });
  }
}
export function assertVaultName(value: string, label: string): void {
  if (!nameSchema.safeParse(value).success) throw new Error(`${label} must contain 1-128 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.`);
}
export function projectVaultIdentityStrategy(options: ProjectVaultOptions): IdentityStrategy {
  let vault: Promise<ProjectVault> | undefined;
  return { name: "project-vault-api-key", resolve: async (request) => {
    if (!request.headers?.["x-fentaris-api-key"]) return null;
    vault ??= ProjectVault.open(options).catch((error: unknown) => { vault = undefined; throw error; });
    return (await vault).identityStrategy().resolve(request);
  } };
}
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

function metadataDigest(state: State): string {
  const normalized = stateSchema.parse(state);
  return createHash("sha256").update(JSON.stringify({ projectId: normalized.projectId, root: normalized.root, references: normalized.references, keys: normalized.keys })).digest("hex");
}
