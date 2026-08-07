import { readFile } from "node:fs/promises";
import type { SecretsManifestApiKey, SecretsManifestEntry, SecretsManifestSource } from "@fentaris/core";

const credentialPattern = /\bcredential\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gu;
const sourceEntryPattern = /(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:\s*(credential|credentialJson|credentialEnv)\s*\(\s*["']([^"']+)["']([^)]*)\)/gu;
const sourceCallPattern = /\b(credentialJson|credentialEnv)\s*\(\s*["']([^"']+)["']([^)]*)\)/gu;

export type ManifestScanDiagnostic = {
  code: "UNSUPPORTED_CREDENTIAL_SOURCE";
  detail: string;
};

export type ManifestScanResult = {
  references: SecretsManifestEntry[];
  envVars: string[];
  apiKeys: SecretsManifestApiKey[];
  diagnostics: ManifestScanDiagnostic[];
};

/** Scan a TypeScript entrypoint for credential requirements. */
export async function scanEntrypointForSecrets(entrypointPath: string): Promise<ManifestScanResult> {
  return scanSourceForSecrets(await readFile(entrypointPath, "utf8"));
}

/** Scan supported declarative TypeScript shapes for credential requirements. */
export function scanSourceForSecrets(source: string): ManifestScanResult {
  const references = new Map<string, SecretsManifestEntry>();
  const apiKeys = new Map<string, SecretsManifestApiKey>();
  const envVars = new Set<string>();
  const diagnostics: ManifestScanDiagnostic[] = [];
  const declarationSpans: Array<{ start: number; end: number }> = [];

  for (const subject of [...scanSubjectBlocks(source, "group"), ...scanSubjectBlocks(source, "user")]) {
    const credentials = extractObjectProperty(subject.objectSource, "credentials");
    if (credentials) {
      const absoluteStart = subject.objectStart + credentials.start;
      declarationSpans.push({ start: absoluteStart, end: subject.objectStart + credentials.end });
      addCredentialEntries(credentials.source, subject.scope, references, envVars, diagnostics);
    }

    if (subject.kind === "user") {
      const declaredApiKeys = extractArrayProperty(subject.objectSource, "apiKeys");
      if (declaredApiKeys) {
        declarationSpans.push({
          start: subject.objectStart + declaredApiKeys.start,
          end: subject.objectStart + declaredApiKeys.end,
        });
        addApiKeyEntries(declaredApiKeys.source, subject.id, apiKeys, envVars, diagnostics);
      }
    }
  }

  for (const credentials of findObjectProperties(source, "credentials")) {
    if (isInsideSpan(credentials.start, declarationSpans)) continue;
    declarationSpans.push({ start: credentials.start, end: credentials.end });
    addCredentialEntries(credentials.source, "default", references, envVars, diagnostics);
  }

  credentialPattern.lastIndex = 0;
  for (const match of source.matchAll(credentialPattern)) {
    if (isInsideSpan(match.index ?? 0, declarationSpans)) continue;
    const ref = match[1]?.trim();
    if (!ref || [...references.values()].some((entry) => entry.ref === ref)) continue;
    references.set(`default:${ref}`, { ref, scope: "default", source: { type: "local" } });
  }

  return {
    references: [...references.values()].sort(compareReferences),
    envVars: [...envVars].sort(),
    apiKeys: [...apiKeys.values()].sort(compareApiKeys),
    diagnostics,
  };
}

function addCredentialEntries(
  objectSource: string,
  scope: string,
  references: Map<string, SecretsManifestEntry>,
  envVars: Set<string>,
  diagnostics: ManifestScanDiagnostic[],
): void {
  sourceEntryPattern.lastIndex = 0;
  for (const match of objectSource.matchAll(sourceEntryPattern)) {
    const ref = (match[1] ?? match[2])?.trim();
    const helper = match[3];
    const locator = match[4]?.trim();
    const trailing = match[5]?.trim() ?? "";
    if (!ref || !locator || !helper) continue;

    let source: SecretsManifestSource;
    if (helper === "credential") {
      source = { type: "local" };
    } else if (helper === "credentialEnv") {
      source = { type: "env", name: locator };
      envVars.add(locator);
    } else {
      source = localSource(scope, ref, locator, trailing, diagnostics);
    }
    references.set(`${scope}:${ref}`, { ref, scope, source });
  }
}

function addApiKeyEntries(
  arraySource: string,
  userId: string,
  apiKeys: Map<string, SecretsManifestApiKey>,
  envVars: Set<string>,
  diagnostics: ManifestScanDiagnostic[],
): void {
  const localSlots: number[] = [];
  sourceCallPattern.lastIndex = 0;
  for (const match of arraySource.matchAll(sourceCallPattern)) {
    const helper = match[1];
    const locator = match[2]?.trim();
    const trailing = match[3]?.trim() ?? "";
    if (!helper || !locator) continue;

    if (helper === "credentialEnv") {
      envVars.add(locator);
      apiKeys.set(`${userId}:env:${locator}`, { userId, source: { type: "env", name: locator } });
      continue;
    }

    const expectedPrefix = `users.${userId}.apiKeys.`;
    const slot = locator.startsWith(expectedPrefix) ? Number(locator.slice(expectedPrefix.length)) : Number.NaN;
    if (!Number.isSafeInteger(slot) || slot < 0 || hasUnsupportedLocalFileOption(trailing)) {
      const reason = `API key for user ${userId} uses unsupported local source ${locator}`;
      diagnostics.push({ code: "UNSUPPORTED_CREDENTIAL_SOURCE", detail: reason });
      apiKeys.set(`${userId}:manual:${locator}`, { userId, source: { type: "manual", reason } });
      continue;
    }
    localSlots.push(slot);
  }

  if (localSlots.length > 0) {
    apiKeys.set(`${userId}:local`, {
      userId,
      source: { type: "local" },
      count: Math.max(...localSlots) + 1,
    });
  }
}

