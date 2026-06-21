/**
 * Logging primitives for the core runtime.
 * @pk
 */

/**
 * Supported log levels.
 * @pk
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Structured log entry payload.
 * @pk
 */
export type LogEntry = {
  level: LogLevel;
  message: string;
  timestamp: Date;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

/**
 * Low-level logger driver interface.
 * @pk
 */
export type LoggerDriver = {
  write(entry: LogEntry): void | Promise<void>;
};

/**
 * Logger configuration options.
 * @pk
 */
export type LoggerOptions = {
  level?: LogLevel;
  driver?: LoggerDriver;
  context?: Record<string, unknown>;
  onWrite?: (entry: LogEntry) => void | Promise<void>;
  redact?: boolean | LoggerRedactionOptions;
};

/**
 * Logger redaction configuration.
 * @pk
 */
export type LoggerRedactionOptions = {
  enabled?: boolean;
  replacement?: string;
  keys?: Array<string | RegExp>;
  paths?: string[];
  redact?: (value: unknown, path: string[], key?: string) => unknown;
};

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const defaultSensitiveKeys = [/token/i, /secret/i, /password/i, /authorization/i, /api[-_]?key/i, /credential/i];
const defaultSensitiveValuePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bgh[opsur]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
];
const defaultReplacement = "[REDACTED]";

/**
 * Console-based logger driver.
 * @pk
 */
export class ConsoleLoggerDriver implements LoggerDriver {
  /**
   * Write the log entry to the console.
   * @pk
   */
  write(entry: LogEntry): void {
    const payload = {
      ...entry.context,
      ...entry.metadata,
    };
    const method = entry.level === "debug" ? "debug" : entry.level === "info" ? "info" : entry.level === "warn" ? "warn" : "error";
    console[method](`[fentaris:${entry.level}] ${entry.message}`, payload);
  }
}

/**
 * Minimal Redis-compatible logger client contract.
 * @pk
 */
export type RedisLoggerClient = {
  rpush(key: string, value: string): void | Promise<unknown>;
};

/**
 * Redis logger driver options.
 * @pk
 */
export type RedisLoggerDriverOptions = {
  client: RedisLoggerClient;
  key?: string;
};

/**
 * Redis-backed logger driver that appends JSON log entries to a list.
 * @pk
 */
export class RedisLoggerDriver implements LoggerDriver {
  private readonly client: RedisLoggerClient;
  private readonly key: string;

  /**
   * Create a Redis logger driver.
   * @pk
   */
  constructor(options: RedisLoggerDriverOptions) {
    this.client = options.client;
    this.key = options.key ?? "fentaris:logs";
  }

  async write(entry: LogEntry): Promise<void> {
    await this.client.rpush(this.key, JSON.stringify(entry));
  }
}

/**
 * Structured logger with level filtering.
 * @pk
 */
export class Logger {
  private readonly level: LogLevel;
  private readonly driver: LoggerDriver;
  private readonly context: Record<string, unknown>;
  private readonly annotations: Record<string, unknown>;
  private readonly onWrite?: (entry: LogEntry) => void | Promise<void>;
  private readonly redaction: Required<Pick<LoggerRedactionOptions, "enabled" | "replacement">> &
    Pick<LoggerRedactionOptions, "keys" | "paths" | "redact">;

