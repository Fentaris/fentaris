/**
 * Serializable runtime-value references.
 *
 * A runtime value is a placeholder that appears in supported `stdio` argument
 * and environment positions and is resolved later: on a cloud target it must be
 * supplied with a cloud-side value before launch; on an edge target it is
 * resolved from a local grant during setup.
 *
 * Tokens are serializable data, never resolved values. A secret token never
 * carries its value; it references a setup field by name.
 * @pk
 */

/** Runtime reference kind. @pk */
export type RuntimeValueTokenKind = "input" | "secret";

/**
 * Marker present on every runtime-value token so the type survives serialization
 * and is distinguishable from plain strings. @pk
 */
export const RUNTIME_VALUE_TOKEN_BRAND = "__fentarisRuntimeValue";

/** A serializable runtime-value token referencing a setup field by name. @pk */
export interface RuntimeValueToken {
  readonly [RUNTIME_VALUE_TOKEN_BRAND]: true;
  readonly kind: RuntimeValueTokenKind;
  /** Name of the setup field this token resolves to. @pk */
  readonly ref: string;
}

function makeToken(kind: RuntimeValueTokenKind, ref: string): RuntimeValueToken {
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new TypeError(`runtime.${kind}() requires a non-empty field name`);
  }
  const token: RuntimeValueToken = Object.freeze({
    [RUNTIME_VALUE_TOKEN_BRAND]: true as const,
    kind,
    ref,
  });
  return token;
}

/** Runtime-value token builder namespace. @pk */
export const runtime = {
  /**
   * Create a generic runtime input reference to the setup field `ref`.
   * @pk
   */
  input(ref: string): RuntimeValueToken {
    return makeToken("input", ref);
  },
  /**
   * Create a runtime secret reference to the setup field `ref`.
   * The token never contains the secret value.
   * @pk
   */
  secret(ref: string): RuntimeValueToken {
    return makeToken("secret", ref);
  },
};

/** Type guard for {@link RuntimeValueToken}. @pk */
export function isRuntimeValueToken(value: unknown): value is RuntimeValueToken {
  return Boolean(value) && typeof value === "object" && (value as Record<string, unknown>)[RUNTIME_VALUE_TOKEN_BRAND] === true;
}

/** Inspect a token's kind for safe logging/diagnostics without resolved values. @pk */
export function describeRuntimeValueToken(token: RuntimeValueToken): string {
  return `runtime.${token.kind}("${token.ref}")`;
}

/** Extract the setup field name from a runtime value token. @pk */
export function runtimeValueRef(token: RuntimeValueToken): string {
  return token.ref;
}