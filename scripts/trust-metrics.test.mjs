// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DELIVERY_UNAVAILABLE_REASON,
  QA_UNIT,
  buildSnapshot,
  attributePullRequest,
  normalizePullRequest,
  parseReviewVerdict,
  computeBots,
  computeLiveQuotes,
  computeMerges,
  computeQa,
  computeReverts,
  computeTimeToMerge,
  mergedInWindow,
  parseCliArgs,
  parseQaVerdict,
  parseResultsJsonl,
  percentile,
  resolveWindow,
  runCli,
  resolveBinary,
  SAFE_BIN_DIRS,
  serializeSnapshot,
  weekStartUtc,
} from "./trust-metrics.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/trust-metrics/", import.meta.url));
const fixture = (name) => path.join(FIXTURES, name);
const readFixture = (name) => JSON.parse(fs.readFileSync(fixture(name), "utf8"));
const WINDOW_INPUT = { start: "2026-09-28", end: "2026-10-15" };
const window = resolveWindow(WINDOW_INPUT);
const prs = readFixture("prs.json");
const comments = readFixture("comments.json");
const harnessRows = parseResultsJsonl(fs.readFileSync(fixture("results.jsonl"), "utf8"));
const merged = mergedInWindow(prs, window);

const fixtureSnapshot = (overrides = {}) => buildSnapshot({
  window: WINDOW_INPUT,
  pullRequests: prs,
  comments,
  harnessRows,
  harnessResultFiles: 1,
  ...overrides,
});

describe("window and weeks", () => {
  it("buckets by Monday 00:00 UTC", () => {
    expect(weekStartUtc("2026-10-04T23:59:59Z")).toBe("2026-09-28");
    expect(weekStartUtc("2026-10-05T00:00:00Z")).toBe("2026-10-05");
    expect(weekStartUtc("2026-10-15T12:00:00Z")).toBe("2026-10-12");
  });

  it("defaults to eight Monday-aligned weeks ending with the end week", () => {
    expect(resolveWindow({ end: "2026-10-15" })).toMatchObject({ start: "2026-08-24", end: "2026-10-15" });
    expect(resolveWindow({ end: "2026-10-15", weeks: 1 }).start).toBe("2026-10-12");
  });

  it("rejects malformed and inverted windows", () => {
    expect(() => resolveWindow({ end: "2026-13-01" })).toThrow(/valid date/);
    expect(() => resolveWindow({ end: "10/15/2026" })).toThrow(/YYYY-MM-DD/);
    expect(() => resolveWindow({ start: "2026-10-16", end: "2026-10-15" })).toThrow(/after/);
  });

  it("keeps only PRs merged into the base branch inside whole UTC window days", () => {
    expect(merged.map((pr) => pr.number)).toEqual([1, 2, 3, 4, 5, 9]);
    expect(mergedInWindow(prs, window, "feature/ovd-10").map((pr) => pr.number)).toEqual([10]);
  });
});

describe("merges per week", () => {
  it("counts merges per Monday week, including empty weeks", () => {
    expect(computeMerges(merged, window)).toEqual({
      total: 6,
      perWeek: [
        { weekStart: "2026-09-28", count: 2 },
        { weekStart: "2026-10-05", count: 2 },
        { weekStart: "2026-10-12", count: 2 },
      ],
    });
    const wide = resolveWindow({ start: "2026-09-21", end: "2026-10-15" });
    expect(computeMerges(mergedInWindow(prs, wide), wide).perWeek[0]).toEqual({ weekStart: "2026-09-21", count: 1 });
  });

  it("accepts gh pr list camelCase input", () => {
    const camel = [{ number: 1, title: "x", createdAt: "2026-10-01T00:00:00Z", mergedAt: "2026-10-01T01:00:00Z", headRefName: "a", labels: [] }];
    expect(computeMerges(mergedInWindow(camel, window), window).total).toBe(1);
  });
});

