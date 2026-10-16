import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CATEGORIES = [
  "type-safety",
  "error-handling",
  "test-gap",
  "security-boundary",
  "data-access",
  "architecture-boundary",
  "naming-style",
  "docs-drift",
  "performance",
  "other",
];
export const RULE_TYPES = ["lint", "test", "ci"];
export const STATUSES = ["open", "converted", "wontfix"];
export const DEFAULT_LEDGER_PATH = "docs/review-findings-ledger.json";

export function normalizeCategory(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** PR numbers compare as positive integers, so 1 and "1" are the same PR. Returns null when invalid. */
export function normalizePr(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim();
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
}

export function validateLedger(ledger) {
  const errors = [];
  if (!ledger || !Array.isArray(ledger.entries)) return ["ledger.entries must be an array"];
  const seen = new Set();
  ledger.entries.forEach((entry, i) => {
    const at = `entries[${i}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${at} must be an object`);
      return;
    }
    const category = normalizeCategory(entry.category);
    if (!category) errors.push(`${at}.category is required`);
    else if (!CATEGORIES.includes(category)) errors.push(`${at}.category "${category}" is not in the taxonomy`);
    else if (seen.has(category)) errors.push(`${at}.category "${category}" is duplicated`);
    seen.add(category);
    const first = normalizePr(entry.first_seen);
    const second = normalizePr(entry.second_seen);
    if (first === null || second === null) errors.push(`${at}.first_seen and second_seen must be PR numbers`);
    else if (first === second) errors.push(`${at}.first_seen and second_seen must be different PRs`);
    if (!/^OVD-\d+$/.test(String(entry.task ?? ""))) errors.push(`${at}.task must look like OVD-123`);
    if (!RULE_TYPES.includes(entry.rule_type)) errors.push(`${at}.rule_type must be one of ${RULE_TYPES.join("|")}`);
    if (!STATUSES.includes(entry.status)) errors.push(`${at}.status must be one of ${STATUSES.join("|")}`);
    if (entry.status === "converted" && !entry.converted_by) errors.push(`${at}.converted_by is required when converted`);
    if (entry.status !== "converted" && entry.converted_by) errors.push(`${at}.converted_by must be empty unless converted`);
  });
  return errors;
}

/** Every finding needs an object shape with a category and a positive-integer PR; anything else is an error. */
export function validateFindings(findings) {
  const errors = [];
  findings.forEach((finding, i) => {
    const at = `findings[${i}]`;
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const category = normalizeCategory(finding.category);
    if (!category) errors.push(`${at}.category is required`);
    else if (!CATEGORIES.includes(category)) errors.push(`${at}.category "${category}" is not in the taxonomy`);
    if (normalizePr(finding.pr) === null) errors.push(`${at}.pr must be a positive integer PR number`);
  });
  return errors;
}

/** Groups findings by category and keeps the distinct PRs each category was seen in. */
export function groupByCategory(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const category = normalizeCategory(finding?.category);
    const pr = normalizePr(finding?.pr);
    if (!category || pr === null) continue;
    if (!groups.has(category)) groups.set(category, new Map());
    const prs = groups.get(category);
    if (!prs.has(pr)) prs.set(pr, []);
    prs.get(pr).push(finding);
  }
  return groups;
}

export function conversionRate(entries) {
  const opened = entries.length;
  const converted = entries.filter((entry) => entry.status === "converted").length;
  return { opened, converted, rate: opened === 0 ? null : converted / opened };
}

export function analyze(findings, ledger) {
  const known = new Set(ledger.entries.map((entry) => normalizeCategory(entry.category)));
  const needsTask = [];
  const recategorize = [];
  for (const [category, prs] of groupByCategory(findings)) {
    if (prs.size < 2 || known.has(category)) continue;
    const distinct = [...prs.keys()].sort((a, b) => a - b);
    const item = {
      category,
      first_seen: distinct[0],
      second_seen: distinct[1],
      prs: distinct,
      taxonomy: CATEGORIES.includes(category),
      titles: [...prs.values()].flat().map((finding) => finding.title).filter(Boolean),
    };
    // "other" is a temporary catch-all: repeats mean "pick a real category", not "open a rule task".
    if (category === "other") recategorize.push(item);
    else needsTask.push(item);
  }
  needsTask.sort((a, b) => a.category.localeCompare(b.category));
  return { needsTask, recategorize, conversion: conversionRate(ledger.entries) };
}

export function formatReport({ needsTask, recategorize = [], conversion }) {
  const lines = [];
  if (needsTask.length === 0) lines.push("No categories need a finding-to-rule task.");
  for (const item of needsTask) {
    const note = item.taxonomy ? "" : " (not in taxonomy)";
    lines.push(`needs task: ${item.category}${note} — seen in PRs ${item.prs.join(", ")}`);
    for (const title of item.titles) lines.push(`  - ${title}`);
  }
  for (const item of recategorize) {
    lines.push(`recategorize: ${item.category} — seen in PRs ${item.prs.join(", ")}; pick a real category`);
    for (const title of item.titles) lines.push(`  - ${title}`);
  }
  const pct = conversion.rate === null ? "n/a" : `${(conversion.rate * 100).toFixed(0)}%`;
  lines.push(`conversion: ${conversion.converted}/${conversion.opened} (${pct})`);
  return lines.join("\n");
}

/**
 * Default ledger lives at the repo root, not under whatever directory the CLI was started from.
 * The root is derived from this script's own location (scripts/ sits one level below it) rather
 * than shelling out to git, so no PATH-resolved subprocess is involved (Sonar S4036).
 */
export function resolveDefaultLedgerPath() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return path.join(root, DEFAULT_LEDGER_PATH);
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  const args = { findings: null, ledger: null, ledgerGiven: false, json: false, failOnNeedsTask: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--findings") args.findings = argv[++i];
    else if (argv[i] === "--ledger") {
      // Track the flag itself: a trailing `--ledger` (value undefined) must still fail closed, not fall back to the default.
      args.ledgerGiven = true;
      args.ledger = argv[++i];
    }
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--fail-on-needs-task") args.failOnNeedsTask = true;
    else {
      io.error(`unknown argument: ${argv[i]}`);
      return 2;
    }
  }
  if (!args.findings) {
    io.error("usage: review-findings-rules.mjs --findings <file.json> [--ledger <file>] [--json] [--fail-on-needs-task]");
    return 2;
  }
  let findings;
  let ledger;
  try {
    findings = readJson(args.findings);
    ledger = readJson(args.ledgerGiven ? args.ledger : resolveDefaultLedgerPath());
  } catch (error) {
    io.error(`cannot read input: ${error.message}`);
    return 2;
  }
  if (!Array.isArray(findings)) {
    io.error("findings must be a JSON array");
    return 2;
  }
  const errors = validateLedger(ledger);
  if (errors.length > 0) {
    errors.forEach((message) => io.error(`ledger: ${message}`));
    return 2;
  }
  const findingErrors = validateFindings(findings);
  if (findingErrors.length > 0) {
    findingErrors.forEach((message) => io.error(`findings: ${message}`));
    io.error(`${findingErrors.length} invalid finding problem(s); fix the findings file (expected {pr, category, ...})`);
    return 2;
  }
  const result = analyze(findings, ledger);
  io.log(args.json ? JSON.stringify(result, null, 2) : formatReport(result));
  return args.failOnNeedsTask && result.needsTask.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
