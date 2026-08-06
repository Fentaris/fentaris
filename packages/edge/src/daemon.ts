import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { edgeError, isEdgeError } from "@fentaris/core";
import type { EdgeAgent, EdgeAgentStatus } from "./agent.js";
import type { JsonStore } from "./platform.js";

export type EdgePersistentLifecycleState =
  | "stopped"
  | "starting"
  | "connecting"
  | "reconciling"
  | "ready"
  | "backoff"
  | "terminal"
  | "stopping";

export interface EdgePersistentStatus {
  readonly state: EdgePersistentLifecycleState;
  readonly updatedAt: number;
  readonly attempt: number;
  readonly connectedSince?: number;
  readonly nextReconnectAt?: number;
  readonly errorCategory?: "transient" | "terminal";
  readonly errorCode?: string;
}

export interface EdgeSingletonLease {
  release(): Promise<void>;
}

export interface EdgeSingletonLock {
  acquire(): Promise<EdgeSingletonLease>;
}

/** Owner-created filesystem singleton lock for one local Edge agent. */
export class FileEdgeSingletonLock implements EdgeSingletonLock {
  constructor(private readonly lockFile: string) {}

  async acquire(): Promise<EdgeSingletonLease> {
    const owner = `${process.pid}:${randomUUID()}`;
    const handle = await this.openOwnedLock(owner);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await handle.close();
        if (await lockOwner(this.lockFile) === owner) await rm(this.lockFile, { force: true });
      },
    };
  }

  private async openOwnedLock(owner: string): Promise<FileHandle> {
    for (;;) {
      try {
        const handle = await open(this.lockFile, "wx", 0o600);
        try {
          await handle.writeFile(owner);
          return handle;
        } catch (error) {
          await handle.close();
          await rm(this.lockFile, { force: true });
          throw error;
        }
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const existing = await lockOwner(this.lockFile);
        if (existing && processIsAlive(lockPid(existing))) {
          throw edgeError("EDGE_WORKLOAD", "Another Edge agent instance is already running.");
        }
        const staleFile = `${this.lockFile}.stale-${process.pid}-${randomUUID()}`;
        try {
          await rename(this.lockFile, staleFile);
          await rm(staleFile, { force: true });
        } catch (renameError) {
          if (!isNodeError(renameError, "ENOENT")) throw renameError;
        }
      }
    }
  }
}

export interface EdgeReconnectPolicy {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly jitterRatio?: number;
  readonly stableConnectionMs?: number;
  readonly terminalRetryMs?: number;
}

export interface EdgePersistentAgentOptions {
  readonly agent: EdgeAgent;
  readonly lock: EdgeSingletonLock;
  readonly statusStore: JsonStore<EdgePersistentStatus>;
  readonly reconnect?: EdgeReconnectPolicy;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Long-running supervised Edge lifecycle with safe reconnect and shutdown. */
export class EdgePersistentAgent {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly reconnect: Required<EdgeReconnectPolicy>;
  private controller?: AbortController;
  private running?: Promise<void>;
  private lease?: EdgeSingletonLease;
  private reconnectRequested = false;

  constructor(private readonly options: EdgePersistentAgentOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? abortableSleep;
    this.reconnect = {
      initialDelayMs: options.reconnect?.initialDelayMs ?? 1_000,
      maxDelayMs: options.reconnect?.maxDelayMs ?? 60_000,
      multiplier: options.reconnect?.multiplier ?? 2,
      jitterRatio: options.reconnect?.jitterRatio ?? 0.2,
      stableConnectionMs: options.reconnect?.stableConnectionMs ?? 30_000,
      terminalRetryMs: options.reconnect?.terminalRetryMs ?? 0,
    };
  }

  async start(): Promise<void> {
    if (this.running) throw edgeError("EDGE_WORKLOAD", "Edge persistent agent is already running.");
    this.lease = await this.options.lock.acquire();
    this.controller = new AbortController();
    await this.writeStatus({ state: "starting", attempt: 0 });
    this.running = this.runLoop(this.controller.signal).finally(async () => {
      await this.lease?.release();
      this.lease = undefined;
      this.controller = undefined;
      this.running = undefined;
    });
  }

