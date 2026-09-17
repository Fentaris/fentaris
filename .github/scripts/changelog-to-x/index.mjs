#!/usr/bin/env node
// Changelog to X: one run per Changesets release wave.
//
//   node index.mjs [--ref <sha>] [--tags a@1.0.0,b@2.0.0] [--mode dry-run|live]
//                  [--force] [--stdout] [--no-llm] [--repo owner/name]
//
// Exit 0: not a wave, dependency-only, skipped, already posted, dry-run done, live done.
// Exit 1: needs a human (nothing valid to post, X error, partial thread).

import { parseArgs } from "node:util";
import {
  git,
  run,
  detectBumps,
  parseTag,
  shaOfTag,
  confirmReleases,
  parseNotes,
  pickMain,
  shortName,
  PACKAGE_ORDER,
} from "./lib/wave.mjs";
import { composeThread, DEFAULT_MODEL } from "./lib/compose.mjs";
import { findAnchorPr, readMarker, writeMarker, renderComment, writeSummary } from "./lib/marker.mjs";
import { credentialsFromEnv, postThread, tweetUrl } from "./lib/x.mjs";

const { values: args } = parseArgs({
  options: {
    ref: { type: "string" },
    tags: { type: "string", default: "" },
    mode: { type: "string", default: "" },
    force: { type: "boolean", default: false },
    stdout: { type: "boolean", default: false },
    "no-llm": { type: "boolean", default: false },
    repo: { type: "string" },
  },
});

const log = (msg) => console.error(`[changelog-to-x] ${msg}`);

function resolveMode(input, envMode) {
  const cap = (envMode || "off").toLowerCase();
  const requested = (input || "").toLowerCase();
  if (cap === "off") return "off";
  if (!["dry-run", "live"].includes(cap)) throw new Error(`CHANGELOG_X_MODE must be off, dry-run or live (got "${envMode}")`);
  if (requested === "" || requested === cap) return cap;
  if (requested === "dry-run") return "dry-run"; // a dispatch may downgrade
  if (requested === "live" && cap === "dry-run") {
    log("mode input is live but CHANGELOG_X_MODE is dry-run; staying in dry-run");
    return "dry-run";
  }
  throw new Error(`unknown mode "${input}"`);
}

function repoRootFromCwd() {
  return process.env.GITHUB_WORKSPACE || run("git", ["rev-parse", "--show-toplevel"]);
}

function repoSlug(explicit) {
  if (explicit) return explicit;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
}

function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null;
}

function describeWave(packages, main) {
  const parts = packages.map((p) => `${shortName(p.name)} ${p.version}${p.notes.dependencyOnly ? " (deps only)" : ""}`);
  return `${parts.join(", ")}${main ? ` · main: ${shortName(main.name)}` : ""}`;
}

function threadLines(tweets, linkReply) {
  const lines = tweets.map((t, i) => `**${i + 1}.** ${t.replace(/\n/g, "<br>")}`);
  if (linkReply) lines.push(`**Reply:** ${linkReply}`);
  return lines;
}

function report({ repo, prNumber, sha, status, title, lines, tweetIds = [], existingCommentId, toStdout }) {
  const body = renderComment({ sha, status, tweetIds, title, lines: [...lines, ...(runUrl() ? ["", `_Run: ${runUrl()}_`] : [])] });
  writeSummary(body);
  if (toStdout || !prNumber) {
    console.log(body);
    return null;
  }
  return writeMarker(repo, prNumber, { existingCommentId, body });
}

