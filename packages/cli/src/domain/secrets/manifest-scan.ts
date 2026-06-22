import { readFile } from "node:fs/promises";

const credentialPattern = /\bcredential\s*\(\s*["']([^"']+)["']\s*\)/gu;
const credentialEnvPattern = /\bcredentialEnv\s*\(\s*["']([^"']+)["']\s*\)/gu;

export type ManifestScanResult = {
  references: Array<{ ref: string; scope: string }>;
  envVars: string[];
};

/**
 * Scan a TypeScript entrypoint for credential references.
 */
export async function scanEntrypointForSecrets(entrypointPath: string): Promise<ManifestScanResult> {
  const source = await readFile(entrypointPath, "utf8");
  return scanSourceForSecrets(source);
}

/**
 * Scan TypeScript source for credential references.
 */
export function scanSourceForSecrets(source: string): ManifestScanResult {
  const refs = new Map<string, string>();
  const envVars = new Set<string>();
  const scopedSpans: Array<{ start: number; end: number }> = [];

  for (const scoped of scanScopedCredentialBlocks(source, "group")) {
    scopedSpans.push({ start: scoped.start, end: scoped.end });
    for (const ref of scoped.refs) {
      refs.set(`${scoped.scope}:${ref}`, scoped.scope);
    }
    for (const envVar of scoped.envVars) {
      envVars.add(envVar);
    }
  }

  for (const scoped of scanScopedCredentialBlocks(source, "user")) {
    scopedSpans.push({ start: scoped.start, end: scoped.end });
    for (const ref of scoped.refs) {
      refs.set(`${scoped.scope}:${ref}`, scoped.scope);
    }
    for (const envVar of scoped.envVars) {
      envVars.add(envVar);
    }
  }

  for (const pattern of [credentialPattern, /credential\s*\(\s*`([^`]+)`\s*\)/gu]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (isInsideSpan(match.index ?? 0, scopedSpans)) {
        continue;
      }
      const ref = match[1]?.trim();
      if (ref) {
        refs.set(`default:${ref}`, "default");
      }
    }
  }

  credentialEnvPattern.lastIndex = 0;
  for (const match of source.matchAll(credentialEnvPattern)) {
    const envVar = match[1]?.trim();
    if (envVar) {
      envVars.add(envVar);
    }
  }

  return {
    references: [...refs.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, scope]) => ({ ref: key.slice(scope.length + 1), scope })),
    envVars: [...envVars].sort(),
  };
}

function scanScopedCredentialBlocks(source: string, helper: "group" | "user"): Array<{ start: number; end: number; scope: string; refs: string[]; envVars: string[] }> {
  const results: Array<{ start: number; end: number; scope: string; refs: string[]; envVars: string[] }> = [];
  const pattern = new RegExp(`\\b${helper}\\s*\\(`, "gu");
  for (const match of source.matchAll(pattern)) {
    const callStart = source.indexOf("(", match.index ?? 0);
    const callEnd = findMatchingDelimiter(source, callStart, "(", ")");
    if (callStart === -1 || callEnd === -1) {
      continue;
    }

    const callSource = source.slice(callStart + 1, callEnd);
    const scopedObject = helper === "user" ? extractUserObjectArgument(callSource) : extractObjectArgument(callSource);
    if (!scopedObject) {
      continue;
    }
    const objectStart = callStart + 1 + scopedObject.start;
    const objectSource = scopedObject.source;
    const id = scopedObject.id ?? /\bid\s*:\s*["']([^"']+)["']/u.exec(objectSource)?.[1]?.trim();
    if (!id) {
      continue;
    }

    const credentials = extractObjectProperty(objectSource, "credentials");
    if (!credentials) {
      continue;
    }
    const refs = refsFromCredentialsObject(credentials.source);
    results.push({
      start: objectStart + credentials.start,
      end: objectStart + credentials.end,
      scope: `${helper}:${id}`,
      refs: refs.refs,
      envVars: refs.envVars,
    });
  }
  return results;
}

function extractUserObjectArgument(source: string): { source: string; start: number; end: number; id?: string } | null {
  const objectArgument = extractObjectArgument(source);
  if (objectArgument) {
    return objectArgument;
  }

  const idMatch = /^\s*["']([^"']+)["']\s*,/u.exec(source);
  if (!idMatch) {
    return null;
  }

  const id = idMatch[1]?.trim();
  if (!id) {
    return null;
  }

  const objectArgumentStart = source.indexOf("{", idMatch[0].length);
  const objectArgumentEnd = findMatchingBrace(source, objectArgumentStart);
  if (objectArgumentStart === -1 || objectArgumentEnd === -1) {
    return null;
  }

  return {
    source: source.slice(objectArgumentStart, objectArgumentEnd + 1),
    start: objectArgumentStart,
    end: objectArgumentEnd,
    id,
  };
}

function extractObjectArgument(source: string): { source: string; start: number; end: number; id?: string } | null {
  const start = source.search(/\S/u);
  if (start === -1 || source[start] !== "{") {
    return null;
  }
  const end = findMatchingBrace(source, start);
  if (end === -1) {
    return null;
  }
  return { source: source.slice(start, end + 1), start, end };
}

function refsFromCredentialsObject(source: string): { refs: string[]; envVars: string[] } {
  const refs = new Set<string>();
  const envVars = new Set<string>();

  for (const pattern of [credentialPattern, /credential\s*\(\s*`([^`]+)`\s*\)/gu]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const ref = match[1]?.trim();
      if (ref) {
        refs.add(ref);
      }
    }
  }

  const envEntryPattern = /["']([^"']+)["']\s*:\s*credentialEnv\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of source.matchAll(envEntryPattern)) {
    const ref = match[1]?.trim();
    const envVar = match[2]?.trim();
    if (ref) {
      refs.add(ref);
    }
    if (envVar) {
      envVars.add(envVar);
    }
  }

  return { refs: [...refs], envVars: [...envVars] };
}

function extractObjectProperty(source: string, property: string): { source: string; start: number; end: number } | null {
  const match = new RegExp(`\\b${property}\\s*:\\s*\\{`, "u").exec(source);
  if (!match) {
    return null;
  }
  const start = source.indexOf("{", match.index);
  const end = findMatchingBrace(source, start);
  if (start === -1 || end === -1) {
    return null;
  }
  return { source: source.slice(start, end + 1), start, end };
}

function findMatchingBrace(source: string, start: number): number {
  return findMatchingDelimiter(source, start, "{", "}");
}

function findMatchingDelimiter(source: string, start: number, open: string, close: string): number {
  if (start === -1) {
    return -1;
  }

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function isInsideSpan(index: number, spans: Array<{ start: number; end: number }>): boolean {
  return spans.some((span) => index >= span.start && index <= span.end);
}
