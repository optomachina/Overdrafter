#!/usr/bin/env node
// Judges verify-overdrafter evidence into verify-result.json (OVD-843).
// CI runs this from the BASE checkout, in a job that never runs PR code, so a PR
// cannot weaken how it is judged.
//   node scripts/verify-result-judge.mjs --expected-sha SHA --out verify-result.json
//     [--features auth,quote,provider] [--harness-sha256 EXPECTED --harness-recorded RECORDED]
//     <evidence-dir>...
// Each evidence dir (named after its mode) holds manifest.txt and one
// playwright-report-<i>.json per Playwright config from verify.sh, numbered in the
// order the configs first appear in the feature map. The spec and config lists
// each run must cover come from this checkout's feature map, not from the evidence.
// Each mode covers only the requested features that have specs in that mode; the
// rest are listed as "SKIPPED: no <mode> specs" and never count as a pass. Specs
// the feature map holds as pending (with the issue that unblocks them) are not
// run and are listed as pending, never as passing. Zero selected specs, for a
// mode or across the run, is FAIL.
// Fails closed: anything other than every mapped spec running and every journey
// passing at the expected SHA on a clean tree is FAIL. Exit 0 on PASS, 1 on FAIL,
// 2 on bad usage.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_TEST_DIRS, FEATURE_SPECS, pendingFor, selectFeatures, skipNote, specsFor } from "../.agents/skills/verify-overdrafter/scripts/feature-specs.mjs";

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
    // verify.sh writes "skipped features: a b (SKIPPED: no <mode> specs)" or "none".
    skipped: fields["skipped features"] == null ? null
      : fields["skipped features"] === "none" ? []
      : fields["skipped features"].replace(/\s*\(SKIPPED: no \w+ specs\)$/, "").split(/\s+/).filter(Boolean),
    specs: fields.specs ? fields.specs.split(/\s+/).filter(Boolean) : [],
    configs: fields.configs ? fields.configs.split(/\s+/).filter(Boolean) : [],
    // verify.sh writes "git head: <sha> (clean tree)" or "(dirty tree)".
    gitHead: /^([0-9a-f]{40})\b/.exec(fields["git head"] ?? "")?.[1] ?? null,
    tree: /\((clean|dirty) tree\)/.exec(fields["git head"] ?? "")?.[1] ?? null,
    // One Playwright exit code per config, e.g. "exit codes: 0 0".
    exitCodes: fields["exit codes"] ? fields["exit codes"].split(/\s+/).filter(Boolean).map(Number) : [],
    // verify.sh's own fail-closed verdict (verdict.mjs): PASS, FAIL or INCOMPLETE.
    verdict: fields.verdict ?? null,
  };
}

const REPORT_NAME = /^playwright-report-(\d+)\.json$/;
export const reportName = (i) => `playwright-report-${i}.json`;

