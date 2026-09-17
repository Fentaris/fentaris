import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTweets, findBannedPhrases, codePoints } from "../lib/validate.mjs";

const ctx = {
  main: { short: "core", version: "3.1.1" },
  allowedText: "@fentaris/core 3.1.1 core\n### Patch Changes\n- Allow group-scoped policies to grant access to the built-in tools. OAuth 2.1 support.",
};

test("a good single tweet passes", () => {
  const errors = validateTweets(["fentaris/core 3.1.1: group-scoped policies can now grant access to the built-in auth tools for interactive OAuth servers."], ctx);
  assert.deepEqual(errors, []);
});

test("a good thread passes", () => {
  const errors = validateTweets(
    [
      "fentaris/core 3.1.1 is out. Group-scoped policies can grant access to the built-in `fentaris__auth_status` and `fentaris__auth_login` tools.",
      "- Stored authorization-code tokens are refreshed from headless and stdio exposures even without an OAuth redirect URL.",
    ],
    ctx,
  );
  assert.deepEqual(errors, []);
});

test("length limits are counted in code points and differ for single vs thread", () => {
  const long = "fentaris/core 3.1.1 " + "x".repeat(185);
  assert.equal(codePoints(long), 205);
  assert.match(validateTweets([long], ctx).join("\n"), /must be under 200/);
  assert.deepEqual(validateTweets([long, "- second change here"], ctx), []);
  const tooLong = "fentaris/core 3.1.1 " + "x".repeat(240);
  assert.match(validateTweets([tooLong, "- second"], ctx).join("\n"), /must be under 250/);
});

test("URLs, mentions, hashtags, emoji, exclamation marks and numbering are rejected", () => {
  const cases = {
    "fentaris/core 3.1.1 docs at https://fentaris.dev": /URL-like/,
    "fentaris/core 3.1.1 docs at fentaris.mintlify.app": /URL-like/,
    "@fentaris/core 3.1.1 is out": /@mention/,
    "fentaris/core 3.1.1 #mcp #proxy": /more than one hashtag/,
    "fentaris/core 3.1.1 is out 🚀": /emoji/,
    "fentaris/core 3.1.1 is out!": /exclamation/,
    "1/3 fentaris/core 3.1.1 is out": /thread numbering/,
  };
  for (const [tweet, re] of Object.entries(cases)) {
    assert.match(validateTweets([tweet], ctx).join("\n"), re, tweet);
  }
  // a filename with a dot is not a URL
  assert.deepEqual(validateTweets(["fentaris/core 3.1.1 persists tokens in oauth-tokens.enc.json"], ctx), []);
});

test("banned phrases and first person are rejected", () => {
  assert.deepEqual(findBannedPhrases("A seamless, robust and cutting-edge release"), ["seamless", "robust", "cutting-edge"]);
  assert.match(validateTweets(["fentaris/core 3.1.1 unlocks group-scoped policies"], ctx).join("\n"), /banned phrase "unlocks"/);
  assert.match(validateTweets(["We're excited to announce fentaris/core 3.1.1"], ctx).join("\n"), /banned phrase/);
  assert.match(validateTweets(["I shipped fentaris/core 3.1.1 today"], ctx).join("\n"), /first person/);
  assert.match(validateTweets(["fentaris/core 3.1.1: we fixed token refresh"], ctx).join("\n"), /first person/);
});

test("numbers must come from the notes or the versions", () => {
  assert.match(validateTweets(["fentaris/core 3.1.1 is 40% faster"], ctx).join("\n"), /number "40"/);
  assert.deepEqual(validateTweets(["fentaris/core 3.1.1 adds OAuth 2.1 support"], ctx), []);
});

test("tweet 1 must name the main package and its version", () => {
  assert.match(validateTweets(["fentaris/cli 1.6.1 is out"], ctx).join("\n"), /must name the main package "core"/);
  assert.match(validateTweets(["fentaris/core 3.1.0 is out"], ctx).join("\n"), /must contain the version "3.1.1"/);
});

test("repeated sentences across tweets are rejected", () => {
  const s = "Group-scoped policies can grant access to the built-in auth tools.";
  assert.match(validateTweets([`fentaris/core 3.1.1. ${s}`, `- ${s}`], ctx).join("\n"), /repeats a sentence/);
});

test("more than three tweets or no tweets fail", () => {
  assert.deepEqual(validateTweets([], ctx), ["no tweets"]);
  assert.match(validateTweets(["fentaris/core 3.1.1", "a", "b", "c"], ctx).join("\n"), /too many tweets/);
});
