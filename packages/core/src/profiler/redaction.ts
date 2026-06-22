export type ProfilerRedactionRule =
  | { key: string | RegExp; replacement?: unknown }
  | { path: string | string[]; replacement?: unknown }
  | ((value: unknown, path: string[], key?: string) => unknown);

export type ProfilerRedactionOptions = {
  enabled?: boolean;
  replacement?: unknown;
  keys?: Array<string | RegExp>;
  paths?: Array<string | string[]>;
  rules?: ProfilerRedactionRule[];
};

export type NormalizedProfilerRedaction = {
  enabled: boolean;
  replacement: unknown;
  keys: Array<string | RegExp>;
  paths: string[][];
  custom: Array<(value: unknown, path: string[], key?: string) => unknown>;
};

const defaultSensitiveKeys = [
  /token/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /api[-_]?key/i,
  /credential/i,
];

const defaultSensitiveValuePatterns = [
  /^\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}\s*$/i,
  /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
];

export function normalizeProfilerRedaction(options: boolean | ProfilerRedactionOptions | undefined): NormalizedProfilerRedaction {
  if (options === false) {
    return { enabled: false, replacement: "[REDACTED]", keys: defaultSensitiveKeys, paths: [], custom: [] };
  }

  const config = options === true || options === undefined ? {} : options;
  const rules = config.rules ?? [];
  const ruleKeys = rules.flatMap((rule) => typeof rule === "function" || "path" in rule ? [] : [rule.key]);
  const rulePaths = rules.flatMap((rule) => typeof rule === "function" || "key" in rule ? [] : [normalizePath(rule.path)]);
  const custom = rules.flatMap((rule) => typeof rule === "function" ? [rule] : []);

  return {
    enabled: config.enabled ?? true,
    replacement: config.replacement ?? "[REDACTED]",
    keys: [...defaultSensitiveKeys, ...(config.keys ?? []), ...ruleKeys],
    paths: [...(config.paths ?? []).map(normalizePath), ...rulePaths],
    custom,
  };
}

export function redactProfilerValue<T>(value: T, options: NormalizedProfilerRedaction): T {
  if (!options.enabled) {
    return value;
  }

  return redactValue(value, options, [], new WeakSet()) as T;
}

function redactValue(
  value: unknown,
  options: NormalizedProfilerRedaction,
  path: string[],
  seen: WeakSet<object>,
): unknown {
  const key = path.at(-1);
  for (const custom of options.custom) {
    const replacement = custom(value, path, key);
    if (replacement !== undefined) {
      return replacement;
    }
  }

  if ((key && matchesKey(key, options.keys)) || matchesPath(path, options.paths)) {
    return options.replacement;
  }

  if (typeof value === "string" && matchesSensitiveValue(value)) {
    return options.replacement;
  }

  if (!value || typeof value !== "object" || value instanceof Date) {
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

function matchesKey(key: string, keys: Array<string | RegExp>): boolean {
  return keys.some((pattern) => typeof pattern === "string" ? pattern.toLowerCase() === key.toLowerCase() : pattern.test(key));
}

function matchesPath(path: string[], paths: string[][]): boolean {
  return paths.some((candidate) => candidate.length === path.length && candidate.every((segment, index) => segment === path[index]));
}

function matchesSensitiveValue(value: string): boolean {
  return defaultSensitiveValuePatterns.some((pattern) => pattern.test(value));
}

function normalizePath(path: string | string[]): string[] {
  return Array.isArray(path) ? path : path.split(".").filter(Boolean);
}
