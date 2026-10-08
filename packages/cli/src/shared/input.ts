import { redactOAuthMessage, VaultWriteVerificationError } from "@fentaris/core";
import type { CliOptions, Runtime } from "./types.js";

/** Shared missing-input/result contract for auth, secrets and the #297 MCP workflow. */
export class CommandInputError extends Error {
  readonly code = "MISSING_INPUT";
  constructor(readonly missingFields: string[], readonly nextActions: string[]) {
    super(`Missing required fields: ${missingFields.join(", ")}. Next: ${nextActions.join("; ")}`);
  }
}
export function canPrompt(runtime: Runtime, options: CliOptions = {}): boolean {
  return runtime.nonInteractive !== true && options["non-interactive"] !== true && options.json !== true;
}
export async function completeInput(runtime: Runtime, options: CliOptions, fields: Array<{ name: string; value: unknown; label: string; secret?: boolean }>, next: string): Promise<Record<string, string>> {
  const missing = fields.filter((field) => field.value === undefined || field.value === true).map((field) => field.name);
  if (missing.length && !canPrompt(runtime, options)) throw new CommandInputError(missing, [next]);
  const result: Record<string, string> = {};
  for (const field of fields) {
    const explicit = typeof field.value === "string";
    const value = explicit ? field.value as string : await runtime.prompt.text(field.label, { secret: field.secret });
    if (!value.trim()) throw new Error(`${field.label} must not be empty.`);
    result[field.name] = field.secret ? value : value.trim();
  }
  return result;
}
export async function chooseAction(runtime: Runtime, options: CliOptions, actions: string[], next: string): Promise<string> {
  if (!canPrompt(runtime, options)) throw new CommandInputError(["action"], [next]);
  return runtime.prompt.select("Action", actions);
}
export function commandResult(runtime: Runtime, options: CliOptions, data: unknown, human: string[], ok = true): void {
  if (options.json === true) runtime.out.log(JSON.stringify({ ok, data }));
  else human.forEach((line) => runtime.out.log(line));
}
export function commandError(runtime: Runtime, json: boolean, error: unknown): void {
  const message = sanitizeCommandMessage(error instanceof Error ? error.message : "Command failed.");
  if (json) runtime.out.log(JSON.stringify({ ok: false, error: { code: error instanceof CommandInputError ? error.code : "COMMAND_FAILED", message, ...(error instanceof VaultWriteVerificationError ? { stored: true, verified: false } : {}), ...(error instanceof CommandInputError ? { missingFields: error.missingFields, nextActions: error.nextActions } : {}) } }));
  else runtime.out.error(`error: ${message}`);
}
export function sanitizeCommandMessage(message: string): string {
  return redactOAuthMessage(message)
    .replace(/\b(authorization|proxy-authorization|x-api-key|api[_-]?key|token|password|secret)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]");
}
