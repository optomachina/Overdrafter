import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, conversionRate, DEFAULT_LEDGER_PATH, main, normalizePr, resolveDefaultLedgerPath, validateFindings, validateLedger } from "./review-findings-rules.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    const rate = conversionRate([entry("test-gap", "converted", { converted_by: "PR 9" }), entry("performance", "open"), entry("docs-drift", "wontfix")]);
    expect(rate).toEqual({ opened: 3, converted: 1, rate: 1 / 3 });
  });

  it("validates ledger entries", () => {
    expect(validateLedger({ entries: [entry("test-gap", "converted", { converted_by: "PR 9" })] })).toEqual([]);
    expect(validateLedger({ entries: [entry("test-gap", "converted")] })).toHaveLength(1);
    expect(validateLedger({ entries: [entry("test-gap", "bogus", { rule_type: "x" })] })).toHaveLength(2);
    expect(validateLedger({ entries: [entry("test-gap", "open"), entry("Test-Gap", "open")] })).toHaveLength(1);
    expect(validateLedger({})).toHaveLength(1);
  });

  it("validates ledger taxonomy, PRs, task id and converted_by", () => {
    expect(validateLedger({ entries: [entry("typo-cat", "open")] })).toHaveLength(1);
    expect(validateLedger({ entries: [entry("test-gap", "open", { second_seen: 1 })] })).toHaveLength(1);
    expect(validateLedger({ entries: [entry("test-gap", "open", { first_seen: "x" })] })).toHaveLength(1);
    expect(validateLedger({ entries: [entry("test-gap", "open", { task: "free text" })] })).toHaveLength(1);
    expect(validateLedger({ entries: [entry("test-gap", "open", { converted_by: "PR 9" })] })).toHaveLength(1);
    expect(validateLedger({ entries: [null] })).toHaveLength(1);
  });

  it("treats 1 and \"1\" as the same PR", () => {
    expect(normalizePr(" 7 ")).toBe(7);
    expect(normalizePr(0)).toBeNull();
    expect(normalizePr(1.5)).toBeNull();
    expect(normalizePr("abc")).toBeNull();
    expect(normalizePr(null)).toBeNull();
    expect(analyze([finding(1, "test-gap"), finding("1", "test-gap")], { entries: [] }).needsTask).toEqual([]);
    const result = analyze([finding("2", "test-gap"), finding(10, "test-gap")], { entries: [] });
    expect(result.needsTask[0]).toMatchObject({ prs: [2, 10], first_seen: 2, second_seen: 10 });
  });

  it("reports malformed findings", () => {
    expect(validateFindings([finding(1, "test-gap")])).toEqual([]);
    expect(validateFindings([{ category: "other" }])).toHaveLength(1);
    expect(validateFindings([{ pr: 1 }])).toHaveLength(1);
    expect(validateFindings([{ pr_number: 1, category: "other" }])).toHaveLength(1);
    expect(validateFindings([null, "s", []])).toHaveLength(3);
  });

  it("rejects finding categories outside the taxonomy but accepts other", () => {
    expect(validateFindings([finding(1, "typo-cat")])).toHaveLength(1);
    expect(validateFindings([finding(1, "Test Gap"), finding(2, "other")])).toEqual([]);
  });

  it("routes repeated other findings to recategorize, not needs task", () => {
    const result = analyze([finding(1, "other", "a"), finding(2, "other", "b")], { entries: [] });
    expect(result.needsTask).toEqual([]);
    expect(result.recategorize).toHaveLength(1);
    expect(result.recategorize[0]).toMatchObject({ category: "other", prs: [1, 2] });
  });

  it("ships a valid empty ledger", () => {
    expect(validateLedger(JSON.parse(readFileSync(path.join(repoRoot, DEFAULT_LEDGER_PATH), "utf8")))).toEqual([]);
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

    const withFiles = (findings, ledger, fn) => {
      const dir = mkdtempSync(path.join(tmpdir(), "rfr-"));
      try {
        const f = path.join(dir, "f.json");
        const l = path.join(dir, "l.json");
        writeFileSync(f, typeof findings === "string" ? findings : JSON.stringify(findings));
        writeFileSync(l, JSON.stringify(ledger));
        return fn(f, l);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const emptyLedger = { version: 1, entries: [] };

    it("prints titles in the text report and full shape in --json", () => {
      withFiles([finding(1, "performance", "N+1 in list"), finding(2, "performance", "slow loop")], emptyLedger, (f, l) => {
        expect(run(["--findings", f, "--ledger", l]).text).toContain("  - N+1 in list");
        const json = JSON.parse(run(["--findings", f, "--ledger", l, "--json"]).text);
        expect(json.needsTask[0]).toMatchObject({ category: "performance", titles: ["N+1 in list", "slow loop"] });
        expect(json.conversion).toEqual({ opened: 0, converted: 0, rate: null });
        expect(json.recategorize).toEqual([]);
      });
    });

    it("exits 2 on malformed findings instead of silently dropping them", () => {
      withFiles([{ pr_number: 1, category: "test-gap" }, null], emptyLedger, (f, l) => {
        const result = run(["--findings", f, "--ledger", l, "--fail-on-needs-task"]);
        expect(result.code).toBe(2);
        expect(result.text).toContain("findings[0].pr");
        expect(result.text).toContain("findings[1] must be an object");
      });
    });

    it("exits 2 on an invalid ledger", () => {
      withFiles([finding(1, "test-gap")], { entries: [entry("bogus", "open")] }, (f, l) => {
        const result = run(["--findings", f, "--ledger", l]);
        expect(result.code).toBe(2);
        expect(result.text).toContain("ledger:");
      });
    });

    it("exits 2 on non-array findings", () => {
      withFiles({ pr: 1 }, emptyLedger, (f, l) => {
        const result = run(["--findings", f, "--ledger", l]);
        expect(result.code).toBe(2);
        expect(result.text).toContain("findings must be a JSON array");
      });
    });

    it("exits 2 on a finding category outside the taxonomy", () => {
      withFiles([finding(1, "weird"), finding(2, "weird")], emptyLedger, (f, l) => {
        const result = run(["--findings", f, "--ledger", l]);
        expect(result.code).toBe(2);
        expect(result.text).toContain("not in the taxonomy");
      });
    });

    it("finds the default ledger from a repo subdirectory", () => {
      withFiles([finding(1, "performance")], emptyLedger, (f) => {
        const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/review-findings-rules.mjs"), "--findings", f], {
          cwd: path.join(repoRoot, "scripts"),
          encoding: "utf8",
        });
        expect(result.stderr).not.toContain("cannot read input");
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("conversion:");
      });
    });

    it("resolves the default ledger from the script's repo root regardless of cwd", () => {
      const originalCwd = process.cwd();
      const elsewhere = mkdtempSync(path.join(tmpdir(), "rfr-cwd-"));
      try {
        process.chdir(elsewhere);
        expect(resolveDefaultLedgerPath()).toBe(path.join(repoRoot, "docs", "review-findings-ledger.json"));
      } finally {
        process.chdir(originalCwd);
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it("does not shell out to resolve the ledger path (Sonar S4036)", () => {
      const source = readFileSync(path.join(repoRoot, "scripts/review-findings-rules.mjs"), "utf8");
      expect(source).not.toMatch(/child_process/);
    });

    it("rejects bad usage with a message", () => {
      expect(run([])).toMatchObject({ code: 2 });
      expect(run([]).text).toContain("usage:");
      expect(run(["--nope"]).text).toContain("unknown argument: --nope");
      const missing = run(["--findings", "/nonexistent.json"]);
      expect(missing.code).toBe(2);
      expect(missing.text).toContain("cannot read input");
    });
  });
});