async function main() {
  const mode = resolveMode(args.mode, process.env.CHANGELOG_X_MODE);
  if (mode === "off") {
    log("CHANGELOG_X_MODE is off; nothing to do");
    return 0;
  }
  const repoRoot = repoRootFromCwd();
  const repo = repoSlug(args.repo);

  // 1. Which commit, which packages.
  let sha;
  let bumps;
  if (args.tags) {
    const tags = args.tags.split(",").map((t) => t.trim()).filter(Boolean).map(parseTag);
    sha = shaOfTag(repoRoot, tags[0].tag);
    bumps = tags.map((t) => ({ ...t, dir: shortName(t.name) }));
  } else {
    sha = git(repoRoot, ["rev-parse", args.ref || "HEAD"]);
    bumps = detectBumps(repoRoot, sha);
  }
  const shortSha = sha.slice(0, 12);
  log(`wave commit ${shortSha}, mode ${mode}`);

  if (bumps.length === 0) {
    const msg = `not a release wave: no package version changed in ${shortSha}`;
    log(msg);
    writeSummary(`Changelog to X: ${msg}`);
    return 0;
  }

  // 2. Confirm publication through the GitHub Releases Changesets created.
  const { confirmed, missing } = confirmReleases(repo, bumps);
  if (missing.length > 0) log(`no GitHub Release for: ${missing.join(", ")}`);
  if (confirmed.length === 0) {
    const msg = `versions bumped in ${shortSha} but no GitHub Release exists yet; not posting`;
    log(msg);
    writeSummary(`Changelog to X: ${msg}`);
    return 0;
  }
  const packages = confirmed
    .map((p) => ({ ...p, notes: parseNotes(p.body) }))
    .sort((a, b) => PACKAGE_ORDER.indexOf(shortName(a.name)) - PACKAGE_ORDER.indexOf(shortName(b.name)));
  const main = pickMain(packages);

  // 3. Anchor PR and idempotency marker.
  const prNumber = findAnchorPr(repo, sha);
  if (!prNumber) log(`no pull request found for ${shortSha}`);
  const existing = prNumber ? readMarker(repo, prNumber, sha) : null;
  if (existing && ["posted", "partial"].includes(existing.status) && !args.force) {
    log(`already ${existing.status} (tweets ${existing.tweetIds.join(",") || "?"}); use --force to override`);
    writeSummary(`Changelog to X: wave ${shortSha} already ${existing.status}, skipping.`);
    return 0;
  }
  const existingCommentId = existing?.commentId;
  const waveDate = git(repoRoot, ["show", "-s", "--format=%cs", sha]);

  // 4. Nothing worth announcing.
  if (!main) {
    report({
      repo, prNumber, sha, status: "skipped", title: "skipped", toStdout: args.stdout, existingCommentId,
      lines: [`**Wave:** ${describeWave(packages, null)}`, "", "Every package only updated dependencies. Nothing to announce."],
    });
    return 0;
  }

  // 5. Compose.
  let composed;
  try {
    composed = await composeThread({
      packages, main, waveDate, useLlm: !args["no-llm"], model: process.env.CHANGELOG_X_MODEL || DEFAULT_MODEL, log,
    });
  } catch (err) {
    report({
      repo, prNumber, sha, status: "needs-human", title: "nothing valid to post", toStdout: args.stdout, existingCommentId,
      lines: [`**Wave:** ${describeWave(packages, main)}`, "", "```", err.message, "```", "", "Last fallback attempt:", ...threadLines(err.fallback ?? [])],
    });
    return 1;
  }

  if (composed.kind === "skip") {
    report({
      repo, prNumber, sha, status: "skipped", title: "skipped", toStdout: args.stdout, existingCommentId,
      lines: [`**Wave:** ${describeWave(packages, main)}`, "", `Skipped: ${composed.reason}`],
    });
    return 0;
  }

  const linkReply = `Release notes: ${main.url}`;
  const header = [`**Wave:** ${describeWave(packages, main)}`, `**Source:** ${composed.source}`, ""];

  // 6. Dry-run: show, don't post.
  if (mode === "dry-run") {
    report({
      repo, prNumber, sha, status: "dry-run", title: "dry-run (nothing posted)", toStdout: args.stdout, existingCommentId,
      lines: [...header, ...threadLines(composed.tweets, linkReply)],
    });
    return 0;
  }

  // 7. Live.
  if (!prNumber) {
    log("live mode needs a pull request to anchor the marker; refusing to post");
    console.log(renderComment({ sha, status: "refused", title: "live refused: no anchor PR", lines: [...header, ...threadLines(composed.tweets, linkReply)] }));
    return 1;
  }
  const creds = credentialsFromEnv();
  let commentId = existingCommentId;
  try {
    const ids = await postThread({
      tweets: composed.tweets,
      linkReply,
      creds,
      log,
      afterFirst: async (firstId) => {
        commentId = report({
          repo, prNumber, sha, status: "posted", tweetIds: [firstId], title: "posting", existingCommentId: commentId,
          lines: [...header, `First tweet: ${tweetUrl(firstId)}`, "", ...threadLines(composed.tweets, linkReply)],
        });
      },
    });
    report({
      repo, prNumber, sha, status: "posted", tweetIds: ids, title: "posted", existingCommentId: commentId,
      lines: [...header, `Thread: ${tweetUrl(ids[0])}`, "", ...threadLines(composed.tweets, linkReply)],
    });
    log(`posted ${ids.length} tweets, first ${tweetUrl(ids[0])}`);
    return 0;
  } catch (err) {
    const posted = err.posted ?? [];
    report({
      repo, prNumber, sha, status: posted.length > 0 ? "partial" : "failed", tweetIds: posted, title: "post failed", existingCommentId: commentId,
      lines: [...header, `Error: ${err.message}`, posted.length > 0 ? `Posted so far: ${posted.map(tweetUrl).join(", ")}` : "Nothing was posted.", "", ...threadLines(composed.tweets, linkReply)],
    });
    log(`post failed: ${err.message}`);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(err.stack || err.message);
    process.exit(1);
  });