describe("QA verdicts", () => {
  it("parses the verdict from the first non-empty line only", () => {
    expect(parseQaVerdict("QA: PASS on 31e99417 All ACs met")).toBe("pass");
    expect(parseQaVerdict("QA: FAIL on db45840")).toBe("fail");
    expect(parseQaVerdict("\n**QA: FAIL** on 1234567")).toBe("fail");
    expect(parseQaVerdict("Final-head QA PASS at 1c3253a")).toBe("pass");
    expect(parseQaVerdict("T5 final QA PASS at `9d67da3`")).toBe("pass");
    expect(parseQaVerdict("QA FAIL follow-up on head `ad052d6`")).toBeNull();
    expect(parseQaVerdict("Hosted CI green.\nQA: PASS on abc")).toBeNull();
    expect(parseQaVerdict("QA: PARTIAL on abc")).toBeNull();
    expect(parseQaVerdict(undefined)).toBeNull();
  });

  it("counts the latest in-window verdict per merged PR", () => {
    expect(computeQa(merged, comments, window)).toEqual({ pass: 2, fail: 2, noVerdict: 2, unit: QA_UNIT });
  });

  it("breaks same-instant ties by comment id", () => {
    const tie = [
      { id: 2, issue_url: "x/issues/9", created_at: "2026-10-14T07:00:00Z", body: "QA: PASS on a" },
      { id: 1, issue_url: "x/issues/9", created_at: "2026-10-14T07:00:00Z", body: "QA: FAIL on a" },
    ];
    expect(computeQa(merged, tie, window)).toMatchObject({ pass: 1, fail: 0 });
  });
});

describe("reverts and rollbacks", () => {
  it("detects reverts by title, revert branch or label, and rollbacks by leading title word or label", () => {
    expect(computeReverts(merged)).toEqual({ reverts: 1, rollbacks: 2 });
  });

  it("counts a PR once, revert first", () => {
    const both = mergedInWindow([{ number: 1, title: "Revert \"Rollback x\"", created_at: "2026-10-01T00:00:00Z",
      merged_at: "2026-10-01T01:00:00Z", head: { ref: "a" }, labels: [{ name: "rollback" }] }], window);
    expect(computeReverts(both)).toEqual({ reverts: 1, rollbacks: 0 });
  });
});

describe("time to merge", () => {
  it("uses linear-interpolation percentiles", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([288, 2, 24, 4, 10, 6], 0.5)).toBe(8);
    expect(percentile([288, 2, 24, 4, 10, 6], 0.9)).toBe(156);
  });

  it("reports window and weekly median and p90 hours, omitting weeks without merges", () => {
    expect(computeTimeToMerge(merged)).toEqual({
      medianHours: 8,
      p90Hours: 156,
      perWeek: [
        { weekStart: "2026-09-28", medianHours: 17, p90Hours: 22.6 },
        { weekStart: "2026-10-05", medianHours: 3, p90Hours: 3.8 },
        { weekStart: "2026-10-12", medianHours: 147, p90Hours: 259.8 },
      ],
    });
    expect(computeTimeToMerge([])).toEqual({ medianHours: null, p90Hours: null, perWeek: [] });
  });
});

