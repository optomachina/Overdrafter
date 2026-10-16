import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

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

export function validateLedger(ledger) {
  const errors = [];
  if (!ledger || !Array.isArray(ledger.entries)) return ["ledger.entries must be an array"];
  const seen = new Set();
  ledger.entries.forEach((entry, i) => {
    const at = `entries[${i}]`;
    const category = normalizeCategory(entry.category);
    if (!category) errors.push(`${at}.category is required`);
    else if (seen.has(category)) errors.push(`${at}.category "${category}" is duplicated`);
    seen.add(category);
    if (!entry.first_seen || !entry.second_seen) errors.push(`${at} needs first_seen and second_seen`);
    if (!entry.task) errors.push(`${at}.task is required`);
    if (!RULE_TYPES.includes(entry.rule_type)) errors.push(`${at}.rule_type must be one of ${RULE_TYPES.join("|")}`);
    if (!STATUSES.includes(entry.status)) errors.push(`${at}.status must be one of ${STATUSES.join("|")}`);
    if (entry.status === "converted" && !entry.converted_by) errors.push(`${at}.converted_by is required when converted`);
  });
  return errors;
}

/** Groups findings by category and keeps the distinct PRs each category was seen in. */
export function groupByCategory(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const category = normalizeCategory(finding?.category);
    if (!category || finding?.pr === undefined || finding?.pr === null) continue;
    if (!groups.has(category)) groups.set(category, new Map());
    const prs = groups.get(category);
    if (!prs.has(finding.pr)) prs.set(finding.pr, []);
    prs.get(finding.pr).push(finding);
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
  for (const [category, prs] of groupByCategory(findings)) {
    if (prs.size < 2 || known.has(category)) continue;
    const distinct = [...prs.keys()].sort((a, b) => Number(a) - Number(b));
    needsTask.push({
      category,
      first_seen: distinct[0],
      second_seen: distinct[1],
      prs: distinct,
      taxonomy: CATEGORIES.includes(category),
      titles: [...prs.values()].flat().map((finding) => finding.title).filter(Boolean),
    });
  }
  needsTask.sort((a, b) => a.category.localeCompare(b.category));
  return { needsTask, conversion: conversionRate(ledger.entries) };
}

export function formatReport({ needsTask, conversion }) {
  const lines = [];
  if (needsTask.length === 0) lines.push("No categories need a finding-to-rule task.");
  for (const item of needsTask) {
    const note = item.taxonomy ? "" : " (not in taxonomy)";
    lines.push(`needs task: ${item.category}${note} — seen in PRs ${item.prs.join(", ")}`);
  }
  const pct = conversion.rate === null ? "n/a" : `${(conversion.rate * 100).toFixed(0)}%`;
  lines.push(`conversion: ${conversion.converted}/${conversion.opened} (${pct})`);
  return lines.join("\n");
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  const args = { findings: null, ledger: DEFAULT_LEDGER_PATH, json: false, failOnNeedsTask: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--findings") args.findings = argv[++i];
    else if (argv[i] === "--ledger") args.ledger = argv[++i];
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
    ledger = readJson(args.ledger);
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
  const result = analyze(findings, ledger);
  io.log(args.json ? JSON.stringify(result, null, 2) : formatReport(result));
  return args.failOnNeedsTask && result.needsTask.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
