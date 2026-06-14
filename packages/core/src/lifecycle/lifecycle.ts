import { FentarisRuntimeError, FentarisTimeoutError, normalizeRuntimeError } from "../profiler/index.js";
import type { HealthReport } from "../health/index.js";

export type RuntimeLifecycleState =
  | "created"
  | "starting"
  | "ready"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

export type RuntimeLifecycleMetadata = {
  name: string;
  version: string;
  startedAt?: Date;
  stoppedAt?: Date;
  lastTransitionAt: Date;
  failure?: {
    name: string;
    code?: string;
    message: string;
  };
};

export type RuntimeLifecycleSnapshot = {
  state: RuntimeLifecycleState;
  metadata: RuntimeLifecycleMetadata;
};

export type RuntimeLifecycleOptions = {
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};

export type NormalizedRuntimeLifecycleOptions = Required<RuntimeLifecycleOptions>;

export type RuntimeLifecycleTransition = {
  from: RuntimeLifecycleState;
  to: RuntimeLifecycleState;
  at: Date;
};

export type RuntimeLifecycle = {
  start(options?: RuntimeLifecycleOptions): Promise<unknown>;
  ready(options?: RuntimeLifecycleOptions): Promise<RuntimeLifecycleSnapshot>;
  stop(options?: RuntimeLifecycleOptions): Promise<void>;
  state(): RuntimeLifecycleSnapshot;
  health(): Promise<HealthReport>;
};

export type RuntimeLifecycleControllerOptions = {
  name: string;
  version: string;
  defaults?: RuntimeLifecycleOptions;
  onTransition?: (transition: RuntimeLifecycleTransition) => void | Promise<void>;
};

export class RuntimeLifecycleController {
  private currentState: RuntimeLifecycleState = "created";
  private metadata: RuntimeLifecycleMetadata;
  private readonly defaults: NormalizedRuntimeLifecycleOptions;
  private readonly onTransition?: RuntimeLifecycleControllerOptions["onTransition"];
  private startPromise?: Promise<unknown>;
  private stopPromise?: Promise<void>;

  constructor(options: RuntimeLifecycleControllerOptions) {
    this.defaults = normalizeRuntimeLifecycleOptions(options.defaults);
    this.onTransition = options.onTransition;
    this.metadata = {
      name: options.name,
      version: options.version,
      lastTransitionAt: new Date(),
    };
  }

  state(): RuntimeLifecycleSnapshot {
    return {
      state: this.currentState,
      metadata: {
        ...this.metadata,
        failure: this.metadata.failure ? { ...this.metadata.failure } : undefined,
      },
    };
  }

  async start<T>(operation: () => Promise<T>, options?: RuntimeLifecycleOptions): Promise<T> {
    if (this.currentState === "ready" || this.currentState === "degraded") {
      return undefined as T;
    }
    if (this.currentState === "starting" && this.startPromise) {
      return this.startPromise as Promise<T>;
    }
    if (this.currentState === "stopping") {
      throw invalidTransition(this.currentState, "starting");
    }

    await this.transition("starting");
    const timeoutMs = normalizeRuntimeLifecycleOptions({ ...this.defaults, ...options }).startupTimeoutMs;
    this.startPromise = timeoutAfter(operation(), timeoutMs, "Runtime startup timed out", "startup")
      .then(async (result) => {
        this.metadata.startedAt = new Date();
        await this.transition("ready");
        return result;
      })
      .catch(async (error) => {
        const normalized = normalizeRuntimeError(error, { context: { phase: "startup" } });
        this.metadata.failure = {
          name: normalized.name,
          code: normalized.code,
          message: normalized.message,
        };
        await this.transition("failed");
        throw normalized;
      })
      .finally(() => {
        this.startPromise = undefined;
      });

    return this.startPromise as Promise<T>;
  }

  async ready(options?: RuntimeLifecycleOptions): Promise<RuntimeLifecycleSnapshot> {
    if (this.currentState === "ready" || this.currentState === "degraded") {
      return this.state();
    }
    if (this.currentState === "starting" && this.startPromise) {
      const timeoutMs = normalizeRuntimeLifecycleOptions({ ...this.defaults, ...options }).startupTimeoutMs;
      await timeoutAfter(this.startPromise, timeoutMs, "Runtime readiness timed out", "ready");
      return this.state();
    }
    if (this.currentState === "failed") {
      throw new FentarisRuntimeError("Runtime failed before reaching readiness", {
        code: "FENTARIS_RUNTIME_NOT_READY",
        context: { state: this.currentState, failure: this.metadata.failure },
      });
    }

    throw invalidTransition(this.currentState, "ready");
  }

