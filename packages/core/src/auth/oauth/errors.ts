import { FentarisErrorCode } from "../../errors/errors.js";
import type { OAuthSessionKey } from "./store.js";

/**
 * Raised when an upstream OAuth server requires a human to complete authorization.
 * @pk
 */
export class OAuthAuthorizationRequiredError extends Error {
  readonly code = FentarisErrorCode.Unauthorized;
  readonly server: string;
  readonly session: OAuthSessionKey;
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt: number;

  constructor(options: {
    server: string;
    session: OAuthSessionKey;
    authorizationUrl: string;
    state: string;
    expiresAt: number;
  }) {
    super(`Authorization required for MCP server "${options.server}"`);
    this.name = "OAuthAuthorizationRequiredError";
    this.server = options.server;
    this.session = options.session;
    this.authorizationUrl = options.authorizationUrl;
    this.state = options.state;
    this.expiresAt = options.expiresAt;
  }
}

/**
 * Type guard for {@link OAuthAuthorizationRequiredError}, tolerant of cross-realm instances.
 * @pk
 */
export function isOAuthAuthorizationRequiredError(value: unknown): value is OAuthAuthorizationRequiredError {
  if (value instanceof OAuthAuthorizationRequiredError) {
    return true;
  }

  return (
    Boolean(value) &&
    value instanceof Error &&
    value.name === "OAuthAuthorizationRequiredError" &&
    typeof (value as OAuthAuthorizationRequiredError).authorizationUrl === "string" &&
    typeof (value as OAuthAuthorizationRequiredError).state === "string"
  );
}

/**
 * Unwrap a possibly wrapped authorization-required error from a nested cause chain.
 * @pk
 */
export function findOAuthAuthorizationRequiredError(error: unknown): OAuthAuthorizationRequiredError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (isOAuthAuthorizationRequiredError(current)) {
      return current;
    }

    current = current instanceof Error ? current.cause : undefined;
  }

  return undefined;
}
