// Hard rules for every tweet that leaves this pipeline, model-written or
// templated. Pure functions, no I/O. The prompt raises the hit rate; this
// file is what actually protects the account.

export const MAX_SINGLE = 200; // a one-tweet post must be shorter than this
export const MAX_THREAD = 250; // each tweet of a thread must be shorter than this
export const MAX_TWEETS = 3;

// gtm-brief.md §8 plus the pipeline's own additions. Word-boundary, case-insensitive.
export const BANNED_PHRASES = [
  "enterprise-grade",
  "enterprise grade",
  "seamless",
  "seamlessly",
  "revolutionize",
  "revolutionary",
  "game-changer",
  "game changer",
  "game-changing",
  "unlock",
  "unlocks",
  "empower",
  "empowers",
  "leverage",
  "leverages",
  "robust",
  "cutting-edge",
  "cutting edge",
  "excited to announce",
  "we're excited",
  "we are excited",
  "thrilled",
  "supercharge",
  "supercharges",
  "effortless",
  "effortlessly",
];

// Product voice: never first person.
const FIRST_PERSON = [/\bI\b/, /\bI'm\b/i, /\bI've\b/i, /\bI'll\b/i, /\bwe\b/i, /\bwe're\b/i, /\bwe've\b/i];

const URL_LIKE = /https?:\/\/|www\.|(^|[^\w])[\w-]+\.(com|dev|app|io|org|net|sh|ai)\b/i;
const MENTION = /(^|\s)@\S/;
const THREAD_NUMBERING = /(^|\s)\d+\/\d*(\s|$)/;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function codePoints(s) {
  return [...s].length;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findBannedPhrases(text) {
  const hits = [];
  for (const phrase of BANNED_PHRASES) {
    const re = new RegExp(`(^|[^\\w-])${escapeRegExp(phrase)}(?![\\w-])`, "i");
    if (re.test(text)) hits.push(phrase);
  }
  return hits;
}

function sentences(text) {
  return text
    .split(/[.!?\n]+/)
    .map((s) => s.trim().toLowerCase().replace(/^[^a-z0-9`]+/, ""))
    .filter((s) => s.length > 20);
}

/**
 * @param {string[]} tweets
 * @param {{ main: { short: string, version: string }, allowedText: string }} ctx
 *   `allowedText` is every string a number may legitimately come from: the
 *   release notes, the package names and the version strings.
 * @returns {string[]} human-readable rule violations; empty means valid.
 */
export function validateTweets(tweets, ctx) {
  const errors = [];
  if (!Array.isArray(tweets) || tweets.length === 0) return ["no tweets"];
  if (tweets.length > MAX_TWEETS) errors.push(`too many tweets: ${tweets.length} > ${MAX_TWEETS}`);

  const limit = tweets.length === 1 ? MAX_SINGLE : MAX_THREAD;
  const allowed = (ctx.allowedText ?? "").normalize("NFC");
  const seen = new Map();

  tweets.forEach((raw, i) => {
    const n = i + 1;
    if (typeof raw !== "string") {
      errors.push(`tweet ${n}: not a string`);
      return;
    }
    const t = raw.normalize("NFC");
    if (t.trim() === "") errors.push(`tweet ${n}: empty`);
    if (t !== t.trim()) errors.push(`tweet ${n}: leading or trailing whitespace`);
    if (CONTROL.test(t)) errors.push(`tweet ${n}: control characters`);
    const len = codePoints(t);
    if (len >= limit) errors.push(`tweet ${n}: ${len} code points, must be under ${limit}`);
    if (URL_LIKE.test(t)) errors.push(`tweet ${n}: contains a URL-like token (links go in the reply)`);
    if (MENTION.test(t)) errors.push(`tweet ${n}: contains an @mention (write package names as fentaris/core, without @)`);
    if ((t.match(/#/g) ?? []).length > 1) errors.push(`tweet ${n}: more than one hashtag`);
    if (PICTOGRAPH.test(t)) errors.push(`tweet ${n}: contains emoji`);
    if (t.includes("!")) errors.push(`tweet ${n}: contains an exclamation mark`);
    if (THREAD_NUMBERING.test(t)) errors.push(`tweet ${n}: thread numbering like 1/3`);
    for (const phrase of findBannedPhrases(t)) errors.push(`tweet ${n}: banned phrase "${phrase}"`);
    for (const re of FIRST_PERSON) {
      if (re.test(t)) {
        errors.push(`tweet ${n}: first person (${re.source})`);
        break;
      }
    }
    for (const num of new Set(t.match(/\d+/g) ?? [])) {
      if (!allowed.includes(num)) errors.push(`tweet ${n}: number "${num}" does not appear in the release notes`);
    }
    for (const s of sentences(t)) {
      if (seen.has(s)) errors.push(`tweet ${n}: repeats a sentence from tweet ${seen.get(s)}`);
      else seen.set(s, n);
    }
  });

  if (typeof tweets[0] === "string" && ctx.main) {
    const first = tweets[0].normalize("NFC");
    if (!first.includes(ctx.main.short)) errors.push(`tweet 1: must name the main package "${ctx.main.short}"`);
    if (!first.includes(ctx.main.version)) errors.push(`tweet 1: must contain the version "${ctx.main.version}"`);
  }

  return errors;
}