describe("live quotes", () => {
  it("skips blank and malformed results.jsonl lines", () => {
    const skipped = [];
    parseResultsJsonl(fs.readFileSync(fixture("results.jsonl"), "utf8"), (line) => skipped.push(line));
    expect(skipped).toEqual([7]);
  });

  it("keeps in-window v1 rows, dedupes, sorts and passes lead time through", () => {
    expect(computeLiveQuotes(harnessRows, window)).toEqual([
      {
        runId: "20261012T080000Z-9c0d1e2f",
        provider: "protolabs",
        requestedQuantity: 10,
        totalPriceUsd: null,
        leadTimeBusinessDays: null,
        estimatedDeliveryDate: null,
        deliveryUnavailableReason: DELIVERY_UNAVAILABLE_REASON,
        status: null,
        timestamp: "2026-10-12T08:00:00.000Z",
        errorCode: "price_unavailable",
      },
      {
        runId: "20261014T090000Z-1a2b3c4d",
        provider: "xometry",
        requestedQuantity: 10,
        totalPriceUsd: 414.15,
        leadTimeBusinessDays: null,
        estimatedDeliveryDate: null,
        deliveryUnavailableReason: DELIVERY_UNAVAILABLE_REASON,
        status: "instant_quote_received",
        timestamp: "2026-10-14T09:00:00.000Z",
        errorCode: null,
      },
      {
        runId: "20261014T090000Z-1a2b3c4d",
        provider: "fictiv",
        requestedQuantity: 1,
        totalPriceUsd: 188,
        leadTimeBusinessDays: 7,
        estimatedDeliveryDate: null,
        deliveryUnavailableReason: DELIVERY_UNAVAILABLE_REASON,
        status: "instant_quote_received",
        timestamp: "2026-10-14T09:01:02.000Z",
        errorCode: null,
      },
    ]);
  });

  it("never carries quote URLs or provider quote ids into the snapshot", () => {
    const json = serializeSnapshot(fixtureSnapshot());
    expect(json).not.toMatch(/quoteUrl|providerQuoteId|Q00-0000-0000|example\.com|artifacts/);
  });

  it("never derives a delivery date from lead time or timestamp", () => {
    for (const quote of computeLiveQuotes(harnessRows, window)) {
      expect(quote.estimatedDeliveryDate).toBeNull();
    }
  });
});

describe("snapshot", () => {
  it("has the v1 shape in a stable key order", () => {
    const snapshot = fixtureSnapshot();
    expect(Object.keys(snapshot)).toEqual([
      "schemaVersion", "generatedAt", "window", "sources", "merges", "qa", "reverts", "timeToMerge", "liveQuotes", "bots", "botAttribution",
    ]);
    expect(snapshot).toMatchObject({
      schemaVersion: "trust-snapshot.v1",
      generatedAt: "2026-10-15T23:59:59Z",
      window: { start: "2026-09-28", end: "2026-10-15" },
      sources: { repository: "optomachina/Overdrafter", baseBranch: "main", harnessResultFiles: 1 },
      bots: [{ bot: "unknown", prs: 6, qa: { pass: 2, fail: 2, noVerdict: 2, passRate: 0.5 }, reverts: { reverts: 1, rollbacks: 2 }, reviews: { approved: 0, changesRequired: 0 } }],
      botAttribution: { attributed: 0, noSignal: 6, conflicting: 0, ambiguous: 0, bySource: { label: 0, body: 0, author: 0 } },
    });
  });

  it("takes generatedAt from input, normalized to whole-second UTC", () => {
    expect(fixtureSnapshot({ generatedAt: "2026-10-15T07:00:00.123-07:00" }).generatedAt).toBe("2026-10-15T14:00:00Z");
    expect(() => fixtureSnapshot({ generatedAt: "yesterday" })).toThrow(/ISO 8601/);
  });

  it("is deterministic: same inputs in any order give identical JSON", () => {
    const first = serializeSnapshot(fixtureSnapshot());
    const second = serializeSnapshot(fixtureSnapshot({
      pullRequests: [...prs].reverse(),
      comments: [...comments].reverse(),
      harnessRows: [...harnessRows].reverse(),
    }));
    expect(second).toBe(first);
  });
});

