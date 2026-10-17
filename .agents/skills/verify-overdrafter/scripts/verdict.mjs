#!/usr/bin/env node
// Counts Playwright JSON report results and turns them into a fail-closed verdict.
// Usage: verdict.mjs <exit code>:<report.json> [...]  (one pair per playwright run)
// Prints "tests: ..." and "verdict: ..." lines; exits 0 PASS, 1 FAIL, 3 INCOMPLETE.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ZERO = { passed: 0, failed: 0, skipped: 0, expectedFail: 0, flaky: 0 };

export function countResults(report) {
  if (!report || !Array.isArray(report.suites)) throw new Error("not a Playwright JSON report");
  const c = { ...ZERO };
  const walk = (suite) => {
    for (const s of suite.specs ?? []) {
      for (const t of s.tests ?? []) {
        if (t.status === "skipped") c.skipped++;
        else if (t.status === "expected" && t.expectedStatus === "failed") c.expectedFail++;
        else if (t.status === "expected") c.passed++;
        else if (t.status === "flaky") c.flaky++;
        else c.failed++;
      }
    }
    (suite.suites ?? []).forEach(walk);
  };
  report.suites.forEach(walk);
  return c;
}

export function addCounts(a, b) {
  return Object.fromEntries(Object.keys(ZERO).map((k) => [k, a[k] + b[k]]));
}

export function formatCounts(counts) {
  return counts ? Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") : "unavailable";
}

// counts === null means a report was missing or unreadable.
export function verdict({ exitCodes, counts }) {
  if (exitCodes.some((c) => c !== 0) || (counts && counts.failed > 0)) return "FAIL";
  if (!counts) return "INCOMPLETE";
  if (counts.passed === 0 || counts.skipped > 0 || counts.flaky > 0) return "INCOMPLETE";
  return "PASS";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCodes = [];
  let counts = { ...ZERO };
  const runs = process.argv.slice(2);
  if (runs.length === 0) counts = null;
  for (const arg of runs) {
    const i = arg.indexOf(":");
    exitCodes.push(Number(arg.slice(0, i)));
    if (!counts) continue;
    try {
      counts = addCounts(counts, countResults(JSON.parse(readFileSync(arg.slice(i + 1), "utf8"))));
    } catch {
      counts = null;
    }
  }
  const v = verdict({ exitCodes, counts });
  console.log(`tests: ${formatCounts(counts)}`);
  console.log(`verdict: ${v}`);
  process.exit({ PASS: 0, FAIL: 1, INCOMPLETE: 3 }[v]);
}
