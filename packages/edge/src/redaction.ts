const SENSITIVE_KEYS = /authorization|credential|privateKey|secret|token|environment|env|path|directory|file/i;

/** Recursively redact credentials, secrets, full environments, and private paths. */
export function redactEdgeValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEYS.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => redactEdgeValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
        entryKey,
        redactEdgeValue(entry, entryKey),
      ]),
    );
  }
  return value;
}

export function safeEdgeError(error: unknown): { name: string; message: string } {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    name: normalized.name,
    message: String(redactText(normalized.message)),
  };
}

function redactText(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|credential|authorization)=\S+/gi, "$1=[REDACTED]")
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s"']+/g, "[REDACTED_PATH]");
}
