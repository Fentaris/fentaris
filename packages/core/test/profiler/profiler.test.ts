import { describe, expect, it } from "vitest";
import {
  FentarisTimeoutError,
  Logger,
  RuntimeProfiler,
  functionProfilerSink,
  loggerProfilerSink,
  normalizeRuntimeProfiler,
  profiler,
  redactProfilerValue,
  renderRuntimeError,
  runtimeErrorToEventPayload,
  type LogEntry,
  type LoggerDriver,
  type RuntimeEvent,
} from "../../src/index.js";

class MemoryLoggerDriver implements LoggerDriver {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

describe("runtime profiler", () => {
  it("normalizes builder and object configs into equivalent dispatch settings", async () => {
    const events: RuntimeEvent[] = [];
    const built = normalizeRuntimeProfiler(
      profiler()
        .level("warn")
        .track("errors", "timeouts")
        .where({ server: "github" })
        .sink((event) => events.push(event)),
    );
    const object = normalizeRuntimeProfiler({
      level: "warn",
      track: ["errors", "timeouts"],
      where: { server: "github" },
      sink: (event) => events.push(event),
    });

    expect(built?.level).toBe(object?.level);
    expect([...built?.track ?? []]).toEqual([...object?.track ?? []]);
    expect(built?.filters).toEqual(object?.filters);

    await new RuntimeProfiler(built).emit({
      name: "runtime.error",
      category: "errors",
      level: "error",
      timestamp: new Date(),
      server: "github",
      error: runtimeErrorToEventPayload(new Error("boom")),
    });

    expect(events).toHaveLength(1);
  });

  it("filters by dimensions, levels, categories, and duration", async () => {
    const seen: RuntimeEvent[] = [];
    const runtime = new RuntimeProfiler(normalizeRuntimeProfiler({
      level: "info",
      track: ["mcp"],
      where: {
        server: "github",
        group: "engineering",
        user: "alice",
        operation: "tool:call",
        minDurationMs: 50,
      },
      sink: functionProfilerSink((event) => seen.push(event)),
    }));

    await runtime.emit({
      name: "mcp.call.success",
      category: "mcp",
      level: "info",
      timestamp: new Date(),
      server: "github",
      group: "engineering",
      user: "alice",
      operation: "tool:call",
      target: "create_issue",
      durationMs: 75,
    });
    await runtime.emit({
      name: "mcp.call.success",
      category: "mcp",
      level: "info",
      timestamp: new Date(),
      server: "github",
      group: "engineering",
      user: "alice",
      operation: "tool:call",
      target: "create_issue",
      durationMs: 10,
    });

    expect(seen).toHaveLength(1);
  });

  it("supports multiple sinks, logger sink compatibility, and isolated sink failures", async () => {
    const driver = new MemoryLoggerDriver();
    const logger = new Logger({ driver });
    const seen: string[] = [];
    const runtime = new RuntimeProfiler(normalizeRuntimeProfiler({
      sinks: [
        loggerProfilerSink({ logger }),
        () => seen.push("custom"),
        () => {
          throw new Error("sink down");
        },
      ],
      onSinkError: (error) => seen.push(error.code),
    }));

    await runtime.emit({
      name: "runtime.ready",
      category: "lifecycle",
      level: "info",
      timestamp: new Date(),
      runtime: "test",
      version: "0.0.0",
      startupMs: 3,
    });

    expect(driver.entries[0]?.message).toBe("runtime.ready");
    expect(seen).toEqual(["custom", "FENTARIS_EXTENSION_ERROR"]);
  });

  it("emits structured profiler sink error events after isolated sink failures", async () => {
    const seen: RuntimeEvent[] = [];
    const handled: RuntimeEvent[] = [];
    const runtime = new RuntimeProfiler(normalizeRuntimeProfiler({
      level: "debug",
      track: ["lifecycle", "profiler"],
      sinks: [
        {
          name: "broken",
          write() {
            throw new Error("sink down");
          },
        },
        (event) => seen.push(event),
      ],
      handlers: [
        {
          eventName: "profiler.sink.error",
          handler: (event) => handled.push(event),
        },
      ],
    }));

    await runtime.emit({
      name: "runtime.ready",
      category: "lifecycle",
      level: "info",
      timestamp: new Date(),
      runtime: "test",
      version: "0.0.0",
      startupMs: 3,
    });

    expect(seen.map((event) => event.name)).toEqual(["profiler.sink.error", "runtime.ready"]);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      name: "profiler.sink.error",
      category: "profiler",
      level: "error",
      sink: "broken",
      error: {
        code: "FENTARIS_EXTENSION_ERROR",
      },
      metadata: {
        sourceEvent: "runtime.ready",
      },
    });
  });

  it("redacts default and custom sensitive values before dispatch", async () => {
    const seen: RuntimeEvent[] = [];
    const runtime = new RuntimeProfiler(normalizeRuntimeProfiler({
      redact: {
        keys: ["private"],
        paths: ["metadata.nested.hide"],
        rules: [(value, path) => path.join(".") === "metadata.custom" ? "custom-redacted" : undefined],
      },
      sink: (event) => seen.push(event),
    }));

    await runtime.emit({
      name: "runtime.error",
      category: "errors",
      level: "error",
      timestamp: new Date(),
      metadata: {
        token: "secret-token",
        private: "private-value",
        nested: { hide: "hide-me" },
        custom: "custom-value",
      },
      error: runtimeErrorToEventPayload(new Error("boom")),
    });

    expect(seen[0]?.metadata).toMatchObject({
      token: "[REDACTED]",
      private: "[REDACTED]",
      nested: { hide: "[REDACTED]" },
      custom: "custom-redacted",
    });
  });

  it("normalizes timeout errors and renders pretty terminal output from structured data", () => {
    const error = new FentarisTimeoutError("tool timed out", {
      context: {
        server: "github",
        group: "engineering",
        operation: "tool:call",
        timeoutMs: 100,
        durationMs: 120,
      },
    });

    const payload = runtimeErrorToEventPayload(error);
    const rendered = renderRuntimeError(error);

    expect(payload).toMatchObject({
      code: "FENTARIS_TIMEOUT_ERROR",
      severity: "warn",
      context: {
        server: "github",
        group: "engineering",
        operation: "tool:call",
        timeoutMs: 100,
        durationMs: 120,
      },
    });
    expect(rendered).toContain("FENTARIS_TIMEOUT_ERROR");
    expect(rendered).toContain("timeoutMs=100");
  });

  it("exposes direct redaction for pre-rendered structured payloads", () => {
    const redacted = redactProfilerValue(
      { error: { context: { authorization: "Bearer token" } } },
      {
        enabled: true,
        replacement: "[X]",
        keys: [/authorization/i],
        paths: [],
        custom: [],
      },
    );

    expect(redacted.error.context.authorization).toBe("[X]");
  });
});