/** The feature map's runs for a mode: one per config, in verify.sh's report order. */
export function expectedConfigRuns(features, mode) {
  const runs = new Map();
  for (const { spec, config } of specsFor(features, mode)) {
    if (!runs.has(config)) runs.set(config, []);
    runs.get(config).push(spec);
  }
  return [...runs].map(([config, specs], i) => ({ config, specs, report: reportName(i) }));
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

// Report files are relative to the config's testDir; resolve them exactly.
const specMatches = (spec, file, config) =>
  Boolean(file) && config in CONFIG_TEST_DIRS && spec === path.posix.join(CONFIG_TEST_DIRS[config], file);

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Judges one evidence run. `manifestText` is null when manifest.txt is missing;
 * `reports` maps each playwright-report-<i>.json found in the dir to its text.
 */
export function judgeRun({ label, manifestText, reports = {}, expectedSha, features }) {
  const reasons = [];
  const run = { label, mode: null, features: null, skipped: null, gitHead: null, tree: null, exitCodes: [], verdict: null, specs: [], configs: [], journeys: [] };
  const mode = ["fixture", "local"].includes(label) ? label : null;
  let expected = [];
  let skipped = [];
  if (!mode) reasons.push(`${label}: evidence dir is not named after a mode (fixture or local)`);
  else {
    try {
      skipped = selectFeatures(features, mode).skipped;
      expected = expectedConfigRuns(features, mode);
    } catch (error) {
      reasons.push(`${label}: ${error.message}`);
    }
  }
  if (manifestText == null) {
    reasons.push(`${label}: manifest.txt missing`);
  } else {
    Object.assign(run, parseManifest(manifestText));
    if (!run.gitHead) reasons.push(`${label}: manifest has no git head SHA`);
    else if (run.gitHead !== expectedSha) reasons.push(`${label}: SHA mismatch (tested ${run.gitHead}, expected ${expectedSha})`);
    if (run.tree !== "clean") reasons.push(`${label}: tested tree was ${run.tree ?? "unknown"}, not clean at the head SHA`);
    if (run.exitCodes.length !== expected.length || run.exitCodes.some((c) => c !== 0)) {
      reasons.push(`${label}: playwright exit codes ${run.exitCodes.join(" ") || "missing"}`);
    }
    if (run.verdict !== "PASS") reasons.push(`${label}: verify.sh verdict ${run.verdict ?? "missing"}`);
    if (run.mode !== label) reasons.push(`${label}: manifest mode is ${run.mode ?? "missing"}`);
    if (run.features !== features.join(",")) reasons.push(`${label}: manifest features ${run.features ?? "missing"}, expected ${features.join(",")}`);
    if (run.skipped == null || !sameList(run.skipped, skipped)) {
      reasons.push(`${label}: manifest skipped features ${run.skipped == null ? "missing" : run.skipped.join(" ") || "none"}, expected ${skipped.join(" ") || "none"}`);
    }
    // verify.sh lists specs in feature-map order, not grouped by config.
    const specs = expected.length ? specsFor(features, mode).map((x) => x.spec) : [];
    if (expected.length && !sameList(run.specs, specs)) reasons.push(`${label}: manifest specs differ from the base feature map (${specs.join(" ")})`);
    const configs = expected.map((r) => r.config);
    if (expected.length && !sameList(run.configs, configs)) reasons.push(`${label}: manifest configs differ from the base feature map (${configs.join(" ")})`);
    if (run.specs.length === 0) reasons.push(`${label}: manifest lists no specs`);
  }
  for (const name of Object.keys(reports)) {
    if (!expected.some((r) => r.report === name)) reasons.push(`${label}: unexpected report ${name}`);
  }
  for (const { config, specs, report: name } of expected) {
    const text = reports[name];
    if (text == null) {
      reasons.push(`${label}: ${name} missing (${config})`);
      continue;
    }
    let report;
    try {
      report = JSON.parse(text);
    } catch {
      reasons.push(`${label}: ${name} is not valid JSON`);
      continue;
    }
    for (const error of report.errors ?? []) {
      reasons.push(`${label}: playwright error (${config}): ${String(error.message ?? error).split("\n")[0]}`);
    }
    const journeys = collectJourneys(report).map((j) => ({ ...j, mode: run.mode ?? label, config }));
    if (journeys.length === 0) reasons.push(`${label}: no journeys ran under ${config}`);
    for (const spec of specs) {
      if (!journeys.some((j) => specMatches(spec, j.file, config))) reasons.push(`${label}: no journeys ran for ${spec}`);
    }
    run.journeys.push(...journeys);
  }
  for (const j of run.journeys) {
    if (j.status !== "passed") reasons.push(`${label}: ${j.status}: ${j.name}`);
  }
  return { run, reasons, skipped, specCount: expected.reduce((n, r) => n + r.specs.length, 0) };
}

export function judge({ runs, expectedSha, features = Object.keys(FEATURE_SPECS), harness = null }) {
  const reasons = [];
  if (!expectedSha) reasons.push("no expected head SHA given");
  if (runs.length === 0) reasons.push("no evidence directories given");
  if (harness && (!harness.expected || harness.recorded !== harness.expected)) {
    reasons.push(`harness changed before the journeys ran (ran ${harness.recorded || "unknown"}, base is ${harness.expected || "unknown"})`);
  }
  const judged = runs.map((r) => judgeRun({ ...r, expectedSha, features }));
  for (const j of judged) reasons.push(...j.reasons);
  if (judged.reduce((n, j) => n + j.specCount, 0) === 0) reasons.push("no specs selected across the run");
  const journeys = judged.flatMap((j) => j.run.journeys);
  const modes = judged.map((j) => j.run.label).filter((l) => ["fixture", "local"].includes(l));
  return {
    schema: "verify-result/v1",
    verdict: reasons.length === 0 ? "PASS" : "FAIL",
    expectedSha: expectedSha ?? null,
    features,
    harness,
    headShas: [...new Set(judged.map((j) => j.run.gitHead).filter(Boolean))],
    runs: judged.map(({ run }) => ({
      label: run.label, mode: run.mode, features: run.features, gitHead: run.gitHead, tree: run.tree,
      exitCodes: run.exitCodes, verdict: run.verdict, specs: run.specs, configs: run.configs, skipped: run.skipped,
    })),
    // Features with no specs in a mode: not run there and never counted as a pass.
    skippedFeatures: judged.flatMap((j) => j.skipped.map((f) => `${j.run.label}: ${f} (${skipNote(j.run.label)})`)),
    // Specs held back by the base feature map until their issue lands: not run, never a pass.
    pendingSpecs: modes.flatMap((mode) => pendingFor(features, mode).map((p) => `${mode}: ${p.feature} ${p.spec} (${p.issue}: ${p.reason})`)),
    journeys,
    failingJourneys: journeys.filter((j) => j.status !== "passed").map((j) => `${j.mode}: ${j.name} (${j.status})`),
    reasons,
  };
}

export function formatSummary(result) {
  const lines = [`## verify-overdrafter: ${result.verdict}`, "", `Expected head SHA: \`${result.expectedSha ?? "none"}\``];
  const passed = result.journeys.filter((j) => j.status === "passed").length;
  lines.push(`Journeys passed: ${passed}/${result.journeys.length}`);
  if (result.skippedFeatures?.length) lines.push("", "### Skipped (not run, not counted as passing)", ...result.skippedFeatures.map((s) => `- ${s}`));
  if (result.pendingSpecs?.length) lines.push("", "### Pending (not run, not counted as passing)", ...result.pendingSpecs.map((s) => `- ${s}`));
  if (result.reasons.length) lines.push("", "### Why it failed", ...result.reasons.map((r) => `- ${r}`));
  return `${lines.join("\n")}\n`;
}

const readOrNull = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);

