import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotes, pickMain, parseTag, allowedText, shortName } from "../lib/wave.mjs";
import { fallbackTweets, composeThread } from "../lib/compose.mjs";
import { validateTweets } from "../lib/validate.mjs";
import { parseMarker, markerLine } from "../lib/marker.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// The real 2026-09-14 wave: core had notes, the other three only bumped deps.
const wave0914 = [
  { name: "@fentaris/core", version: "3.1.1", url: "https://github.com/Fentaris/fentaris/releases/tag/%40fentaris/core%403.1.1", body: fixture("core-3.1.1.md") },
  { name: "@fentaris/cli", version: "1.6.1", url: "u", body: fixture("cli-1.6.1.md") },
  { name: "@fentaris/edge", version: "0.3.4", url: "u", body: fixture("edge-0.3.4.md") },
  { name: "@fentaris/approval-telegram", version: "0.1.15", url: "u", body: fixture("approval-telegram-0.1.15.md") },
].map((p) => ({ ...p, notes: parseNotes(p.body) }));

// The 2026-09-10 wave: a Minor with long multi-paragraph bullets on core and cli.
const wave0910 = [
  { name: "@fentaris/core", version: "3.1.0", url: "u", body: fixture("core-3.1.0.md") },
  { name: "@fentaris/cli", version: "1.6.0", url: "u", body: fixture("cli-1.6.0.md") },
].map((p) => ({ ...p, notes: parseNotes(p.body) }));

test("parseTag", () => {
  assert.deepEqual(parseTag("@fentaris/core@3.1.1"), { name: "@fentaris/core", version: "3.1.1", tag: "@fentaris/core@3.1.1" });
  assert.throws(() => parseTag("v1.2.3"));
});

test("parseNotes: patch with two substantive bullets", () => {
  const n = wave0914[0].notes;
  assert.equal(n.bump, "patch");
  assert.equal(n.dependencyOnly, false);
  assert.equal(n.substantive.length, 2);
  assert.match(n.substantive[0].summary, /^Allow group-scoped policies/);
  assert.doesNotMatch(n.substantive[0].summary, /^3dae736/);
});

test("parseNotes: dependency-only bodies", () => {
  for (const p of wave0914.slice(1)) {
    assert.equal(p.notes.dependencyOnly, true, p.name);
    assert.equal(p.notes.substantive.length, 0, p.name);
    assert.equal(p.notes.bump, "none", p.name);
  }
});

test("parseNotes: minor with multi-paragraph bullets keeps the summary line and the details", () => {
  const n = wave0910[0].notes;
  assert.equal(n.bump, "minor");
  assert.equal(n.substantive.length, 2);
  assert.equal(n.substantive[0].level, "minor");
  assert.equal(n.substantive[1].level, "patch");
  assert.match(n.substantive[0].summary, /^Perform OAuth 2\.1 against upstream MCP servers/);
  assert.ok(n.substantive[0].details.length >= 2);
  const cli = wave0910[1].notes;
  assert.equal(cli.bullets.filter((b) => b.dependency).length, 2);
});

test("pickMain: highest bump wins, ties go core > cli > edge > approval-telegram", () => {
  assert.equal(pickMain(wave0914).name, "@fentaris/core");
  assert.equal(pickMain(wave0910).name, "@fentaris/core");
  const cliOnly = [wave0914[1], { ...wave0914[0], name: "@fentaris/cli" }];
  assert.equal(shortName(pickMain(cliOnly).name), "cli");
  assert.equal(pickMain(wave0914.slice(1)), null);
});

test("fallback template validates on every real wave", () => {
  for (const wave of [wave0914, wave0910]) {
    const main = pickMain(wave);
    const tweets = fallbackTweets({ main });
    assert.equal(tweets.length, 2);
    const errors = validateTweets(tweets, { main: { short: shortName(main.name), version: main.version }, allowedText: allowedText(wave) });
    assert.deepEqual(errors, [], tweets.join("\n"));
  }
});

test("composeThread with a fake Claude client: valid answer is used as-is", async () => {
  const main = pickMain(wave0914);
  const client = { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: { skip: false, reason: "", tweets: ["fentaris/core 3.1.1: group-scoped policies can grant access to the built-in auth tools for interactive OAuth servers."] } }) } };
  const out = await composeThread({ packages: wave0914, main, waveDate: "2026-09-14", client });
  assert.equal(out.kind, "thread");
  assert.equal(out.source, "claude");
});

test("composeThread: invalid answer gets one retry with feedback, then the fallback", async () => {
  const main = pickMain(wave0914);
  const calls = [];
  const client = {
    messages: {
      parse: async (req) => {
        calls.push(req.messages[0].content);
        return { stop_reason: "end_turn", parsed_output: { skip: false, reason: "", tweets: ["fentaris/core 3.1.1 is a seamless release!"] } };
      },
    },
  };
  const out = await composeThread({ packages: wave0914, main, waveDate: "2026-09-14", client });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /banned phrase "seamless"/);
  assert.equal(out.source, "fallback");
});

test("composeThread: skip is honoured", async () => {
  const main = pickMain(wave0914);
  const client = { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: { skip: true, reason: "internal only", tweets: [] } }) } };
  const out = await composeThread({ packages: wave0914, main, waveDate: "2026-09-14", client });
  assert.deepEqual(out, { kind: "skip", reason: "internal only" });
});

test("composeThread: --no-llm goes straight to the fallback", async () => {
  const main = pickMain(wave0914);
  const out = await composeThread({ packages: wave0914, main, waveDate: "2026-09-14", useLlm: false, client: { messages: { parse: () => { throw new Error("must not be called"); } } } });
  assert.equal(out.source, "fallback");
});

test("marker round-trips", () => {
  const line = markerLine({ sha: "8125f0f9bea3", status: "posted", tweetIds: ["1", "2"] });
  assert.deepEqual(parseMarker(`${line}\nsome body`), { sha: "8125f0f9bea3", status: "posted", tweetIds: ["1", "2"] });
  assert.deepEqual(parseMarker(markerLine({ sha: "abc", status: "dry-run" })), { sha: "abc", status: "dry-run", tweetIds: [] });
  assert.equal(parseMarker("no marker here"), null);
});
