// @vitest-environment node
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, resolveBin } from "./spend-ledger.mjs";
import { POOLS, UsageError, usageToLedger, parseLines, uniqueUsage, validateLedger, mergeLedger, jsonl, isoWeek, weeklyReport, parseAttribution, attributePR, exportEvals, markdownReport } from "./lib/spend-ledger.mjs";

const fixture = fileURLToPath(new URL("./fixtures/spend-ledger/", import.meta.url));
const usage = (extra = {}) => ({ schema: "token-watcher-usage.v1", pool: "codex", period: "2026-10-05", dollars: 1, source: "synthetic", ...extra });
const row = (extra = {}) => usageToLedger(usage(extra));
const pr = (number = 100, extra = {}) => ({ number, mergedAt: "2026-10-05T12:00:00Z", labels: ["pool:codex"], ...extra });
const report = (extra = {}) => weeklyReport({ ledger: [row()], prs: [pr()], from: "2026-10-05", to: "2026-10-05", ...extra });
const readFixture = (name) => fs.readFileSync(path.join(fixture, name), "utf8");

// Each CLI test owns and removes its temporary directory; gh is always injected.
function withCLI(test) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-ledger-test-"));
  const ledger = path.join(dir, "nested/ledger.jsonl");
  let out = "", err = "";
  const invoke = (args, extra = {}) => {
    out = ""; err = "";
    const code = main(args, { cwd: dir, repoRoot: dir, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, runGh: () => { throw new Error("Unexpected gh call"); }, ...extra });
    return { code, out, err };
  };
  try { test({ dir, ledger, invoke }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe("usage validation and collection", () => {
  it.each([
    { schema: "wrong" }, { pool: "other" }, { period: "2026-02-30" },
    { subscriptionShare: 0.5, subscriptionUsd: 100 },
    { dollars: null, subscriptionShare: 2, subscriptionUsd: 100 },
    { dollars: null, subscriptionShare: 0.5 }, { dollars: -1 },
    { dollars: "Infinity" }, { pr: 0 }, { pr: 1.5 }, { issue: "bad" },
    { source: " " }, { tokens: { input: -1 } }, { tokens: "100" }, { bot: 100 },
  ])("rejects invalid usage %j with location", (extra) => {
    expect(() => parseLines(JSON.stringify(usage(extra)), "usage.jsonl", usageToLedger)).toThrow("usage.jsonl:1:");
  });
  it("values subscriptions, metered and unknown usage without leaking extra fields", () => {
    expect(row({ dollars: null, subscriptionShare: 0.025, subscriptionUsd: 100 }).usd).toBe(2.5);
    expect(row({ dollars: 0 }).usd).toBe(0);
    expect(row({ dollars: null }).usd).toBeNull();
    const value = row({ apiKey: "DO-NOT-COPY", source: "x".repeat(100), bot: "b".repeat(100), model: "m".repeat(100) });
    expect(JSON.stringify(value)).not.toContain("DO-NOT-COPY");
    expect(value.source).toHaveLength(64);
    expect(value.agent).toHaveLength(64);
    expect(value.model).toHaveLength(64);
    expect(validateLedger(value, "ledger:1")).toEqual(value);
    expect(() => validateLedger({ ...value, usd: -1 }, "ledger:2")).toThrow("ledger:2");
    expect(() => usageToLedger(usage({ dollars: Infinity }), "usage:2")).toThrow("usage:2");
    expect(() => validateLedger({ ...row({ dollars: null }), valuation: "metered" }, "ledger:3")).toThrow("ledger:3");
  });
  it("merges idempotently with canonical ordering and replaces old values", () => {
    const a = row({ tokens: { output: 200, input: 1000 } });
    const b = row({ pool: "jev" });
    expect(jsonl(mergeLedger([], [b, a]))).toBe(jsonl(mergeLedger([a], [a, b])));
    expect(jsonl([a])).toBe(jsonl([row({ tokens: { input: 1000, output: 200 } })]));
    expect(mergeLedger([a], [row({ dollars: 10 })])[0].usd).toBe(10);
    expect(() => uniqueUsage([a, a], "usage:2")).toThrow("usage:2: duplicate");
    expect(() => parseLines("{", "usage", usageToLedger)).toThrow("usage:1: invalid JSON");
  });
});

describe("weekly metrics", () => {
  it("uses ISO year boundaries and clips overlapping weeks", () => {
    expect(isoWeek("2027-01-03")).toEqual({ week: "2026-W53", weekStart: "2026-12-28", weekEnd: "2027-01-03" });
    const result = report({ from: "2026-12-30", to: "2027-01-04" });
    expect(result.weeks.map((w) => [w.week, w.daysInWindow])).toEqual([["2026-W53", 5], ["2027-W01", 1]]);
  });
  it("distinguishes missing, partial, zero spend and no merges", () => {
    const result = report({ to: "2026-10-06" });
    expect(result.totals.pools[0]).toMatchObject({ coverage: "partial", partial: true, lowerBound: true, usd: 1, status: "low-sample", missingDays: ["2026-10-06"] });
    expect(result.totals.pools[1]).toMatchObject({ usd: null, status: "unknown", coverage: "missing" });
    expect(result.totals.overall).toMatchObject({ lowerBound: true, flags: ["low-sample", "partial"], missingPools: ["claude", "cursor", "jev"] });
    expect(report({ prs: [] }).totals.pools[0]).toMatchObject({ status: "no-merges", usdPerMergedPR: null });
    expect(report({ ledger: [row({ dollars: 0 })] }).totals.pools[0]).toMatchObject({ usd: 0, usdPerMergedPR: 0 });
    expect(report({ ledger: [row({ dollars: null })] }).totals.pools[0]).toMatchObject({ usd: null, recordsUnvalued: 1, daysWithData: 1, daysWithValuedData: 0 });
    expect(markdownReport(report({ ledger: [] }))).not.toContain("$0.00");
    expect(markdownReport(result)).toContain("≥ $1.00 (partial)");
    expect(markdownReport(report({ prs: [] }))).toContain("n/a (no merges)");
  });
  it("computes complete coverage, half-up cents and all PR denominators", () => {
    const result = report({ ledger: POOLS.map((pool) => row({ pool, dollars: 10 })), prs: [pr(), pr(200, { labels: [] })], minSample: 1 });
    expect(result.totals.overall).toMatchObject({ totalUsd: 40, mergedPRs: 2, unattributedPRs: 1, usdPerMergedPR: 20, status: "ok", missingPools: [], partialPools: [] });
    expect(result.totals.pools[0]).toMatchObject({ coverage: "complete", status: "ok", usdPerMergedPR: 10 });
    expect(report({ ledger: [row({ dollars: 1.005 })] }).totals.pools[0].usdPerMergedPR).toBe(1.01);
  });
  it("attributes direct and unique issue spend but leaves shared issues and overhead in totals", () => {
    const result = report({ prs: [pr(100, { title: "ovd-100 OVD-200" }), pr(200, { body: "OVD-200" })], ledger: [row({ issue: "OVD-100" }), row({ issue: "OVD-200", dollars: 10 }), row({ pr: 100, dollars: 2.5 }), row({ dollars: 10 })] });
    expect(result.prs[0].attributedUsd).toBe(3.5);
    expect(result.prs[1].attributedUsd).toBeNull();
    expect(result.totals.attributedUsd).toBe(3.5);
    expect(result.totals.overall.totalUsd).toBe(23.5);
    const outside = report({ ledger: [row({ issue: "OVD-100" })], prs: [pr(100, { title: "OVD-100" }), pr(200, { title: "OVD-100", mergedAt: "2026-10-12T00:00:00Z" })] });
    expect(outside.totals.attributedUsd).toBe(0);
    const later = report({ to: "2026-10-12", ledger: [row({ pr: 100 })], prs: [pr(100, { mergedAt: "2026-10-12T00:00:00Z" })] });
    expect(later.weeks[0].attributedUsd).toBe(1);
  });
  it("is byte deterministic under reordered inputs and rejects bad report inputs", () => {
    const ledger = POOLS.map((pool) => row({ pool }));
    const prs = [pr(), pr(200)];
    expect(JSON.stringify(report({ ledger, prs }))).toBe(JSON.stringify(report({ ledger: [...ledger].reverse(), prs: [...prs].reverse() })));
    for (const extra of [{ from: "bad" }, { to: "2026-01-01" }, { minSample: 0 }, { generatedAt: "bad" }, { prs: [pr(), pr()] }]) expect(() => report(extra)).toThrow(UsageError);
  });
});

describe("PR attribution and evals export", () => {
  it.each([
    [{ "100": "codex" }, [], "codex", "explicit"],
    [{}, ["model:claude"], "claude", "explicit"],
    [{ "100": { bot: "opus" } }, [], "claude", "explicit"],
    [{ "100": { bot: "Sonnet" } }, [], "claude", "explicit"],
    [{}, ["model:opus"], "claude", "explicit"],
    [{}, ["model:sonnet"], "claude", "explicit"],
    [{}, ["model:opus", "model:claude"], "claude", "explicit"],
    [{}, ["model:opus", "model:codex"], "unknown", "conflicting"],
    [{ "100": { bot: "grok" } }, [], "cursor", "explicit"],
    [{ "100": "codex" }, ["pool:claude"], "unknown", "conflicting"],
    [{ "100": "unknown" }, [], "unknown", "explicit"],
    [{}, ["pool:jev", "pool:codex"], "unknown", "conflicting"],
    [{}, [], "unknown", "no_signal"],
  ])("resolves signals %j %j", (input, labels, pool, attributionStatus) => {
    expect(attributePR(pr(100, { labels }), parseAttribution(input))).toEqual({ pool, attributionStatus });
  });
  it("validates wrapped attribution and produces only evals-compatible valued lines", () => {
    expect(parseAttribution(JSON.parse(readFixture("attribution.json")))[100].pool).toBe("codex");
    expect(() => parseAttribution({ schema: "bad" })).toThrow(UsageError);
    const lines = exportEvals([row({ pr: 100, issue: "OVD-100", bot: "writer" }), row({ pool: "jev", dollars: null })]);
    expect(lines).toHaveLength(1);
    for (const line of parseLines(jsonl(lines), "export")) {
      expect(Number.isFinite(line.usd) && line.usd >= 0).toBe(true);
      expect(Number.isFinite(Date.parse(line.ts))).toBe(true);
      expect(line).toMatchObject({ pr: 100, issue: "OVD-100", agent: "writer" });
      expect(line).not.toHaveProperty("tokens");
      expect(line).toMatchObject({ exportUnvaluedRecords: 1, exportComplete: false });
      // PR #835 loadLedger acceptance rule; extra fields are ignored.
      expect(Number.isFinite(Date.parse(line.ts)) && Number.isFinite(line.usd) && line.usd >= 0
        && (line.pr == null || (Number.isInteger(line.pr) && line.pr > 0))
        && (line.issue == null || /^OVD-\d+$/.test(line.issue))).toBe(true);
    }
  });
});

describe("CLI with local files and injected gh", () => {
  it("handles help, usage, validation and file failures", () => withCLI(({ dir, ledger, invoke }) => {
    expect(invoke(["--help"]).code).toBe(0);
    expect(invoke(["bad"]).code).toBe(2);
    expect(invoke(["collect", "--wrong"]).code).toBe(2);
    expect(invoke(["collect", "--input"]).code).toBe(2);
    expect(invoke(["collect", "--input", "absent"]).code).toBe(1);
    const input = path.join(dir, "input.jsonl");
    fs.writeFileSync(input, jsonl([usage(), usage({ dollars: 10 })]));
    const result = invoke(["collect", "--input", input, "--ledger", ledger]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(`${input}:2: duplicate`);
    expect(fs.existsSync(ledger)).toBe(false);
  }));
  it("collects atomically, supports dry run, replacement, weekly fixtures and export", () => withCLI(({ dir, ledger, invoke }) => {
    const collect = ["collect", "--input", path.join(fixture, "usage.jsonl"), "--ledger", ledger];
    expect(invoke([...collect, "--dry-run"]).code).toBe(0);
    expect(fs.existsSync(ledger)).toBe(false);
    expect(invoke(collect).code).toBe(0);
    const first = fs.readFileSync(ledger, "utf8");
    expect(invoke(collect).code).toBe(0);
    expect(fs.readFileSync(ledger, "utf8")).toBe(first);
    const args = ["weekly", "--ledger", ledger, "--from", "2026-10-05", "--to", "2026-10-11", "--prs-json", path.join(fixture, "prs.json"), "--attribution", path.join(fixture, "attribution.json")];
    const result = invoke(args);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ schema: "spend-per-pr.v1", sources: { ledgerFiles: 1, ledgerLines: 4, prSource: "prs-json", attributionLoaded: true }, totals: { attributedUsd: 3.5, overall: { mergedPRs: 3, totalUsd: 13.5 } } });
    expect(invoke(args).out).toBe(result.out);
    expect(invoke([...args, "--format", "md"]).out).toContain("| Pool |");
    const exported = invoke(["export-evals", "--ledger", ledger]);
    expect(exported.code).toBe(0);
    expect(parseLines(exported.out, "evals")).toHaveLength(3);
    expect(exported.err).toContain("Skipped 1 unvalued");
    const out = path.join(dir, "export.jsonl");
    expect(invoke(["export-evals", "--ledger", ledger, "--out", out]).code).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toBe(exported.out);
    const input = path.join(dir, "replace.jsonl");
    fs.writeFileSync(input, jsonl([usage({ source: "synthetic", dollars: 10, issue: "OVD-100" })]));
    expect(invoke(["collect", "--input", input, "--ledger", ledger]).code).toBe(0);
    expect(parseLines(fs.readFileSync(ledger, "utf8"), ledger).find((r) => r.pool === "codex").usd).toBe(10);
  }));
  it("uses repo-root default ledger and injected live gh with truncation guard", () => withCLI(({ invoke, dir }) => {
    expect(invoke(["collect", "--input", path.join(fixture, "usage.jsonl")]).code).toBe(0);
    expect(fs.existsSync(path.join(dir, "evals/spend-ledger/ledger.jsonl"))).toBe(true);
    const args = ["weekly", "--from", "2026-10-05", "--to", "2026-10-11", "--repo", "synthetic/repo"];
    let argv;
    const result = invoke(args, { runGh: (value) => { argv = value; return readFixture("prs.json"); } });
    expect(result.code).toBe(0);
    expect(argv).toContain("synthetic/repo");
    expect(argv).toContain("merged:2026-10-05..2026-10-11");
    expect(JSON.parse(result.out).sources.prSource).toBe("gh");
    expect(invoke(args, { runGh: () => Array.from({ length: 1000 }, (_, i) => pr(i + 1)) }).code).toBe(1);
    expect(invoke([...args, "--from", "bad"]).code).toBe(2);
  }));
});

describe("export completeness and executable resolution", () => {
  it("rejects model aliases as explicit pools", () => {
    for (const pool of ["opus", "sonnet"]) expect(() => parseAttribution({ 100: { pool } })).toThrow(UsageError);
  });
  it("marks every exported line and accepts all-valued and empty inputs", () => {
    const valued = [row({ pr: 100 }), row({ pool: "claude", issue: "OVD-932" })];
    for (const line of exportEvals([...valued, row({ pool: "jev", dollars: null })])) {
      expect(line).toMatchObject({ exportUnvaluedRecords: 1, exportComplete: false });
      expect(Number.isFinite(Date.parse(line.ts)) && Number.isFinite(line.usd) && line.usd >= 0
        && (line.pr == null || (Number.isInteger(line.pr) && line.pr > 0))
        && (line.issue == null || /^OVD-\d+$/.test(line.issue))).toBe(true);
    }
    for (const line of exportEvals(valued)) expect(line).toMatchObject({ exportUnvaluedRecords: 0, exportComplete: true });
    expect(exportEvals([])).toEqual([]);
  });
  it("exits 3 for all-unvalued exports to stdout or file, and 0 for empty ledgers", () => withCLI(({ dir, ledger, invoke }) => {
    fs.mkdirSync(path.dirname(ledger));
    fs.writeFileSync(ledger, jsonl([row({ dollars: null })]));
    const args = ["export-evals", "--ledger", ledger];
    const result = invoke(args);
    expect(result).toMatchObject({ code: 3, out: "" });
    expect(result.err).toContain("Skipped 1 unvalued lines");
    expect(result.err).toContain("No valued records to export; 1 unvalued");
    const out = path.join(dir, "empty.jsonl");
    expect(invoke([...args, "--out", out]).code).toBe(3);
    expect(fs.readFileSync(out, "utf8")).toBe("");
    fs.writeFileSync(ledger, "");
    expect(invoke(args)).toMatchObject({ code: 0, out: "" });
  }));
  it("resolves only absolute standard executable paths or null", () => {
    for (const name of ["git", "gh"]) {
      const binary = resolveBin(name);
      if (binary !== null) {
        expect(path.isAbsolute(binary)).toBe(true);
        expect(["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"]).toContain(path.dirname(binary));
        expect(path.basename(binary)).toBe(name);
      }
      expect(resolveBin(name)).toBe(binary);
    }
    expect(resolveBin("../gh")).toBeNull();
  });
  it("uses absolute gh with a minimal environment and validates dates first", () => withCLI(({ ledger, invoke }) => {
    fs.mkdirSync(path.dirname(ledger));
    fs.writeFileSync(ledger, "");
    const args = ["weekly", "--ledger", ledger, "--from", "2026-10-05", "--to", "2026-10-11"];
    let calls = 0;
    const deps = { runGh: undefined, resolveBin: () => "/usr/bin/gh", execFile: (binary, argv, options) => {
      calls++;
      expect(binary).toBe("/usr/bin/gh");
      expect(argv).toEqual(["pr", "list", "--state", "merged", "--base", "main", "--search", "merged:2026-10-05..2026-10-11", "--limit", "1000", "--json", "number,title,mergedAt,labels,headRefName,body,author"]);
      expect(options.env).toEqual({ PATH: "/usr/bin:/bin", HOME: os.homedir() });
      return "[]";
    } };
    expect(invoke(args, deps).code).toBe(0);
    expect(invoke(args.map((v) => v === "2026-10-05" ? "bad" : v), deps).code).toBe(2);
    expect(calls).toBe(1);
    const missing = invoke(args, { runGh: undefined, resolveBin: () => null });
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("gh was not found in standard locations");
    expect(missing.err).toContain("--prs-json");
  }));
});
