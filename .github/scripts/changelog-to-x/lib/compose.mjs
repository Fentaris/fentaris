// Turns a wave into tweets: Claude first, one retry with the validator's
// complaints, then a deterministic template. Every path ends in validateTweets.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { validateTweets, MAX_SINGLE, MAX_THREAD, codePoints } from "./validate.mjs";
import { shortName, allowedText } from "./wave.mjs";

export const DEFAULT_MODEL = "claude-sonnet-5";

const ReleasePost = z.object({
  skip: z.boolean(),
  reason: z.string(),
  tweets: z.array(z.string()),
});

export function loadSystemPrompt() {
  return readFileSync(fileURLToPath(new URL("../prompt/system.md", import.meta.url)), "utf8");
}

function userMessage({ packages, main, waveDate }) {
  const payload = {
    wave_date: waveDate,
    main_package: shortName(main.name),
    packages: packages.map((p) => ({
      name: p.name,
      short_name: shortName(p.name),
      version: p.version,
      bump: p.notes.bump,
      dependency_only: p.notes.dependencyOnly,
      release_url: p.url,
      notes_markdown: p.body,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * One Claude call. Returns { skip, reason, tweets } or throws.
 */
export async function askClaude({ packages, main, waveDate, feedback = [], model = DEFAULT_MODEL, client }) {
  const anthropic = client ?? new Anthropic();
  const content = [userMessage({ packages, main, waveDate })];
  if (feedback.length > 0) {
    content.push(
      "Your previous answer broke these rules. Fix every one of them and return the JSON again:\n- " + feedback.join("\n- "),
    );
  }
  const response = await anthropic.messages.parse({
    model,
    max_tokens: 2048,
    system: loadSystemPrompt(),
    messages: [{ role: "user", content: content.join("\n\n") }],
    output_config: { effort: "medium", format: zodOutputFormat(ReleasePost) },
  });
  if (response.stop_reason === "max_tokens") throw new Error("Claude hit max_tokens");
  if (response.stop_reason === "refusal") throw new Error("Claude refused the request");
  if (!response.parsed_output) throw new Error("Claude returned no parseable JSON");
  return response.parsed_output;
}

function truncateToFit(text, budget) {
  if (codePoints(text) <= budget) return text;
  const cut = [...text].slice(0, budget).join("");
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  if (sentenceEnd > budget * 0.5) return cut.slice(0, sentenceEnd + 1);
  const wordEnd = cut.lastIndexOf(" ");
  return cut.slice(0, wordEnd > 0 ? wordEnd : budget).replace(/[,;:\s]+$/, "") + ".";
}

/**
 * Template used when Claude is unavailable or keeps failing validation.
 * Uses only the first line of each substantive bullet of the main package.
 */
export function fallbackTweets({ main }) {
  const short = shortName(main.name);
  const bullets = main.notes.substantive.map((b) => b.summary.replace(/\s+/g, " ").trim());
  const head = `fentaris/${short} ${main.version} is out. `;
  const tweets = [];
  if (bullets.length === 0) return tweets;

  const firstBudget = (bullets.length > 1 ? MAX_THREAD : MAX_SINGLE) - 1 - codePoints(head);
  tweets.push(head + truncateToFit(bullets[0], firstBudget));

  if (bullets.length > 1) {
    const prefix = "Also in this release: ";
    tweets.push(prefix + truncateToFit(bullets[1], MAX_THREAD - 1 - codePoints(prefix)));
  }
  return tweets;
}

/**
 * Full composition. Returns
 *   { kind: "skip", reason }
 *   { kind: "thread", tweets, source: "claude" | "fallback" }
 * or throws with the accumulated validation errors when nothing valid could be built.
 */
export async function composeThread({ packages, main, waveDate, useLlm = true, model, client, log = () => {} }) {
  const ctx = { main: { short: shortName(main.name), version: main.version }, allowedText: allowedText(packages) };
  const attempts = [];

  if (useLlm) {
    let feedback = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      let result;
      try {
        result = await askClaude({ packages, main, waveDate, feedback, model, client });
      } catch (err) {
        log(`claude attempt ${attempt} failed: ${err.message}`);
        attempts.push(`claude attempt ${attempt}: ${err.message}`);
        break;
      }
      if (result.skip) {
        log(`claude asked to skip: ${result.reason}`);
        return { kind: "skip", reason: result.reason || "no user-visible change" };
      }
      const errors = validateTweets(result.tweets, ctx);
      if (errors.length === 0) return { kind: "thread", tweets: result.tweets, source: "claude" };
      log(`claude attempt ${attempt} rejected: ${errors.join("; ")}`);
      attempts.push(`claude attempt ${attempt}: ${errors.join("; ")}`);
      feedback = errors;
    }
  }

  const fallback = fallbackTweets({ main });
  const errors = validateTweets(fallback, ctx);
  if (errors.length === 0) return { kind: "thread", tweets: fallback, source: "fallback" };
  attempts.push(`fallback: ${errors.join("; ")}`);
  const err = new Error("no valid thread could be composed:\n" + attempts.join("\n"));
  err.attempts = attempts;
  err.fallback = fallback;
  throw err;
}
