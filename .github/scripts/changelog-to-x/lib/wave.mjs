// Detects a Changesets release wave and turns it into the data the composer
// needs. Reads git and the GitHub CLI; nothing here writes anywhere.

import { execFileSync } from "node:child_process";

export const PACKAGE_ORDER = ["core", "cli", "edge", "approval-telegram"];
const BUMP_RANK = { major: 3, minor: 2, patch: 1, none: 0 };

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

export function git(repoRoot, args) {
  return run("git", ["-C", repoRoot, ...args]);
}

export function shortName(name) {
  return name.replace(/^@fentaris\//, "");
}

/** `@fentaris/core@3.1.1` -> { name, version, tag } */
export function parseTag(tag) {
  const m = /^(@?[^@]+)@(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(tag.trim());
  if (!m) throw new Error(`not a release tag: ${tag}`);
  return { name: m[1], version: m[2], tag: tag.trim() };
}

function packageJsonAt(repoRoot, ref, dir) {
  try {
    return JSON.parse(git(repoRoot, ["show", `${ref}:packages/${dir}/package.json`]));
  } catch {
    return null;
  }
}

function packageDirs(repoRoot, ref) {
  const out = git(repoRoot, ["ls-tree", "--name-only", ref, "packages/"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(/^packages\//, ""));
}

/**
 * Packages whose version changed between `sha^1` and `sha` (first parent).
 * On a Version Packages merge that is exactly the released set; on a
 * "promote dev to main" merge or a chore push it is empty.
 */
export function detectBumps(repoRoot, sha) {
  const bumps = [];
  for (const dir of packageDirs(repoRoot, sha)) {
    const now = packageJsonAt(repoRoot, sha, dir);
    if (!now || now.private || !now.version) continue;
    const before = packageJsonAt(repoRoot, `${sha}^1`, dir);
    if (!before || before.version !== now.version) {
      bumps.push({ dir, name: now.name, version: now.version, previous: before?.version ?? null, tag: `${now.name}@${now.version}` });
    }
  }
  return bumps;
}

/** For --tags: the commit the first tag points at (tags are annotated). */
export function shaOfTag(repoRoot, tag) {
  return git(repoRoot, ["rev-list", "-n1", tag]);
}

/**
 * Keeps only the bumps that have a GitHub Release, attaching body and url.
 * Changesets creates a release only for what it actually published, so this
 * doubles as the "npm publish happened" check.
 */
export function confirmReleases(repo, bumps) {
  const confirmed = [];
  const missing = [];
  for (const b of bumps) {
    try {
      const json = run("gh", ["release", "view", b.tag, "-R", repo, "--json", "body,url,tagName"]);
      const rel = JSON.parse(json);
      confirmed.push({ ...b, body: rel.body ?? "", url: rel.url });
    } catch {
      missing.push(b.tag);
    }
  }
  return { confirmed, missing };
}

/**
 * Parses a changeset release body:
 *   ### Minor Changes
 *   - 535b74e: Summary line.
 *
 *     Indented continuation paragraphs.
 *   ### Patch Changes
 *   - Updated dependencies [3dae736]
 *     - @fentaris/core@3.1.1
 */
export function parseNotes(body) {
  const lines = (body ?? "").replace(/\r\n/g, "\n").split("\n");
  let level = "none";
  let bump = "none";
  const bullets = [];
  let current = null;

  for (const line of lines) {
    const heading = /^###\s+(Major|Minor|Patch)\s+Changes/i.exec(line);
    if (heading) {
      level = heading[1].toLowerCase();
      current = null;
      continue;
    }
    const bullet = /^- (.*)$/.exec(line);
    if (bullet) {
      const text = bullet[1].trim();
      const dependency = /^Updated dependencies\b/i.test(text);
      current = { level, dependency, summary: dependency ? text : text.replace(/^[0-9a-f]{7,40}:\s*/i, ""), details: [] };
      bullets.push(current);
      continue;
    }
    if (current && /^\s{2,}\S/.test(line) && !/^\s+- @/.test(line)) {
      current.details.push(line.trim());
    }
  }

  const substantive = bullets.filter((b) => !b.dependency);
  for (const b of substantive) {
    if (BUMP_RANK[b.level] > BUMP_RANK[bump]) bump = b.level;
  }
  return {
    bump,
    bullets,
    substantive,
    dependencyOnly: bullets.length > 0 && substantive.length === 0,
  };
}

/** Highest bump among non-dependency-only packages; ties by PACKAGE_ORDER. */
export function pickMain(packages) {
  const candidates = packages.filter((p) => !p.notes.dependencyOnly && p.notes.substantive.length > 0);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const byBump = BUMP_RANK[b.notes.bump] - BUMP_RANK[a.notes.bump];
    if (byBump !== 0) return byBump;
    return PACKAGE_ORDER.indexOf(shortName(a.name)) - PACKAGE_ORDER.indexOf(shortName(b.name));
  });
  return candidates[0];
}

/** Everything a digit in a tweet is allowed to come from. */
export function allowedText(packages) {
  return packages.map((p) => `${p.name} ${p.version} ${shortName(p.name)}\n${p.body}`).join("\n");
}