describe("cli", () => {
  const tempDirs = [];
  const tempDir = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  const offlineArgs = (out) => [
    "--window-start", "2026-09-28", "--window-end", "2026-10-15",
    "--prs-json", fixture("prs.json"), "--comments-json", fixture("comments.json"),
    "--results-jsonl", fixture("results.jsonl"), "--out", out,
  ];
  const noNetwork = () => {
    throw new Error("network fetch attempted");
  };

  it("writes byte-identical files on repeated offline runs without touching the network", () => {
    const dir = tempDir("trust-metrics-");
    const outputs = ["a.json", "b.json"].map((name) => {
      const out = path.join(dir, name);
      expect(runCli(offlineArgs(out), { fetchInputs: noNetwork, log: () => undefined })).toBe(0);
      return fs.readFileSync(out, "utf8");
    });
    expect(outputs[1]).toBe(outputs[0]);
    expect(JSON.parse(outputs[0]).merges.total).toBe(6);
  });

  it("reads every run's results.jsonl under an artifact root", () => {
    const root = tempDir("trust-metrics-root-");
    fs.mkdirSync(path.join(root, "20261014T090000Z-1a2b3c4d"));
    fs.copyFileSync(fixture("results.jsonl"), path.join(root, "20261014T090000Z-1a2b3c4d", "results.jsonl"));
    const out = path.join(root, "out.json");
    const args = offlineArgs(out).filter((arg) => arg !== "--results-jsonl" && arg !== fixture("results.jsonl"));
    runCli([...args, "--artifact-root", root], { fetchInputs: noNetwork, log: () => undefined });
    const snapshot = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(snapshot.sources.harnessResultFiles).toBe(1);
    expect(snapshot.liveQuotes).toHaveLength(3);
  });

  it("validates arguments", () => {
    expect(() => parseCliArgs(["--prs-json", "a.json"])).toThrow(/together/);
    expect(() => parseCliArgs(["--bogus"])).toThrow(/Unknown/);
    expect(() => parseCliArgs(["--window-end"])).toThrow(/needs a value/);
    expect(runCli([], { fetchInputs: noNetwork, log: () => undefined })).toBe(2);
  });
});

describe("resolveBinary", () => {
  it("returns the first fixed directory that has the binary and never reads PATH", () => {
    const exists = (candidate) => candidate === "/usr/local/bin/gh" || candidate === "/opt/homebrew/bin/gh";
    expect(resolveBinary("gh", { exists })).toBe("/usr/local/bin/gh");
    expect(SAFE_BIN_DIRS.every((dir) => path.isAbsolute(dir))).toBe(true);
  });

  it("fails closed when no fixed directory has the binary", () => {
    expect(() => resolveBinary("gh", { dirs: ["/nowhere"], exists: () => false })).toThrow(/gh not found in \/nowhere/);
  });
});