  /**
   * Create a new logger instance.
   * @pk
   */
  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.driver = options.driver ?? new ConsoleLoggerDriver();
    this.context = options.context ?? {};
    this.annotations = {};
    this.onWrite = options.onWrite;
    this.redaction = normalizeRedaction(options.redact);
  }

  /**
   * Create a child logger with merged context.
   * @pk
   */
  child(context: Record<string, unknown>): Logger {
    const child = new Logger({
      level: this.level,
      driver: this.driver,
      context: {
        ...this.context,
        ...context,
      },
      onWrite: this.onWrite,
      redact: this.redaction,
    });
    Object.assign(child.annotations, this.annotations);
    return child;
  }

  /**
   * Add mutable metadata that will be included in future log writes.
   * @pk
   */
  annotate(key: string, value: unknown): this {
    this.annotations[key] = value;
    return this;
  }

  /**
   * Add a tag to future log writes.
   * @pk
   */
  setTag(key: string, value: unknown): this {
    this.annotations[`tag.${key}`] = value;
    return this;
  }

  /**
   * Emit a debug log entry.
   * @pk
   */
  debug(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("debug", message, metadata);
  }

  /**
   * Emit an info log entry.
   * @pk
   */
  info(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("info", message, metadata);
  }

  /**
   * Emit a warning log entry.
   * @pk
   */
  warn(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("warn", message, metadata);
  }

  /**
   * Emit an error log entry.
   * @pk
   */
  error(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("error", message, metadata);
  }

  /**
   * Emit a fatal log entry.
   * @pk
   */
  fatal(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("fatal", message, metadata);
  }

  /**
   * Write a log entry if the level is enabled.
   * @pk
   */
  private async write(level: LogLevel, message: string, metadata: Record<string, unknown>): Promise<void> {
    if (levelWeight[level] < levelWeight[this.level]) {
      return;
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      context: redactRecord(this.context, this.redaction),
      metadata: redactRecord({
        ...this.annotations,
        ...metadata,
      }, this.redaction),
    };

    await this.driver.write(entry);
    await this.onWrite?.(entry);
  }
}

function normalizeRedaction(
  options: LoggerOptions["redact"],
): Required<Pick<LoggerRedactionOptions, "enabled" | "replacement">> & Pick<LoggerRedactionOptions, "keys" | "paths" | "redact"> {
  if (options === false) {
    return { enabled: false, replacement: defaultReplacement };
  }

  if (options === true || options === undefined) {
    return { enabled: true, replacement: defaultReplacement, keys: defaultSensitiveKeys };
  }

  return {
    enabled: options.enabled ?? true,
    replacement: options.replacement ?? defaultReplacement,
    keys: options.keys ?? defaultSensitiveKeys,
    paths: options.paths,
    redact: options.redact,
  };
}

function redactRecord(
  value: Record<string, unknown>,
  options: Required<Pick<LoggerRedactionOptions, "enabled" | "replacement">> & Pick<LoggerRedactionOptions, "keys" | "paths" | "redact">,
): Record<string, unknown> {
  if (!options.enabled) {
    return value;
  }

  return redactValue(value, options, [], new WeakSet()) as Record<string, unknown>;
}

function redactValue(
  value: unknown,
  options: Required<Pick<LoggerRedactionOptions, "enabled" | "replacement">> & Pick<LoggerRedactionOptions, "keys" | "paths" | "redact">,
  path: string[],
  seen: WeakSet<object>,
): unknown {
  const key = path.at(-1);
  const custom = options.redact?.(value, path, key);
  if (custom !== undefined) {
    return custom;
  }

  if ((key && shouldRedactKey(key, options.keys)) || shouldRedactPath(path, options.paths)) {
    return options.replacement;
  }

  if (typeof value === "string" && shouldRedactValue(value)) {
    return options.replacement;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, options, [...path, String(index)], seen));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([nestedKey, nestedValue]) => [
      nestedKey,
      redactValue(nestedValue, options, [...path, nestedKey], seen),
    ]),
  );
}

function shouldRedactKey(key: string, keys: Array<string | RegExp> | undefined): boolean {
  return (keys ?? defaultSensitiveKeys).some((pattern) => (typeof pattern === "string" ? pattern === key : pattern.test(key)));
}

function shouldRedactPath(path: string[], paths: string[] | undefined): boolean {
  const dotted = path.join(".");
  return Boolean(paths?.some((pattern) => pattern === dotted));
}

function shouldRedactValue(value: string): boolean {
  return defaultSensitiveValuePatterns.some((pattern) => pattern.test(value));
}
