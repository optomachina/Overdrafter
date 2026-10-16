#!/usr/bin/env node
// Judges verify-overdrafter evidence into verify-result.json (OVD-843).
// CI runs this from the BASE checkout so a PR cannot weaken how it is judged.
//   node scripts/verify-result-judge.mjs --expected-sha SHA --out verify-result.json <evidence-dir>...
// Each evidence dir holds manifest.txt and playwright-report.json from verify.sh.
// Fails closed: anything other than every listed spec running and every journey
// passing at the expected SHA is FAIL. Exit 0 on PASS, 1 on FAIL, 2 on bad usage.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESULT_STATUS = { passed: "passed", failed: "failed", timedOut: "timedOut", interrupted: "cancelled", skipped: "skipped" };

export function parseManifest(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    const m = /^([a-z ]+):\s?(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return {
    mode: fields.mode ?? null,
    features: fields.features ?? null,
    specs: fields.specs ? fields.specs.split(/\s+/).filter(Boolean) : [],
    gitHead: fields["git head"] ?? null,
    exitCode: fields["exit code"] === undefined ? null : Number(fields["exit code"]),
  };
}

function testStatus(test) {
  if (test.status === "skipped") return "skipped";
  if (test.expectedStatus && test.expectedStatus !== "passed") return "expected-failure";
  const last = test.results?.at(-1);
  if (!last) return "not-run";
  const status = RESULT_STATUS[last.status] ?? last.status;
  return status === "passed" && test.status === "flaky" ? "flaky" : status;
}

/** Flattens a Playwright JSON report into one journey per test, file-relative to testDir. */
export function collectJourneys(report) {
  const out = [];
  const walk = (suite, titles, file) => {
    const nextFile = suite.file ?? file;
    const nextTitles = suite.title && suite.title !== nextFile ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const project = test.projectName ? `[${test.projectName}] ` : "";
        const name = `${project}${[spec.file ?? nextFile, ...nextTitles, spec.title].join(" › ")}`;
        out.push({ name, file: spec.file ?? nextFile, status: testStatus(test) });
      }
    }
    for (const child of suite.suites ?? []) walk(child, nextTitles, nextFile);
  };
  for (const suite of report.suites ?? []) walk(suite, [], suite.file);
  return out;
}

const specMatches = (spec, file) => Boolean(file) && (spec === file || spec.endsWith(`/${file}`));

/** Judges one evidence run; `manifestText`/`reportText` are null when the file is missing. */
export function judgeRun({ label, manifestText, reportText, expectedSha }) {
  const reasons = [];
  const run = { label, mode: null, features: null, gitHead: null, exitCode: null, specs: [], journeys: [] };
  if (manifestText == null) {
    reasons.push(`${label}: manifest.txt missing`);
  } else {
    Object.assign(run, parseManifest(manifestText));
    if (!run.gitHead) reasons.push(`${label}: manifest has no git head`);
    else if (run.gitHead !== expectedSha) reasons.push(`${label}: SHA mismatch (tested ${run.gitHead}, expected ${expectedSha})`);
    if (run.exitCode !== 0) reasons.push(`${label}: playwright exit code ${run.exitCode ?? "missing"}`);
    if (run.specs.length === 0) reasons.push(`${label}: manifest lists no specs`);
  }
  if (reportText == null) {
    reasons.push(`${label}: playwright-report.json missing`);
    return { run, reasons };
  }
  let report;
  try {
    report = JSON.parse(reportText);
  } catch {
    reasons.push(`${label}: playwright-report.json is not valid JSON`);
    return { run, reasons };
  }
  for (const error of report.errors ?? []) {
    reasons.push(`${label}: playwright error: ${String(error.message ?? error).split("\n")[0]}`);
  }
  run.journeys = collectJourneys(report).map((j) => ({ ...j, mode: run.mode ?? label }));
  if (run.journeys.length === 0) reasons.push(`${label}: no journeys ran`);
  for (const spec of run.specs) {
    if (!run.journeys.some((j) => specMatches(spec, j.file))) reasons.push(`${label}: no journeys ran for ${spec}`);
  }
  for (const j of run.journeys) {
    if (j.status !== "passed") reasons.push(`${label}: ${j.status}: ${j.name}`);
  }
  return { run, reasons };
}

export function judge({ runs, expectedSha }) {
  const reasons = [];
  if (!expectedSha) reasons.push("no expected head SHA given");
  if (runs.length === 0) reasons.push("no evidence directories given");
  const judged = runs.map((r) => judgeRun({ ...r, expectedSha }));
  for (const j of judged) reasons.push(...j.reasons);
  const journeys = judged.flatMap((j) => j.run.journeys);
  return {
    schema: "verify-result/v1",
    verdict: reasons.length === 0 ? "PASS" : "FAIL",
    expectedSha: expectedSha ?? null,
    headShas: [...new Set(judged.map((j) => j.run.gitHead).filter(Boolean))],
    runs: judged.map(({ run }) => ({
      label: run.label, mode: run.mode, features: run.features, gitHead: run.gitHead, exitCode: run.exitCode, specs: run.specs,
    })),
    journeys,
    failingJourneys: journeys.filter((j) => j.status !== "passed").map((j) => `${j.mode}: ${j.name} (${j.status})`),
    reasons,
  };
}

export function formatSummary(result) {
  const lines = [`## verify-overdrafter: ${result.verdict}`, "", `Expected head SHA: \`${result.expectedSha ?? "none"}\``];
  const passed = result.journeys.filter((j) => j.status === "passed").length;
  lines.push(`Journeys passed: ${passed}/${result.journeys.length}`);
  if (result.reasons.length) lines.push("", "### Why it failed", ...result.reasons.map((r) => `- ${r}`));
  return `${lines.join("\n")}\n`;
}

const readOrNull = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);

export function main(argv) {
  let expectedSha = null;
  let out = null;
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--expected-sha") expectedSha = argv[++i] || null;
    else if (argv[i] === "--out") out = argv[++i];
    else dirs.push(argv[i]);
  }
  if (!out) {
    console.error("usage: verify-result-judge.mjs --expected-sha SHA --out verify-result.json <evidence-dir>...");
    return 2;
  }
  const runs = dirs.map((dir) => ({
    label: path.basename(dir),
    manifestText: readOrNull(path.join(dir, "manifest.txt")),
    reportText: readOrNull(path.join(dir, "playwright-report.json")),
  }));
  const result = judge({ runs, expectedSha });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(formatSummary(result));
  return result.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