/** Every playwright-report-<i>.json in an evidence dir, by file name. */
export function readReports(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter((f) => REPORT_NAME.test(f)).map((f) => [f, readFileSync(path.join(dir, f), "utf8")]));
}

export function main(argv) {
  let expectedSha = null;
  let out = null;
  let features = Object.keys(FEATURE_SPECS);
  let harness = null;
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--expected-sha") expectedSha = argv[++i] || null;
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--features") features = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (argv[i] === "--harness-sha256") harness = { ...harness, expected: argv[++i] || null };
    else if (argv[i] === "--harness-recorded") harness = { ...harness, recorded: argv[++i] || null };
    else dirs.push(argv[i]);
  }
  const unknown = features.filter((f) => !(f in FEATURE_SPECS));
  if (!out || features.length === 0 || unknown.length) {
    console.error("usage: verify-result-judge.mjs --expected-sha SHA --out verify-result.json [--features a,b] [--harness-sha256 X --harness-recorded Y] <evidence-dir>...");
    return 2;
  }
  const runs = dirs.map((dir) => ({
    label: path.basename(dir),
    manifestText: readOrNull(path.join(dir, "manifest.txt")),
    reports: readReports(dir),
  }));
  const result = judge({ runs, expectedSha, features, harness });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(formatSummary(result));
  return result.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
