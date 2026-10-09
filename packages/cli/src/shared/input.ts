import { redactOAuthMessage, VaultWriteVerificationError } from "@fentaris/core";
import type { CliOptions, Runtime } from "./types.js";

export class CommandInputError extends Error {
  readonly code = "MISSING_INPUT";
  readonly nextCommand: string;
  readonly nextActions: string[];
  constructor(readonly missingFields: string[], next: string | string[]) {
    const actions = typeof next === "string" ? [next] : next;
    super(`Missing required fields: ${missingFields.join(", ")}. Next command: ${actions.join("; ")}`);
    this.nextActions = actions;
    this.nextCommand = actions.join("; ");
  }
}

export function canPrompt(runtime: Runtime, options: CliOptions = {}): boolean {
  return runtime.nonInteractive !== true && options["non-interactive"] !== true && options.json !== true && runtime.interactive !== false;
}

export type InputField = {
  name: string;
  question?: string;
  label?: string;
  value?: unknown;
  required?: boolean;
  secret?: boolean;
  choices?: string[];
  validate?: (value: string) => void;
};

/** Preserve every supplied value and ask only for missing information. */
export async function completeInput(runtime: Runtime, options: CliOptions, fields: InputField[], nextCommand: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const missing: InputField[] = [];
  for (const field of fields) {
    const supplied = Object.hasOwn(field, "value") ? field.value : options[field.name];
    if (typeof supplied === "string") {
      if (!supplied.trim()) throw new Error(`Invalid empty value for --${field.name}.`);
      field.validate?.(supplied);
      if (field.choices && !field.choices.includes(supplied)) throw new Error(`Invalid ${field.name}. Expected one of: ${field.choices.join(", ")}.`);
      result[field.name] = supplied;
    } else if (field.required !== false || supplied === true) missing.push(field);
  }
  if (missing.length && !canPrompt(runtime, options)) throw new CommandInputError(missing.map((field) => field.name), nextWithSuppliedOptions(nextCommand, options, fields));
  for (const field of missing) {
    const value = field.choices ? await runtime.prompt.select(field.question ?? field.label ?? field.name, field.choices) : await runtime.prompt.text(field.question ?? field.label ?? field.name, { secret: field.secret });
    if (!value.trim()) throw new Error("Command cancelled before any changes were made.");
    field.validate?.(value);
    if (field.choices && !field.choices.includes(value)) throw new Error(`Invalid ${field.name}.`);
    result[field.name] = value;
  }
  return result;
}

export function commandValue(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function nextWithSuppliedOptions(command: string, options: CliOptions, fields: InputField[]): string {
  const privateFields = new Set(["key", "value", ...fields.filter((field) => field.secret).map((field) => field.name)]);
  for (const [name, value] of Object.entries(options)) {
    if (privateFields.has(name) || ["server", "tool", "action"].includes(name) || name.includes(":")) continue;
    const placeholder = new RegExp(`--${name} <[^>]+>`);
    if (typeof value === "string") {
      if (placeholder.test(command)) command = command.replace(placeholder, `--${name} ${commandValue(value)}`);
      else if (!command.includes(`--${name} `) && !command.endsWith(`--${name}`)) command += ` --${name} ${commandValue(value)}`;
    } else if (value === true && ["json", "non-interactive", "offline", "reauth", "print-url", "input", "output"].includes(name) && !command.includes(`--${name}`)) command += ` --${name}`;
  }
  if (typeof options.key === "string" && !command.includes("--key")) command += " --key <VAULT_UNLOCK_KEY>";
  return command;
}

export async function chooseAction(runtime: Runtime, options: CliOptions, actions: string[], nextCommand: string): Promise<string> {
  const result = await completeInput(runtime, options, [{ name: "action", question: "Action", choices: actions }], nextCommand);
  return result.action;
}

export function commandResult(runtime: Runtime, options: CliOptions, data: unknown, message: string | string[], ok = true): void {
  if (options.json === true) runtime.out.log(JSON.stringify({ version: 1, ok, data }));
  else for (const line of typeof message === "string" ? [message] : message) runtime.out.log(line);
}

export function commandError(runtime: Runtime, json: boolean, error: unknown, code = "COMMAND_FAILED"): void {
  const message = sanitizeCommandMessage(error instanceof Error ? error.message : "Command failed.");
  if (json) runtime.out.log(JSON.stringify({ version: 1, ok: false, error: { code: error instanceof CommandInputError ? error.code : code, message, ...(error instanceof VaultWriteVerificationError ? { stored: true, verified: false } : {}), ...(error instanceof CommandInputError ? { missingFields: error.missingFields, nextActions: error.nextActions, nextCommand: error.nextCommand } : {}) } }));
  else runtime.out.error(`error: ${message}`);
}
export function sanitizeCommandMessage(message: string): string {
  return redactOAuthMessage(message)
    .replace(/\b(authorization|proxy-authorization|x-api-key|api[_-]?key|token|password|secret)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]");
}