describe("bot attribution", () => {
  const botPrs = readFixture("bots-prs.json");
  const botComments = readFixture("bots-comments.json");
  const snapshot = (overrides = {}) => fixtureSnapshot({ pullRequests: botPrs, comments: botComments, ...overrides });
  const row = (bot, prs, pass, fail, noVerdict, passRate, reverts = 0, rollbacks = 0, approved = 0, changesRequired = 0) => ({
    bot, prs, qa: { pass, fail, noVerdict, passRate }, reverts: { reverts, rollbacks }, reviews: { approved, changesRequired },
  });

  it("counts builders and reviewers separately with exact aggregates", () => {
    const result = snapshot();
    expect(result.bots).toEqual([
      row("codex", 3, 2, 1, 0, 0.6667, 1, 0, 1),
      row("opus", 2, 1, 1, 0, 0.5, 0, 1, 0, 1),
      row("sonnet", 0, 0, 0, 0, null, 0, 0, 1),
      row("unknown", 11, 0, 0, 11, null),
    ]);
    expect(result.botAttribution).toEqual({ attributed: 5, noSignal: 4, conflicting: 2, ambiguous: 5, bySource: { label: 4, body: 1, author: 1 } });
    expect(result.bots.reduce((sum, bot) => sum + bot.prs, 0)).toBe(result.merges.total);
    for (const key of ["pass", "fail", "noVerdict"]) {
      expect(result.bots.reduce((sum, bot) => sum + bot.qa[key], 0)).toBe(result.qa[key]);
    }
    for (const key of ["reverts", "rollbacks"]) {
      expect(result.bots.reduce((sum, bot) => sum + bot.reverts[key], 0)).toBe(result.reverts[key]);
    }
    const { attributed, noSignal, conflicting, ambiguous } = result.botAttribution;
    expect(attributed + noSignal + conflicting + ambiguous).toBe(result.merges.total);
    expect(result.bots.at(-1).bot).toBe("unknown");
    expect(Object.keys(result.bots[0])).toEqual(["bot", "prs", "qa", "reverts", "reviews"]);
  });

  it("is deterministic and keeps bodies and human identities private", () => {
    const json = serializeSnapshot(snapshot({ repository: "example/project" }));
    expect(serializeSnapshot(snapshot({ repository: "example/project", pullRequests: [...botPrs].reverse(), comments: [...botComments].reverse() }))).toBe(json);
    expect(json).not.toMatch(/optomachina|Private fixture PR body text|Model: opus per Release|Codex review @/);
  });

  it("handles empty and entirely unattributable inputs", () => {
    const empty = snapshot({ pullRequests: [], comments: [] });
    expect(empty.bots).toEqual([]);
    expect(empty.botAttribution).toEqual({ attributed: 0, noSignal: 0, conflicting: 0, ambiguous: 0, bySource: { label: 0, body: 0, author: 0 } });
    expect(computeBots(mergedInWindow([botPrs[2]], window), [], window)).toEqual([row("unknown", 1, 0, 0, 1, null)]);
  });

  it.each([
    "Model: opus per Release",
    "_Model: opus_",
    "__model: opus__",
    "__Model: opus__",
    "__model:opus__ · x",
    "Model: opus.",
    "Model: opus, per Release",
    "Model: opus; per Release",
    "Model: opus: per Release",
    "Model: opus) per Release",
    "Model: opus· per Release",
    "**model:opus** · **Needs Blaine's card**",
    "Build model: **opus** (source: handoff)",
    "> - Builder model: opus",
    "+ Model: opus",
  ])("reads explicit body evidence: %s", (body) => {
    expect(attributePullRequest(normalizePullRequest({ body }))).toEqual({ bot: "opus", status: "attributed", sources: ["body"] });
  });

  it("marks matching invalid declarations ambiguous without normalizing keys", () => {
    expect(attributePullRequest({ body: "Model: z_bot", labels: ["model:z_bot"] })).toEqual({ bot: "unknown", status: "ambiguous", sources: ["body", "label"] });
  });

  it("keeps an unpaired leading underscore, leaving the model prefix unmatched", () => {
    expect(attributePullRequest({ body: "_Model: opus" })).toEqual({ bot: "unknown", status: "no_signal", sources: [] });
  });

  it.each(["codex/opus", "codex,opus", "opus|codex", "bot-", "z_bot", "z_bot_", "codex_", "z-bot.2_v1", "-bot", ".bot", "bot..key", "bot--key", "bot.-key", ""])("treats invalid explicit model tokens as ambiguous: %s", (token) => {
    expect(attributePullRequest({ labels: [`model:${token}`] })).toEqual({ bot: "unknown", status: "ambiguous", sources: ["label"] });
    const body = `Model: ${token}`;
    expect(attributePullRequest({ body })).toEqual({ bot: "unknown", status: "ambiguous", sources: ["body"] });
    expect(attributePullRequest({ body, labels: ["model:codex"] })).toEqual({ bot: "unknown", status: "ambiguous", sources: ["body", "label"] });
  });

  it("accepts explicit handoff lines and preserves keys without aliases", () => {
    expect(attributePullRequest({ body: "Model: sonnet per Grok Bot triage handoff (no model label exists)" }).bot).toBe("sonnet");
    expect(attributePullRequest({ labels: ["model:Claude"] }).bot).toBe("claude");
    for (const key of ["gpt-5.5", "claude-sonnet-4.5", "grok"]) {
      for (const input of [{ labels: [`model:${key}`] }, { body: `Model: ${key}` }, { user: { login: `${key}[bot]`, type: "Bot" } }]) {
        expect(attributePullRequest(input).bot).toBe(key);
      }
    }
  });

  it.each(["Codex and other reviewers: pending", "Opus review: CHANGES REQUIRED", "Generated with Claude Code", "Co-Authored-By: Claude ...", "```\nModel: opus\n```", "Model: unknown"])("ignores prose, fences and reserved keys: %s", (body) => {
    expect(attributePullRequest({ body })).toEqual({ bot: "unknown", status: "no_signal", sources: [] });
  });

  it("reports every agreeing or conflicting source without choosing a winner", () => {
    expect(attributePullRequest(normalizePullRequest({ labels: ["model:codex", "model:codex"], body: "Model: codex", user: { login: "codex[bot]", type: "Bot" } }))).toEqual({ bot: "codex", status: "attributed", sources: ["author", "body", "label"] });
    expect(attributePullRequest({ labels: ["model:codex"], body: "Model: opus" })).toEqual({ bot: "unknown", status: "conflicting", sources: ["body", "label"] });
    expect(attributePullRequest({ labels: ["model:codex", "model:opus"] })).toEqual({ bot: "unknown", status: "conflicting", sources: ["label"] });
    expect(attributePullRequest({ labels: ["model:unknown", "model:invalid/key"] })).toEqual({ bot: "unknown", status: "ambiguous", sources: ["label"] });
    expect(attributePullRequest({ labels: ["model:codex", "model:opus", "model:bot-"], body: "Model: grok", authorBot: "sonnet" })).toEqual({ bot: "unknown", status: "ambiguous", sources: ["author", "body", "label"] });
  });

  it("keeps only bot author keys during normalization", () => {
    for (const author of [{ login: "robot[bot]" }, { login: "robot", is_bot: true }]) {
      expect(normalizePullRequest({ author }).authorBot).toBe("robot");
    }
    for (const key of ["z_bot", "bot-", "codex/opus", "unknown"]) {
      expect(attributePullRequest(normalizePullRequest({ user: { login: `${key}[bot]`, type: "Bot" } }))).toEqual({ bot: "unknown", status: "no_signal", sources: [] });
    }
    const human = normalizePullRequest({ user: { login: "optomachina", type: "User" } });
    expect(human.authorBot).toBeNull();
    expect(human.body).toBe("");
    expect(JSON.stringify(human)).not.toContain("optomachina");
    expect(attributePullRequest(human).status).toBe("no_signal");
  });

  it("sorts bot keys in code-unit order with unknown last", () => {
    const input = ["z", "a.1", "a-1", "unknown"].map((bot, number) => normalizePullRequest({ number, labels: [`model:${bot}`] }));
    expect(computeBots(input, [], window).map((bot) => bot.bot)).toEqual(["a-1", "a.1", "z", "unknown"]);
  });

  it("counts id-zero reviews individually and allows comments before window start", () => {
    const comment = { prNumber: 1, body: "Codex review @ deadbeef: APPROVED", created_at: "2026-09-01T00:00:00Z" };
    const bots = computeBots(mergedInWindow(botPrs, window), [comment, comment], window);
    expect(bots[0].reviews.approved).toBe(2);
  });
});

