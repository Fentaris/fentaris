// The idempotency marker lives as a comment on the Version Packages PR, and
// doubles as the dry-run surface Gabriele reads. One comment per wave,
// updated in place.

import { writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./wave.mjs";

const MARKER_RE = /<!--\s*changelog-to-x wave=([0-9a-f]+) status=([\w-]+) tweets=([\d,]*)\s*-->/;

export function markerLine({ sha, status, tweetIds = [] }) {
  return `<!-- changelog-to-x wave=${sha} status=${status} tweets=${tweetIds.join(",")} -->`;
}

export function parseMarker(body) {
  const m = MARKER_RE.exec(body ?? "");
  if (!m) return null;
  return { sha: m[1], status: m[2], tweetIds: m[3] ? m[3].split(",") : [] };
}

/** The PR that a commit on main was merged from, or null. */
export function findAnchorPr(repo, sha) {
  try {
    const out = run("gh", ["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", ".[0].number"]);
    return out ? Number(out) : null;
  } catch {
    return null;
  }
}

/** Existing marker comment for this wave on the PR, or null. */
export function readMarker(repo, prNumber, sha) {
  const out = run("gh", [
    "api",
    `repos/${repo}/issues/${prNumber}/comments`,
    "--paginate",
    "--jq",
    ".[] | select(.body | contains(\"changelog-to-x wave=" + sha + "\")) | {id, body}",
  ]);
  if (!out) return null;
  const first = out.split("\n").filter(Boolean)[0];
  const comment = JSON.parse(first);
  const marker = parseMarker(comment.body);
  return marker ? { commentId: comment.id, ...marker } : null;
}

function ghJsonInput(payload) {
  const dir = mkdtempSync(join(tmpdir(), "changelog-to-x-"));
  const file = join(dir, "body.json");
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

/** Creates or updates the wave's comment. Returns the comment id. */
export function writeMarker(repo, prNumber, { existingCommentId, body }) {
  const input = ghJsonInput({ body });
  if (existingCommentId) {
    run("gh", ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${existingCommentId}`, "--input", input, "--jq", ".id"]);
    return existingCommentId;
  }
  const id = run("gh", ["api", "-X", "POST", `repos/${repo}/issues/${prNumber}/comments`, "--input", input, "--jq", ".id"]);
  return Number(id);
}

export function renderComment({ sha, status, tweetIds = [], title, lines }) {
  return [markerLine({ sha, status, tweetIds }), `### Changelog to X: ${title}`, "", ...lines, ""].join("\n");
}

export function writeSummary(text) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, text + "\n");
}
