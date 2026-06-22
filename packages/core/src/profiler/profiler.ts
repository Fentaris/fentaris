import type { Logger } from "../logging/index.js";
import {
  FentarisExtensionError,
  normalizeRuntimeError,
  toRuntimeErrorPayload,
} from "./errors.js";
import type {
  LoggerSinkOptions,
  ProfilerFilter,
  ProfilerFunctionSink,
  ProfilerHandlerOptions,
  ProfilerPrettySinkOptions,
  ProfilerSink,
  ProfilerSinkLike,
  ProfilerTrack,
  RuntimeEvent,
  RuntimeEventCategory,
  RuntimeEventHandler,
  RuntimeEventLevel,
  RuntimeEventName,
} from "./events.js";
import {
  normalizeProfilerRedaction,
  redactProfilerValue,
  type NormalizedProfilerRedaction,
  type ProfilerRedactionOptions,
} from "./redaction.js";

export type ProfilerFailureMode = "isolate" | "strict";

export type ProfilerObjectConfig = {
  preset?: "pretty" | "silent" | "json";
  level?: RuntimeEventLevel;
  track?: ProfilerTrack[];
  where?: ProfilerFilter;
  sinks?: ProfilerSinkLike[];
  sink?: ProfilerSinkLike;
  handlers?: RuntimeProfilerHandlerEntry[];
  redact?: boolean | ProfilerRedactionOptions;
  onSinkError?: (error: FentarisExtensionError, event: RuntimeEvent) => void | Promise<void>;
  failureMode?: ProfilerFailureMode;
};

export type RuntimeProfilerConfig = ProfilerBuilder | ProfilerObjectConfig | false | undefined;

export type RuntimeProfilerHandlerEntry<N extends RuntimeEventName = RuntimeEventName> = {
  eventName?: N;
  where?: ProfilerFilter;
  handler: RuntimeEventHandler<N>;
};

export type NormalizedRuntimeProfiler = {
  level: RuntimeEventLevel;
  track: Set<ProfilerTrack>;
  filters: ProfilerFilter[];
  sinks: ProfilerSink[];
  handlers: RuntimeProfilerHandlerEntry[];
  redaction: NormalizedProfilerRedaction;
  failureMode: ProfilerFailureMode;
  onSinkError?: (error: FentarisExtensionError, event: RuntimeEvent) => void | Promise<void>;
};

export class ProfilerBuilder {
  private readonly config: ProfilerObjectConfig = {};

  pretty(options: ProfilerPrettySinkOptions = {}): this {
    this.config.preset = "pretty";
    this.config.sinks = [...(this.config.sinks ?? []), prettyProfilerSink(options)];
    return this;
  }

  level(level: RuntimeEventLevel): this {
    this.config.level = level;
    return this;
  }

  track(...tracks: ProfilerTrack[]): this {
    this.config.track = tracks;
    return this;
  }

  where(filter: ProfilerFilter): this {
    this.config.where = mergeFilter(this.config.where, filter);
    return this;
  }

  on<N extends RuntimeEventName>(
    eventName: N,
    optionsOrHandler: ProfilerHandlerOptions | RuntimeEventHandler<N>,
    maybeHandler?: RuntimeEventHandler<N>,
  ): this {
    const options = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
    const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
    if (!handler) {
      throw new Error(`Missing handler for profiler event "${eventName}"`);
    }

    this.config.handlers = [
      ...(this.config.handlers ?? []),
      { eventName, where: options.where, handler: handler as RuntimeEventHandler },
    ];
    return this;
  }

  sink(sink: ProfilerSinkLike): this {
    this.config.sinks = [...(this.config.sinks ?? []), normalizeSink(sink)];
    return this;
  }

  strict(): this {
    this.config.failureMode = "strict";
    return this;
  }

  redaction(options: boolean | ProfilerRedactionOptions): this {
    this.config.redact = options;
    return this;
  }