describe("review verdicts", () => {
  it("parses the standard first-line format", () => {
    expect(parseReviewVerdict("Codex review @ 1a2b3c4d: APPROVED")).toEqual({ bot: "codex", round: "review", sha: "1a2b3c4d", verdict: "approved" });
    expect(parseReviewVerdict("\n**Opus re-review @ DEADBEEF: CHANGES REQUIRED** details")).toEqual({ bot: "opus", round: "re-review", sha: "deadbeef", verdict: "changes_required" });
  });
  it.each(["gpt-5.5", "claude-sonnet-4.5", "grok", "2bot"])("accepts valid reviewer key: %s", (bot) => {
    expect(parseReviewVerdict(`${bot} review @ deadbeef: APPROVED`)?.bot).toBe(bot);
  });
  it.each(["z_bot", "z_bot_", "bot-"])("rejects invalid reviewer keys: %s", (bot) => {
    expect(parseReviewVerdict(`${bot} review @ deadbeef: APPROVED`)).toBeNull();
  });
  it.each(["codex/opus", "codex,opus", "opus|codex"])("rejects ambiguous reviewer keys: %s", (bot) => {
    expect(parseReviewVerdict(`${bot} review @ deadbeef: APPROVED`)).toBeNull();
  });
  it.each([undefined, "Opus review: CHANGES REQUIRED @ 7717135c", "Intro\nCodex review @ deadbeef: APPROVED", "unknown review @ deadbeef: APPROVED", "Codex review @ abc: APPROVED", `Codex review @ ${"a".repeat(41)}: APPROVED`])("rejects nonstandard verdict %s", (body) => {
    expect(parseReviewVerdict(body)).toBeNull();
  });
});