  async stop(operation: () => Promise<void>, options?: RuntimeLifecycleOptions): Promise<void> {
    if (this.currentState === "stopped") {
      return;
    }
    if (this.currentState === "stopping" && this.stopPromise) {
      return this.stopPromise;
    }

    if (this.currentState === "created") {
      await this.runStopOperation(operation, options);
      await this.transition("stopped");
      return;
    }

    await this.transition("stopping");
    const timeoutMs = normalizeRuntimeLifecycleOptions({ ...this.defaults, ...options }).shutdownTimeoutMs;
    this.stopPromise = timeoutAfter(operation(), timeoutMs, "Runtime shutdown timed out", "shutdown")
      .then(async () => {
        this.metadata.stoppedAt = new Date();
        await this.transition("stopped");
      })
      .catch(async (error) => {
        const normalized = normalizeRuntimeError(error, { context: { phase: "shutdown" } });
        this.metadata.failure = {
          name: normalized.name,
          code: normalized.code,
          message: normalized.message,
        };
        await this.transition("failed");
        throw normalized;
      })
      .finally(() => {
        this.stopPromise = undefined;
      });

    return this.stopPromise;
  }

  async markReady(): Promise<void> {
    if (this.currentState === "degraded") {
      this.metadata.failure = undefined;
      await this.transition("ready");
    }
  }

  async markDegraded(reason: string): Promise<void> {
    if (this.currentState === "ready" || this.currentState === "degraded") {
      this.metadata.failure = { name: "RuntimeDegraded", message: reason };
      await this.transition("degraded");
    }
  }

  private async runStopOperation(operation: () => Promise<void>, options?: RuntimeLifecycleOptions): Promise<void> {
    const timeoutMs = normalizeRuntimeLifecycleOptions({ ...this.defaults, ...options }).shutdownTimeoutMs;
    try {
      await timeoutAfter(operation(), timeoutMs, "Runtime shutdown timed out", "shutdown");
      this.metadata.stoppedAt = new Date();
    } catch (error) {
      const normalized = normalizeRuntimeError(error, { context: { phase: "shutdown" } });
      this.metadata.failure = {
        name: normalized.name,
        code: normalized.code,
        message: normalized.message,
      };
      await this.transition("failed");
      throw normalized;
    }
  }

  private async transition(to: RuntimeLifecycleState): Promise<void> {
    if (this.currentState === to) {
      return;
    }

    // This controller is the only place that mutates lifecycle state; callers provide work, not states.
    const from = this.currentState;
    if (!canTransition(from, to)) {
      throw invalidTransition(from, to);
    }
    const at = new Date();
    this.currentState = to;
    this.metadata.lastTransitionAt = at;
    await this.onTransition?.({ from, to, at });
  }
}

export function normalizeRuntimeLifecycleOptions(options: RuntimeLifecycleOptions = {}): NormalizedRuntimeLifecycleOptions {
  return {
    startupTimeoutMs: normalizeTimeout(options.startupTimeoutMs, 30_000),
    shutdownTimeoutMs: normalizeTimeout(options.shutdownTimeoutMs, 30_000),
  };
}

export function timeoutAfter<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  phase: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new FentarisTimeoutError(`${message} after ${timeoutMs}ms`, {
        context: { phase, timeoutMs },
      }));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new FentarisRuntimeError("Lifecycle timeout must be a non-negative finite number", {
      code: "FENTARIS_RUNTIME_INVALID_TIMEOUT",
      context: { timeoutMs: value },
    });
  }
  return value;
}

function canTransition(from: RuntimeLifecycleState, to: RuntimeLifecycleState): boolean {
  if (from === to) {
    return true;
  }

  const allowed: Record<RuntimeLifecycleState, RuntimeLifecycleState[]> = {
    created: ["starting", "stopped"],
    starting: ["ready", "failed", "stopping"],
    ready: ["degraded", "stopping", "failed"],
    degraded: ["ready", "stopping", "failed"],
    stopping: ["stopped", "failed"],
    stopped: ["starting"],
    failed: ["starting", "stopping"],
  };

  return allowed[from].includes(to);
}

function invalidTransition(from: RuntimeLifecycleState, to: RuntimeLifecycleState): FentarisRuntimeError {
  return new FentarisRuntimeError(`Invalid runtime lifecycle transition from ${from} to ${to}`, {
    code: "FENTARIS_RUNTIME_INVALID_TRANSITION",
    context: { from, to },
  });
}