  toConfig(): ProfilerObjectConfig {
    return {
      ...this.config,
      sinks: this.config.sinks ? [...this.config.sinks] : undefined,
      handlers: this.config.handlers ? [...this.config.handlers] : undefined,
    };
  }
}

export function profiler(): ProfilerBuilder {
  return new ProfilerBuilder();
}

export function normalizeRuntimeProfiler(config: RuntimeProfilerConfig, logger?: Logger): NormalizedRuntimeProfiler | null {
  if (config === false) {
    return null;
  }

  const objectConfig = config instanceof ProfilerBuilder ? config.toConfig() : config ?? {};
  const sinks = [
    ...(objectConfig.sinks ?? []).map(normalizeSink),
    ...(objectConfig.sink ? [normalizeSink(objectConfig.sink)] : []),
  ];

  if (objectConfig.preset === "pretty" && sinks.length === 0) {
    sinks.push(prettyProfilerSink());
  }

  if (objectConfig.preset === "json" && sinks.length === 0) {
    sinks.push(jsonProfilerSink());
  }

  if (logger && sinks.length === 0 && objectConfig.preset !== "silent") {
    sinks.push(loggerProfilerSink({ logger }));
  }

  return {
    level: objectConfig.level ?? "info",
    track: new Set(objectConfig.track ?? defaultTracks),
    filters: objectConfig.where ? [objectConfig.where] : [],
    sinks,
    handlers: objectConfig.handlers ?? [],
    redaction: normalizeProfilerRedaction(objectConfig.redact),
    failureMode: objectConfig.failureMode ?? "isolate",
    onSinkError: objectConfig.onSinkError,
  };
}

export class RuntimeProfiler {
  constructor(private readonly config: NormalizedRuntimeProfiler | null) {}

  async emit(event: RuntimeEvent): Promise<void> {
    if (!this.config || !matchesProfilerConfig(this.config, event)) {
      return;
    }

    const safeEvent = redactProfilerValue(event, this.config.redaction);
    for (const handler of this.config.handlers) {
      if (handler.eventName && handler.eventName !== safeEvent.name) {
        continue;
      }
      if (handler.where && !matchesFilter(handler.where, safeEvent)) {
        continue;
      }
      await handler.handler(safeEvent as never);
    }

    for (let index = 0; index < this.config.sinks.length; index += 1) {
      const sink = this.config.sinks[index]!;
      try {
        await sink.write(safeEvent);
      } catch (error) {
        const sinkError = new FentarisExtensionError("Profiler sink failed", {
          cause: error,
          context: {
            boundary: "sink",
            sink: sink.name,
            eventName: safeEvent.name,
          },
        });
        if (this.config.failureMode === "strict") {
          throw sinkError;
        }
        await this.config.onSinkError?.(sinkError, safeEvent);
        await this.emitSinkFailure(sink, sinkError, safeEvent, index);
      }
    }
  }

  private async emitSinkFailure(
    failedSink: ProfilerSink,
    error: FentarisExtensionError,
    sourceEvent: RuntimeEvent,
    failedSinkIndex: number,
  ): Promise<void> {
    if (!this.config) {
      return;
    }

    // Sink failure events are observability only: they report the isolated sink
    // error without recursively re-entering the sink that just failed.
    const failureEvent = redactProfilerValue(createRuntimeEvent({
      name: "profiler.sink.error",
      category: "profiler",
      level: "error",
      sink: failedSink.name,
      server: sourceEvent.server,
      group: sourceEvent.group,
      user: sourceEvent.user,
      operation: sourceEvent.operation ?? "profiler:sink",
      error: toRuntimeErrorPayload(error),
      metadata: { sourceEvent: sourceEvent.name },
      message: "Profiler sink failed",
    }), this.config.redaction);

    if (!matchesProfilerConfig(this.config, failureEvent)) {
      return;
    }

    for (const handler of this.config.handlers) {
      if (handler.eventName && handler.eventName !== failureEvent.name) {
        continue;
      }
      if (handler.where && !matchesFilter(handler.where, failureEvent)) {
        continue;
      }
      await handler.handler(failureEvent as never);
    }

    for (let sinkIndex = 0; sinkIndex < this.config.sinks.length; sinkIndex += 1) {
      if (sinkIndex === failedSinkIndex) {
        continue;
      }
      const sink = this.config.sinks[sinkIndex]!;
      try {
        await sink.write(failureEvent);
      } catch (notificationError) {
        await this.config.onSinkError?.(new FentarisExtensionError("Profiler sink failed while reporting sink failure", {
          cause: notificationError,
          context: {
            boundary: "sink",
            sink: sink.name,
            eventName: failureEvent.name,
          },
        }), failureEvent);
      }
    }
  }
}

