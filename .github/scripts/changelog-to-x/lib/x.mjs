// Posts to X with OAuth 1.0a user context. Stateless: four secrets in, tweet
// ids out. No retry on 403 (permissions or duplicate text), one retry on
// 429/5xx.

import crypto from "node:crypto";
import OAuth from "oauth-1.0a";

export const TWEETS_URL = "https://api.x.com/2/tweets";

export function credentialsFromEnv(env = process.env) {
  const keys = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"];
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`missing X credentials: ${missing.join(", ")}`);
  return {
    consumer: { key: env.X_API_KEY, secret: env.X_API_SECRET },
    token: { key: env.X_ACCESS_TOKEN, secret: env.X_ACCESS_TOKEN_SECRET },
  };
}

function authHeader(creds, url, method) {
  const oauth = new OAuth({
    consumer: creds.consumer,
    signature_method: "HMAC-SHA1",
    hash_function(base, key) {
      return crypto.createHmac("sha1", key).update(base).digest("base64");
    },
  });
  // JSON bodies are not part of the OAuth 1.0a signature base string.
  return oauth.toHeader(oauth.authorize({ url, method }, creds.token));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Creates one post. `replyTo` chains it under an existing tweet id.
 * Returns the new tweet id.
 */
export async function createPost({ text, replyTo, creds, fetchImpl = fetch, log = () => {} }) {
  const body = replyTo ? { text, reply: { in_reply_to_tweet_id: replyTo } } : { text };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetchImpl(TWEETS_URL, {
      method: "POST",
      headers: { ...authHeader(creds, TWEETS_URL, "POST"), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (res.ok && payload?.data?.id) return payload.data.id;

    const detail = payload?.detail || payload?.title || JSON.stringify(payload).slice(0, 300);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 2) {
      throw new Error(`X API ${res.status}: ${detail}`);
    }
    let waitMs = 15_000;
    const reset = Number(res.headers.get("x-rate-limit-reset"));
    if (Number.isFinite(reset) && reset > 0) waitMs = Math.min(Math.max(reset * 1000 - Date.now(), 1000), 120_000);
    log(`X API ${res.status}, retrying in ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
  throw new Error("unreachable");
}

/**
 * Posts the thread, then the link reply under the last tweet.
 * `afterFirst(id)` runs right after the first tweet succeeds so the caller
 * can persist the idempotency marker before anything else can go wrong.
 * Returns every id in order. Throws with `err.posted` on a partial thread.
 */
export async function postThread({ tweets, linkReply, creds, afterFirst = async () => {}, fetchImpl, log }) {
  const posted = [];
  try {
    for (const text of tweets) {
      const id = await createPost({ text, replyTo: posted.at(-1), creds, fetchImpl, log });
      posted.push(id);
      if (posted.length === 1) await afterFirst(id);
    }
    if (linkReply) {
      posted.push(await createPost({ text: linkReply, replyTo: posted.at(-1), creds, fetchImpl, log }));
    }
    return posted;
  } catch (err) {
    err.posted = posted;
    throw err;
  }
}

export function tweetUrl(id) {
  return `https://x.com/i/status/${id}`;
}
