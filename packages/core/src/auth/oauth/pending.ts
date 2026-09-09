import { randomBytes } from "node:crypto";
import type { OAuthSessionKey } from "./store.js";

const defaultPendingTtlMs = 10 * 60 * 1000;

/**
 * Outcome of a pending authorization.
 * @pk
 */
export type PendingAuthorizationOutcome = { status: "completed" } | { status: "failed"; reason: string };

/**
 * A registered but not yet completed OAuth authorization.
 * @pk
 */
export type PendingAuthorization = {
  state: string;
  server: string;
  session: OAuthSessionKey;
  createdAt: number;
  expiresAt: number;
  authorizationUrl?: string;
  codeVerifier?: string;
};

type PendingEntry = PendingAuthorization & {
  waiters: { resolve: (outcome: PendingAuthorizationOutcome) => void }[];
  notifyComplete?: () => void | Promise<void>;
  settled?: PendingAuthorizationOutcome;
};

/**
 * Options for {@link PendingAuthorizations}.
 * @pk
 */
export type PendingAuthorizationsOptions = {
  ttlMs?: number;
  now?: () => number;
};

/**
 * In-memory registry of authorizations awaiting a callback, keyed by OAuth `state`.
 * @pk
 */
export class PendingAuthorizations {
  private readonly entries = new Map<string, PendingEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: PendingAuthorizationsOptions = {}) {
    this.ttlMs = options.ttlMs ?? defaultPendingTtlMs;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Register a new pending authorization and return its `state` parameter.
   * @pk
   */
  register(server: string, session: OAuthSessionKey): string {
    this.sweep();
    const state = randomBytes(24).toString("base64url");
    const createdAt = this.now();
    this.entries.set(state, {
      state,
      server,
      session,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      waiters: [],
    });

    return state;
  }

  get(state: string): PendingAuthorization | undefined {
    this.sweep();
    return this.entries.get(state);
  }

  /**
   * Find the most recent pending authorization for a server and session.
   * @pk
   */
  findLatest(server: string, session: OAuthSessionKey): PendingAuthorization | undefined {
    this.sweep();
    let latest: PendingEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.server === server && entry.session === session && (!latest || entry.createdAt > latest.createdAt)) {
        latest = entry;
      }
    }

    return latest;
  }

  attachVerifier(state: string, codeVerifier: string): void {
    const entry = this.entries.get(state);
    if (entry) {
      entry.codeVerifier = codeVerifier;
    }
  }

  attachAuthorizationUrl(state: string, authorizationUrl: string): void {
    const entry = this.entries.get(state);
    if (entry) {
      entry.authorizationUrl = authorizationUrl;
    }
  }

  attachCompletionNotifier(state: string, notifyComplete: () => void | Promise<void>): void {
    const entry = this.entries.get(state);
    if (entry) {
      entry.notifyComplete = notifyComplete;
    }
  }

  codeVerifier(state: string): string | undefined {
    return this.entries.get(state)?.codeVerifier;
  }

  /**
   * Mark an authorization completed, wake its waiters, and fire the completion notifier.
   * @pk
   */
  async resolve(state: string): Promise<void> {
    await this.settle(state, { status: "completed" });
  }

  /**
   * Mark an authorization failed and wake its waiters.
   * @pk
   */
  async fail(state: string, reason: string): Promise<void> {
    await this.settle(state, { status: "failed", reason });
  }

  /**
   * Wait until an authorization settles or the timeout elapses.
   * @pk
   */
  async wait(state: string, timeoutMs: number): Promise<PendingAuthorizationOutcome | { status: "timeout" }> {
    const entry = this.entries.get(state);
    if (!entry) {
      return { status: "failed", reason: "unknown or expired authorization state" };
    }

    if (entry.settled) {
      return entry.settled;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.waiters = entry.waiters.filter((waiter) => waiter.resolve !== onSettled);
        resolve({ status: "timeout" });
      }, timeoutMs);
      timer.unref?.();

      const onSettled = (outcome: PendingAuthorizationOutcome): void => {
        clearTimeout(timer);
        resolve(outcome);
      };

      entry.waiters.push({ resolve: onSettled });
    });
  }

  /**
   * Drop every pending authorization for a server and session.
   * @pk
   */
  clear(server: string, session: OAuthSessionKey): void {
    for (const [state, entry] of this.entries) {
      if (entry.server === server && entry.session === session) {
        this.entries.delete(state);
      }
    }
  }

  private async settle(state: string, outcome: PendingAuthorizationOutcome): Promise<void> {
    const entry = this.entries.get(state);
    if (!entry || entry.settled) {
      return;
    }

    entry.settled = outcome;
    for (const waiter of entry.waiters.splice(0)) {
      waiter.resolve(outcome);
    }

    this.entries.delete(state);

    if (outcome.status === "completed" && entry.notifyComplete) {
      await entry.notifyComplete();
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [state, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(state);
        for (const waiter of entry.waiters.splice(0)) {
          waiter.resolve({ status: "failed", reason: "authorization expired before it was completed" });
        }
      }
    }
  }
}