export function createRuntimeEvent<N extends RuntimeEventName>(
  event: { name: N; timestamp?: Date } & Record<string, unknown>,
): RuntimeEvent<N> {
  return {
    ...event,
    timestamp: event.timestamp ?? new Date(),
  } as unknown as RuntimeEvent<N>;
}

export function functionProfilerSink(write: ProfilerFunctionSink, name = "function"): ProfilerSink {
  return { name, write };
}

export function loggerProfilerSink(options: LoggerSinkOptions): ProfilerSink {
  return {
    name: "logger",
    write(event) {
      const message = event.message ?? event.name;
      const metadata = { ...event, timestamp: event.timestamp.toISOString() };
      options.logger[event.level](message, metadata);
    },
  };
}

export function prettyProfilerSink(options: ProfilerPrettySinkOptions = {}): ProfilerSink {
  return {
    name: "pretty",
    write(event) {
      const writer = options.writer ?? console.error;
      const duration = event.durationMs === undefined ? "" : ` ${event.durationMs}ms`;
      writer(`[fentaris:${event.level}] ${event.name}${duration} ${event.message ?? ""}`.trim());
    },
  };
}

export function jsonProfilerSink(writer: (line: string) => void = console.error): ProfilerSink {
  return {
    name: "json",
    write(event) {
      writer(JSON.stringify(event));
    },
  };
}

export function runtimeErrorToEventPayload(error: unknown) {
  return toRuntimeErrorPayload(normalizeRuntimeError(error));
}

function normalizeSink(sink: ProfilerSinkLike): ProfilerSink {
  return typeof sink === "function" ? functionProfilerSink(sink) : sink;
}

function matchesProfilerConfig(config: NormalizedRuntimeProfiler, event: RuntimeEvent): boolean {
  if (!config.track.has(event.category)) {
    return false;
  }

  if (levelWeight[event.level] < levelWeight[config.level]) {
    return false;
  }

  return config.filters.every((filter) => matchesFilter(filter, event));
}

function matchesFilter(filter: ProfilerFilter, event: RuntimeEvent): boolean {
  return (
    matchesOne(filter.category, event.category) &&
    matchesOne(filter.server, event.server) &&
    matchesOne(filter.group, event.group) &&
    matchesOne(filter.user, event.user) &&
    matchesOne(filter.operation, event.operation) &&
    (filter.level === undefined || levelWeight[event.level] >= levelWeight[filter.level]) &&
    (filter.minDurationMs === undefined || (event.durationMs ?? 0) >= filter.minDurationMs)
  );
}

function matchesOne<T extends string>(expected: T | T[] | undefined, actual: T | string | undefined): boolean {
  if (expected === undefined) {
    return true;
  }
  return Array.isArray(expected) ? expected.includes(actual as T) : expected === actual;
}

function mergeFilter(left: ProfilerFilter | undefined, right: ProfilerFilter): ProfilerFilter {
  return { ...left, ...right };
}

const defaultTracks: RuntimeEventCategory[] = ["errors", "timeouts", "policy", "transport", "extension", "lifecycle", "profiler", "mcp"];

const levelWeight: Record<RuntimeEventLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};