  async wait(): Promise<void> {
    await this.running;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.writeStatus({ state: "stopping", attempt: 0 });
    this.controller?.abort();
    await this.options.agent.disconnect();
    await this.running;
  }

  async reconnectNow(): Promise<void> {
    if (!this.running) throw edgeError("EDGE_UNAVAILABLE", "Edge persistent agent is not running.");
    this.reconnectRequested = true;
    await this.options.agent.disconnect();
  }

  async status(): Promise<EdgePersistentStatus & { readonly agent: EdgeAgentStatus }> {
    const persisted = await this.options.statusStore.load() ?? {
      state: "stopped" as const,
      updatedAt: this.now(),
      attempt: 0,
    };
    return Object.freeze({ ...persisted, agent: await this.options.agent.status() });
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    let terminal = false;
    try {
      while (!signal.aborted) {
        const connectionStartedAt = this.now();
        try {
          await this.writeStatus({ state: "connecting", attempt });
          await this.options.agent.connect();
          await this.writeStatus({ state: "reconciling", attempt, connectedSince: connectionStartedAt });
          await this.writeStatus({ state: "ready", attempt, connectedSince: connectionStartedAt });
          await Promise.race([
            this.options.agent.waitUntilDisconnected(),
            waitForAbort(signal),
          ]);
          if (signal.aborted) break;
          const stable = this.now() - connectionStartedAt >= this.reconnect.stableConnectionMs;
          const requested = this.reconnectRequested;
          attempt = stable || requested ? 0 : attempt + 1;
          this.reconnectRequested = false;
          const delay = requested ? 0 : reconnectDelay(attempt, this.reconnect, this.random);
          await this.writeStatus({ state: "backoff", attempt, nextReconnectAt: this.now() + delay, errorCategory: "transient" });
          await this.sleep(delay, signal);
        } catch (error) {
          if (signal.aborted) break;
          const category = classifyReconnectError(error);
          const code = isEdgeError(error) ? error.code : undefined;
          if (category === "terminal" && this.reconnect.terminalRetryMs === 0) {
            await this.writeStatus({ state: "terminal", attempt, errorCategory: category, errorCode: code });
            terminal = true;
            return;
          }
          const delay = category === "terminal"
            ? this.reconnect.terminalRetryMs
            : reconnectDelay(attempt, this.reconnect, this.random);
          attempt += 1;
          await this.writeStatus({
            state: "backoff",
            attempt,
            nextReconnectAt: this.now() + delay,
            errorCategory: category,
            errorCode: code,
          });
          await this.sleep(delay, signal);
        }
      }
    } finally {
      await this.options.agent.disconnect();
      if (!terminal) await this.writeStatus({ state: "stopped", attempt: 0 });
    }
  }

  private async writeStatus(input: Omit<EdgePersistentStatus, "updatedAt">): Promise<void> {
    await this.options.statusStore.save(Object.freeze({ ...input, updatedAt: this.now() }));
  }
}

export function classifyReconnectError(error: unknown): "transient" | "terminal" {
  if (isEdgeError(error)) {
    return error.code === "EDGE_PROTOCOL"
      || error.code === "EDGE_UNAUTHORIZED_TARGET"
      || error.code === "EDGE_GRANT"
      ? "terminal"
      : "transient";
  }
  return "transient";
}

export function reconnectDelay(
  attempt: number,
  policy: Required<EdgeReconnectPolicy>,
  random: () => number = Math.random,
): number {
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.multiplier ** attempt);
  const jitter = base * policy.jitterRatio * ((random() * 2) - 1);
  return Math.max(0, Math.round(base + jitter));
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function lockOwner(lockFile: string): Promise<string | undefined> {
  try {
    return (await readFile(lockFile, "utf8")).trim() || undefined;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function lockPid(owner: string): number | undefined {
  const value = Number.parseInt(owner.split(":", 1)[0] ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}
