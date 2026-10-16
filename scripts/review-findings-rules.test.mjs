import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyze, conversionRate, DEFAULT_LEDGER_PATH, main, validateLedger } from "./review-findings-rules.mjs";

const finding = (pr, category, title = "t") => ({ pr, reviewer: "opus", severity: "medium", category, file: "a.ts", title });
const entry = (category, status, extra = {}) => ({
  category, first_seen: 1, second_seen: 2, task: "OVD-1", rule_type: "lint", status, converted_by: null, ...extra,
});

describe("review findings to rules", () => {
  it("flags categories seen in two distinct PRs that are not in the ledger", () => {
    const result = analyze(
      [finding(10, "test-gap"), finding(12, "Test Gap"), finding(12, "naming-style"), finding(13, "naming-style")],
      { entries: [entry("naming-style", "open")] },
    );
    expect(result.needsTask.map((item) => item.category)).toEqual(["test-gap"]);
    expect(result.needsTask[0]).toMatchObject({ first_seen: 10, second_seen: 12, taxonomy: true });
  });

  it("does not count repeats within a single PR", () => {
    const result = analyze([finding(5, "docs-drift"), finding(5, "docs-drift")], { entries: [] });
    expect(result.needsTask).toEqual([]);
  });

  it("marks categories outside the taxonomy", () => {
    const result = analyze([finding(1, "weird"), finding(2, "weird")], { entries: [] });
    expect(result.needsTask[0].taxonomy).toBe(false);
  });

  it("computes conversion as converted over opened", () => {
    expect(conversionRate([])).toEqual({ opened: 0, converted: 0, rate: null });
    const rate = conversionRate([entry("a", "converted", { converted_by: "PR 9" }), entry("b", "open"), entry("c", "wontfix")]);
    expect(rate).toEqual({ opened: 3, converted: 1, rate: 1 / 3 });
  });

  it("validates ledger entries", () => {
    expect(validateLedger({ entries: [entry("a", "converted", { converted_by: "PR 9" })] })).toEqual([]);
    expect(validateLedger({ entries: [entry("a", "converted")] })).toHaveLength(1);
    expect(validateLedger({ entries: [entry("a", "bogus", { rule_type: "x" })] })).toHaveLength(2);
    expect(validateLedger({ entries: [entry("a", "open"), entry("A", "open")] })).toHaveLength(1);
    expect(validateLedger({})).toHaveLength(1);
  });

  it("ships a valid empty ledger", () => {
    expect(validateLedger(JSON.parse(readFileSync(DEFAULT_LEDGER_PATH, "utf8")))).toEqual([]);
  });

  describe("cli", () => {
    const run = (argv) => {
      const out = [];
      const code = main(argv, { log: (m) => out.push(m), error: (m) => out.push(m) });
      return { code, text: out.join("\n") };
    };

    it("reports and optionally fails on needs-task categories", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "rfr-"));
      try {
        const findings = path.join(dir, "f.json");
        writeFileSync(findings, JSON.stringify([finding(1, "performance"), finding(2, "performance")]));
        const ledger = path.join(dir, "l.json");
        writeFileSync(ledger, JSON.stringify({ version: 1, entries: [] }));
        const report = run(["--findings", findings, "--ledger", ledger]);
        expect(report.code).toBe(0);
        expect(report.text).toContain("needs task: performance");
        expect(report.text).toContain("conversion: 0/0 (n/a)");
        expect(run(["--findings", findings, "--ledger", ledger, "--fail-on-needs-task"]).code).toBe(1);
        expect(JSON.parse(run(["--findings", findings, "--ledger", ledger, "--json"]).text).needsTask).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects bad usage", () => {
      expect(run([]).code).toBe(2);
      expect(run(["--nope"]).code).toBe(2);
      expect(run(["--findings", "/nonexistent.json"]).code).toBe(2);
    });
  });
});