function localSource(
  scope: string,
  ref: string,
  path: string,
  trailing: string,
  diagnostics: ManifestScanDiagnostic[],
): SecretsManifestSource {
  const expected = scope === "default"
    ? `defaults.${ref}`
    : scope.startsWith("group:")
      ? `groups.${scope.slice("group:".length)}.${ref}`
      : `users.${scope.slice("user:".length)}.credentials.${ref}`;
  // Standard local paths remain provisionable even with key/keyEnv options.
  // Only a custom `file` option (or a non-standard path) requires manual setup.
  if (path === expected && !hasUnsupportedLocalFileOption(trailing)) return { type: "local" };

  const reason = `Credential ${scope}:${ref} uses unsupported local source ${path}`;
  diagnostics.push({ code: "UNSUPPORTED_CREDENTIAL_SOURCE", detail: reason });
  return { type: "manual", reason };
}

const defaultCredentialFiles = new Set([
  ".fentaris/credentials.enc.json",
  ".fentaris/auth/credentials.enc.json",
]);

function hasUnsupportedLocalFileOption(trailing: string): boolean {
  if (!trailing.startsWith(",")) return false;
  const fileMatch = /\bfile\s*:\s*["'`]([^"'`]+)["'`]/u.exec(trailing);
  if (!fileMatch?.[1]) return false;
  return !defaultCredentialFiles.has(fileMatch[1].trim());
}

function scanSubjectBlocks(source: string, kind: "group" | "user"): Array<{
  kind: "group" | "user";
  id: string;
  scope: string;
  objectSource: string;
  objectStart: number;
}> {
  const results: Array<{ kind: "group" | "user"; id: string; scope: string; objectSource: string; objectStart: number }> = [];
  const pattern = new RegExp(`\\b${kind}\\s*\\(`, "gu");
  for (const match of source.matchAll(pattern)) {
    const callStart = source.indexOf("(", match.index ?? 0);
    const callEnd = findMatchingDelimiter(source, callStart, "(", ")");
    if (callStart === -1 || callEnd === -1) continue;
    const callSource = source.slice(callStart + 1, callEnd);
    const object: { source: string; start: number; end: number; id?: string } | null = kind === "user"
      ? extractUserObjectArgument(callSource)
      : extractObjectArgument(callSource);
    if (!object) continue;
    const id = object.id ?? /\bid\s*:\s*["']([^"']+)["']/u.exec(object.source)?.[1]?.trim();
    if (!id) continue;
    results.push({
      kind,
      id,
      scope: `${kind}:${id}`,
      objectSource: object.source,
      objectStart: callStart + 1 + object.start,
    });
  }
  return results;
}

function extractUserObjectArgument(source: string): { source: string; start: number; end: number; id?: string } | null {
  const direct = extractObjectArgument(source);
  if (direct) return direct;
  const idMatch = /^\s*["']([^"']+)["']\s*,/u.exec(source);
  if (!idMatch?.[1]) return null;
  const start = source.indexOf("{", idMatch[0].length);
  const end = findMatchingBrace(source, start);
  return start === -1 || end === -1 ? null : { source: source.slice(start, end + 1), start, end, id: idMatch[1].trim() };
}

function extractObjectArgument(source: string): { source: string; start: number; end: number } | null {
  const start = source.search(/\S/u);
  if (start === -1 || source[start] !== "{") return null;
  const end = findMatchingBrace(source, start);
  return end === -1 ? null : { source: source.slice(start, end + 1), start, end };
}

function findObjectProperties(source: string, property: string): Array<{ source: string; start: number; end: number }> {
  const results: Array<{ source: string; start: number; end: number }> = [];
  const pattern = new RegExp(`\\b${property}\\s*:\\s*\\{`, "gu");
  for (const match of source.matchAll(pattern)) {
    const start = source.indexOf("{", match.index ?? 0);
    const end = findMatchingBrace(source, start);
    if (start !== -1 && end !== -1) results.push({ source: source.slice(start, end + 1), start, end });
  }
  return results;
}

function extractObjectProperty(source: string, property: string): { source: string; start: number; end: number } | null {
  return findObjectProperties(source, property)[0] ?? null;
}

function extractArrayProperty(source: string, property: string): { source: string; start: number; end: number } | null {
  const match = new RegExp(`\\b${property}\\s*:\\s*\\[`, "u").exec(source);
  if (!match) return null;
  const start = source.indexOf("[", match.index);
  const end = findMatchingDelimiter(source, start, "[", "]");
  return start === -1 || end === -1 ? null : { source: source.slice(start, end + 1), start, end };
}

function findMatchingBrace(source: string, start: number): number {
  return findMatchingDelimiter(source, start, "{", "}");
}

function findMatchingDelimiter(source: string, start: number, open: string, close: string): number {
  if (start === -1) return -1;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") quote = character;
    else if (character === open) depth += 1;
    else if (character === close && --depth === 0) return index;
  }
  return -1;
}

function isInsideSpan(index: number, spans: Array<{ start: number; end: number }>): boolean {
  return spans.some((span) => index >= span.start && index <= span.end);
}

function compareReferences(left: SecretsManifestEntry, right: SecretsManifestEntry): number {
  const scope = left.scope.localeCompare(right.scope);
  return scope !== 0 ? scope : left.ref.localeCompare(right.ref);
}

function compareApiKeys(left: SecretsManifestApiKey, right: SecretsManifestApiKey): number {
  const user = left.userId.localeCompare(right.userId);
  return user !== 0 ? user : JSON.stringify(left.source).localeCompare(JSON.stringify(right.source));
}
