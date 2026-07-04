import { redactEdgeProtocolValue } from "@fentaris/core";

/** Recursively redact credentials, secrets, full environments, and private paths. */
export function redactEdgeValue(value: unknown): unknown {
  return redactEdgeProtocolValue(value);
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
