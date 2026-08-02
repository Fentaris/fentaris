/**
 * Normalized edge error codes and error contract.
 *
 * Edge execution crosses trust and lifecycle boundaries (placement, session
 * binding, device routing, setup, workload, grant). These normalized codes are
 * used across the core placement/dispatch path and the edge agent protocol so
 * callers can branch on stable error identities instead of parsing messages.
 * @pk
 */

/** Normalized edge error code. @pk */
export type EdgeErrorCode =
  | "EDGE_PLACEMENT_AMBIGUOUS"
  | "EDGE_UNAUTHORIZED_TARGET"
  | "EDGE_SETUP_REQUIRED"
  | "EDGE_UNAVAILABLE"
  | "EDGE_CAPACITY"
  | "EDGE_INVENTORY_CONFLICT"
  | "EDGE_NAME_CONFLICT"
  | "EDGE_PROTOCOL"
  | "EDGE_WORKLOAD"
  | "EDGE_GRANT"
  | "EDGE_UNRESOLVED_RUNTIME_INPUT";

/** All normalized edge error codes, in stable order. @pk */
export const EDGE_ERROR_CODES: readonly EdgeErrorCode[] = [
  "EDGE_PLACEMENT_AMBIGUOUS",
  "EDGE_UNAUTHORIZED_TARGET",
  "EDGE_SETUP_REQUIRED",
  "EDGE_UNAVAILABLE",
  "EDGE_CAPACITY",
  "EDGE_INVENTORY_CONFLICT",
  "EDGE_NAME_CONFLICT",
  "EDGE_PROTOCOL",
  "EDGE_WORKLOAD",
  "EDGE_GRANT",
  "EDGE_UNRESOLVED_RUNTIME_INPUT",
];

/** A normalized edge error carrying a stable code and redacted details. @pk */
export interface EdgeError extends Error {
  readonly code: EdgeErrorCode;
  readonly details?: Record<string, unknown>;
}

/** Options for constructing an {@link EdgeError}. @pk */
export interface EdgeErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Create a normalized {@link EdgeError}.
 *
 * `details` should not contain resolved secrets, local paths, credentials, or
 * full command environments; redaction is the caller's responsibility.
 * @pk
 */
export function edgeError(code: EdgeErrorCode, message: string, options?: EdgeErrorOptions): EdgeError {
  const err = new Error(message);
  Object.defineProperties(err, {
    code: { value: code, enumerable: true },
    name: { value: `EdgeError[${code}]` },
    ...(options?.details ? { details: { value: options.details, enumerable: true, writable: true, configurable: true } } : {}),
  });
  if (options?.cause !== undefined) {
    (err as { cause?: unknown }).cause = options.cause;
  }
  return err as EdgeError;
}

/** Type guard for {@link EdgeError}. @pk */
export function isEdgeError(value: unknown): value is EdgeError {
  return value instanceof Error && typeof (value as EdgeError).code === "string";
}