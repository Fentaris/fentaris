import { FentarisErrorCode } from "../../errors.js";
import type { MaybePromise, UserContext } from "../../types/shared.js";

/**
 * User-aware HTTP-family auth resolver context.
 * @pk
 */
export type HttpTransportAuthContext = {
  user: UserContext;
};

/**
 * API key auth options for HTTP-family MCP transports.
 * @pk
 */
export type HttpTransportApiKeyAuth =
  | {
      header: string;
      value: string;
      required?: boolean;
    }
  | {
      header: string;
      resolve: (context: HttpTransportAuthContext) => MaybePromise<string | null | undefined>;
      required?: boolean;
    };

/**
 * Shared auth options for HTTP-family upstream MCP transports.
 * @pk
 */
export type HttpTransportAuthOptions = {
  headers?: Record<string, string>;
  bearerToken?: string | ((context: HttpTransportAuthContext) => MaybePromise<string | null | undefined>);
  apiKey?: HttpTransportApiKeyAuth;
  resolveHeaders?: (context: HttpTransportAuthContext) => MaybePromise<Record<string, string> | null | undefined>;
  required?: boolean;
};

/**
 * Error thrown before an upstream HTTP-family request when required credentials are missing.
 * @pk
 */
export class MissingHttpTransportCredentialError extends Error {
  readonly code = FentarisErrorCode.Unauthorized;

  constructor(message = "Missing required upstream HTTP transport credentials") {
    super(message);
    this.name = "MissingHttpTransportCredentialError";
  }
}

/**
 * Resolve outbound HTTP-family transport headers for a user context.
 * @pk
 */
export async function resolveHttpTransportHeaders(
  options: HttpTransportAuthOptions | undefined,
  user: UserContext = {},
): Promise<Record<string, string>> {
  const accountHeaders = user.__fentarisUpstreamEnv as Record<string, string> | undefined;
  if (!options) {
    return { ...accountHeaders };
  }

  const context = { user };
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const bearerToken = typeof options.bearerToken === "function" ? await options.bearerToken(context) : options.bearerToken;
  const resolvedHeaders = await options.resolveHeaders?.(context);

  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }

  if (options.apiKey) {
    const value = "resolve" in options.apiKey ? await options.apiKey.resolve(context) : options.apiKey.value;
    if (value) {
      headers[options.apiKey.header] = value;
    } else if (options.apiKey.required !== false && options.required !== false) {
      throw new MissingHttpTransportCredentialError(`Missing required upstream API key for header "${options.apiKey.header}"`);
    }
  }

  if (resolvedHeaders) {
    Object.assign(headers, resolvedHeaders);
  }

  if (options.required && !bearerToken && !options.apiKey && !resolvedHeaders) {
    throw new MissingHttpTransportCredentialError();
  }

  return { ...headers, ...accountHeaders };
}
