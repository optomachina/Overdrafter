// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DELIVERY_UNAVAILABLE_REASON,
  QA_UNIT,
  buildSnapshot,
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

  it("keeps only PRs merged inside whole UTC window days", () => {
    expect(merged.map((pr) => pr.number)).toEqual([1, 2, 3, 4, 5, 9]);
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
      "schemaVersion", "generatedAt", "window", "sources", "merges", "qa", "reverts", "timeToMerge", "liveQuotes", "bots",
    ]);
    expect(snapshot).toMatchObject({
      schemaVersion: "trust-snapshot.v1",
      generatedAt: "2026-10-15T23:59:59Z",
      window: { start: "2026-09-28", end: "2026-10-15" },
      sources: { repository: "optomachina/Overdrafter", harnessResultFiles: 1 },
      bots: [],
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
  const offlineArgs = (out) => [
    "--window-start", "2026-09-28", "--window-end", "2026-10-15",
    "--prs-json", fixture("prs.json"), "--comments-json", fixture("comments.json"),
    "--results-jsonl", fixture("results.jsonl"), "--out", out,
  ];
  const noNetwork = () => {
    throw new Error("network fetch attempted");
  };

  it("writes byte-identical files on repeated offline runs without touching the network", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-metrics-"));
    const outputs = ["a.json", "b.json"].map((name) => {
      const out = path.join(dir, name);
      expect(runCli(offlineArgs(out), { fetchInputs: noNetwork, log: () => undefined })).toBe(0);
      return fs.readFileSync(out, "utf8");
    });
    expect(outputs[1]).toBe(outputs[0]);
    expect(JSON.parse(outputs[0]).merges.total).toBe(6);
  });

  it("reads every run's results.jsonl under an artifact root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trust-metrics-root-"));
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
