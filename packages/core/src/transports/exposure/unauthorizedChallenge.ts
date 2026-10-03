import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProxyRuntime } from "../../types/proxy.js";
import type { OAuthChallengeReason } from "../../identity/oauthIdentityStrategy.js";

export function setUnauthorizedChallenge(runtime: ProxyRuntime, req: IncomingMessage, res: ServerResponse, reason: OAuthChallengeReason = "missing_token"): void {
  const challenge = runtime.unauthorizedChallenge?.(reason, req);
  if (challenge) res.setHeader("WWW-Authenticate", challenge);
}
