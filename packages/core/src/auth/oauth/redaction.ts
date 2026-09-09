const redactedQueryParams = new Set([
  "code",
  "state",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "code_verifier",
  "assertion",
]);

const redactedJsonKeys = [
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "code",
  "code_verifier",
  "state",
  "authorization_code",
];

const redactedPlaceholder = "[redacted]";

/**
 * Redact authorization codes, state, and token-bearing query parameters from a URL.
 * @pk
 */
export function redactOAuthUrl(value: string | URL): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return redactedPlaceholder;
  }

  for (const name of [...url.searchParams.keys()]) {
    if (redactedQueryParams.has(name.toLowerCase())) {
      url.searchParams.set(name, redactedPlaceholder);
    }
  }

  return url.toString();
}

/**
 * Redact OAuth secrets from an arbitrary structured value before logging it.
 * @pk
 */
export function redactOAuthValue<T>(value: T): T {
  return redactValue(value, 0) as T;
}

/**
 * Redact OAuth secrets that may appear inside a free-form message.
 * @pk
 */
export function redactOAuthMessage(message: string): string {
  let redacted = message;
  for (const key of redactedJsonKeys) {
    redacted = redacted.replaceAll(new RegExp(`(["']?${key}["']?\\s*[=:]\\s*["']?)([^"'\\s,&}]+)`, "gi"), `$1${redactedPlaceholder}`);
  }

  return redacted.replaceAll(/https?:\/\/\S+/g, (match) => redactOAuthUrl(match));
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 6) {
    return value;
  }

  if (typeof value === "string") {
    return value.includes("://") ? redactOAuthUrl(value) : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      redactedJsonKeys.includes(key.toLowerCase()) ? redactedPlaceholder : redactValue(entry, depth + 1),
    ]),
  );
}
