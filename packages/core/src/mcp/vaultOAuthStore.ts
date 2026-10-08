import { oauthTokensExpireAt, type OAuthSessionKey, type OAuthStoreEntry, type OAuthStoreRecord, type OAuthTokenStore } from "../auth/oauth/store.js";

/** Minimal shared ProjectVault contract used by upstream authentication. @pk */
export type McpVault = {
  resolve(reference: string): Promise<string | undefined>;
  set(reference: string, value: string, options?: { consumer?: { kind: "mcp"; server: string; account: string }; replaceSource?: boolean }): Promise<unknown>;
  detachConsumer?(reference: string, consumer: { kind: "mcp"; server: string; account: string }): Promise<unknown>;
};
/** OAuth lifecycle records are internal, never ordinary editable secrets. @pk */
export const MCP_OAUTH_SECRET_PREFIX = "fentaris.internal.oauth.";
export function mcpOAuthSecretReference(server: string, account: string): string {
  return `${MCP_OAUTH_SECRET_PREFIX}${Buffer.from(server).toString("base64url")}.${Buffer.from(account).toString("base64url")}`;
}

/** Account-scoped OAuth records in the shared encrypted vault; legacy namespaces stay separate. @pk */
export class McpVaultOAuthTokenStore implements OAuthTokenStore {
  private readonly known = new Map<string, { server: string; account: string }>();
  private writeChain: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: { vault: McpVault; connections: Array<{ server: string; account: string }> | (() => Array<{ server: string; account: string }>); legacyStore?: OAuthTokenStore }) {
    this.refreshConnections();
  }
  private refreshConnections() {
    for (const connection of typeof this.options.connections === "function" ? this.options.connections() : this.options.connections) this.known.set(`${connection.server}\u0000${connection.account}`, connection);
  }
  async get(server: string, session: OAuthSessionKey): Promise<OAuthStoreRecord | undefined> {
    if (!session.startsWith("account:")) return this.options.legacyStore?.get(server, session);
    const value = await this.options.vault.resolve(mcpOAuthSecretReference(server, session.slice(8)));
    if (value) this.known.set(`${server}\u0000${session.slice(8)}`, { server, account: session.slice(8) });
    return value ? JSON.parse(value) as OAuthStoreRecord : undefined;
  }
  async set(server: string, session: OAuthSessionKey, record: OAuthStoreRecord): Promise<void> {
    if (!session.startsWith("account:")) {
      if (!this.options.legacyStore) throw new Error("Legacy OAuth writes require an explicitly configured legacy store.");
      return this.options.legacyStore.set(server, session, record);
    }
    const account = session.slice(8);
    this.known.set(`${server}\u0000${account}`, { server, account });
    await this.options.vault.set(mcpOAuthSecretReference(server, account), JSON.stringify(record), { consumer: { kind: "mcp", server, account } });
  }
  async update(server: string, session: OAuthSessionKey, mutate: (record: OAuthStoreRecord) => OAuthStoreRecord): Promise<OAuthStoreRecord> {
    const run = this.writeChain.then(async () => {
      const next = { ...mutate((await this.get(server, session)) ?? { updatedAt: 0 }), updatedAt: Date.now() };
      await this.set(server, session, next); return next;
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }
  async delete(server: string, session: OAuthSessionKey): Promise<void> {
    if (!session.startsWith("account:")) return this.options.legacyStore?.delete(server, session);
    // Clear just this lifecycle record; never remove a user-managed/shared reference.
    await this.set(server, session, { updatedAt: Date.now() });
    await this.options.vault.detachConsumer?.(mcpOAuthSecretReference(server, session.slice(8)), { kind: "mcp", server, account: session.slice(8) });
  }
  async list(): Promise<OAuthStoreEntry[]> {
    this.refreshConnections();
    const rows: OAuthStoreEntry[] = [...(await this.options.legacyStore?.list() ?? [])];
    for (const { server, account } of this.known.values()) {
      const session: OAuthSessionKey = `account:${account}`;
      const record = await this.get(server, session);
      if (record) rows.push({ server, session, hasTokens: Boolean(record.tokens?.access_token), hasClientInformation: Boolean(record.clientInformation), expiresAt: oauthTokensExpireAt(record.tokens), updatedAt: record.updatedAt });
    }
    return rows;
  }
}
