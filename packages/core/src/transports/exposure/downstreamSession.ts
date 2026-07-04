/**
 * Helpers for propagating downstream session identity into proxy operation
 * context across exposure transports.
 *
 * The proxy operation context derives `transport.sessionId` from
 * `identity.metadata.sessionId` (see {@link createProxyContext}). Because the
 * SDK server handlers capture the `identity` reference passed at construction
 * time, attaching the downstream session id to that same object reference makes
 * it visible to every capability operation issued within the session.
 * @pk
 */

import type { IdentityMetadata } from "../../types/shared.js";

/**
 * Return an identity object suitable for passing to `createSdkServer`, ensuring
 * a mutable `metadata` map exists so the downstream session id can be attached
 * once it is known. When `identity` is already defined its fields are copied so
 * the SDK-server closure observes the same resolved authentication metadata.
 * @pk
 */
export function ensureIdentityWithMetadata(identity: IdentityMetadata | undefined): IdentityMetadata {
  if (!identity) {
    return { authenticated: false, metadata: {} };
  }
  if (identity.metadata) {
    return identity;
  }
  return { ...identity, metadata: {} };
}

/**
 * Attach the downstream session id to the identity metadata. The `identity`
 * object must be the same reference captured by the SDK-server handlers, so
 * callers should pass the object returned by {@link ensureIdentityWithMetadata}.
 * @pk
 */
export function attachDownstreamSessionId(identity: IdentityMetadata, sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }
  identity.metadata = { ...identity.metadata, sessionId };
}