import { ClientError, EXIT_CODES, type NextAction } from "./errors.js";
import type { Runtime } from "./runtime.js";

export type Pagination = { limit: number; cursor: string | null; nextCursor: string | null; total: number };

export type CommandResult = {
  data: unknown;
  /** Human rendering; omitted when the command already wrote its output. */
  human?: () => string;
  pagination?: Pagination | null;
  warnings?: string[];
  nextActions?: NextAction[];
  exitCode?: number;
  /** Raw or binary output was already written to stdout. */
  written?: boolean;
};

export function writeResult(runtime: Runtime, result: CommandResult, json: boolean): number {
  const warnings = result.warnings ?? [];
  const nextActions = result.nextActions ?? [];
  if (json) {
    runtime.write(`${JSON.stringify({ ok: true, data: result.data, pagination: result.pagination ?? null, warnings, nextActions })}\n`);
    return result.exitCode ?? 0;
  }
  for (const warning of warnings) runtime.error(`warning: ${warning}\n`);
  if (!result.written && result.human) {
    const text = result.human();
    if (text) runtime.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  if (nextActions.length && runtime.stdoutIsTTY) {
    runtime.error(`\nNext:\n${nextActions.map((action) => `  ${action.command}  # ${action.description}`).join("\n")}\n`);
  }
  return result.exitCode ?? 0;
}

export function writeError(runtime: Runtime, error: ClientError, json: boolean, warnings: string[] = []): number {
  if (json) {
    runtime.write(`${JSON.stringify({ ok: false, error: { code: error.code, message: error.message, details: publicDetails(error.details) }, warnings, nextActions: error.nextActions })}\n`);
    return EXIT_CODES[error.code];
  }
  for (const warning of warnings) runtime.error(`warning: ${warning}\n`);
  const output = error.details.output;
  if (typeof output === "string" && output) runtime.write(output.endsWith("\n") ? output : `${output}\n`);
  runtime.error(`error: ${error.message} [${error.code}]\n`);
  for (const action of error.nextActions) runtime.error(`  next: ${action.command}  # ${action.description}\n`);
  return EXIT_CODES[error.code];
}

/** `output` is a human-mode rendering helper, not part of the JSON contract. */
function publicDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).filter(([key]) => key !== "output"));
}

export function table(rows: string[][], headers: string[]): string {
  const widths = headers.map((header, index) => Math.min(48, Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length))));
  const line = (cells: string[]) => cells.map((cell, index) => index === cells.length - 1 ? cell : truncate(cell, widths[index]!).padEnd(widths[index]!)).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

export function truncate(value: string, length: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > length ? `${single.slice(0, Math.max(0, length - 1))}…` : single;
}
