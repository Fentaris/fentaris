import { describe, expect, it } from "vitest";
import { Logger, JsonConsoleLoggerDriver, jsonConsoleLogger, type LogEntry, type LoggerDriver } from "../../src/logging/index.js";

class MemoryDriver implements LoggerDriver {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

describe("Logger redaction", () => {
  it("redacts sensitive context, annotations, metadata, arrays, and configured paths before writing", async () => {
    const driver = new MemoryDriver();
    const seen: LogEntry[] = [];
    const logger = new Logger({
      driver,
      context: { userId: "alice", authorization: "Bearer secret" },
      redact: { paths: ["nested.visible"] },
      onWrite: (entry) => seen.push(entry),
    });

    logger
      .child({ apiKey: "child-key" })
      .annotate("credential", "stored-token")
      .info("message", {
        password: "pw",
        nested: { visible: "hide-me", safe: "ok" },
        values: [{ token: "array-token" }],
      });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(driver.entries).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(driver.entries[0]?.context).toMatchObject({
      userId: "alice",
      authorization: "[REDACTED]",
      apiKey: "[REDACTED]",
    });
    expect(driver.entries[0]?.metadata).toMatchObject({
      credential: "[REDACTED]",
      password: "[REDACTED]",
      nested: { visible: "[REDACTED]", safe: "ok" },
      values: [{ token: "[REDACTED]" }],
    });
    expect(seen[0]).toEqual(driver.entries[0]);
  });

  it("can disable redaction for local debugging", () => {
    const driver = new MemoryDriver();
    const logger = new Logger({ driver, redact: false });

    logger.info("message", { token: "raw-token" });

    expect(driver.entries[0]?.metadata.token).toBe("raw-token");
  });

  it("redacts token-like values under generic fields and honors custom overrides", async () => {
    const driver = new MemoryDriver();
    const logger = new Logger({
      driver,
      redact: {
        redact: (value, path) => path.join(".") === "input.keep" ? value : undefined,
      },
    });

    logger.info("message", {
      input: {
        bearer: "Bearer abcdefghijklmnopqrstuvwxyz123456",
        paddedBearer: "Bearer abcdefghijklmnopqrstuvwxyz123456==",
        slashBearer: "Bearer abcdefghijklmnopqrstuvwxyz123456/",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.Gh5wqNQUs7Zk7q7g2Xf2aH9b0d1c2e3f4g5h6i",
        github: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        keep: "Bearer abcdefghijklmnopqrstuvwxyz123456",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(driver.entries[0]?.metadata.input).toMatchObject({
      bearer: "[REDACTED]",
      paddedBearer: "[REDACTED]",
      slashBearer: "[REDACTED]",
      jwt: "[REDACTED]",
      github: "[REDACTED]",
      keep: "Bearer abcdefghijklmnopqrstuvwxyz123456",
    });
  });

  it("writes structured JSON lines to stdout-compatible sinks", async () => {
    const lines: string[] = [];
    const logger = jsonConsoleLogger({
      context: { service: "proxy" },
      writeLine: (line) => lines.push(line),
    });

    logger.info("tool.success", { tool: "search", token: "raw-token" });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const payload = JSON.parse(lines[0] ?? "{}") as LogEntry;
    expect(payload).toMatchObject({
      level: "info",
      message: "tool.success",
      context: { service: "proxy" },
      metadata: { tool: "search", token: "[REDACTED]" },
    });
    expect(typeof payload.timestamp).toBe("string");
  });

  it("allows the JSON console driver to be composed manually", () => {
    const lines: string[] = [];
    const driver = new JsonConsoleLoggerDriver({ writeLine: (line) => lines.push(line) });
    const timestamp = new Date("2026-06-25T00:00:00.000Z");

    driver.write({
      level: "debug",
      message: "ready",
      timestamp,
      context: { requestId: "req-1" },
      metadata: { server: "github" },
    });

    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      level: "debug",
      message: "ready",
      timestamp: "2026-06-25T00:00:00.000Z",
      context: { requestId: "req-1" },
      metadata: { server: "github" },
    });
  });
});
