#!/usr/bin/env node
/**
 * OVD-875: every new table in a Supabase migration must enable row level
 * security in the same migration file.
 *
 * A separate rule in the OVD-846 lint family (scripts/lint-security-definer.mjs,
 * which already pins SECURITY DEFINER search_path). It reuses that linter's
 * tokenizer, statement splitter and qualified-name reader, so comments, strings
 * and dollar-quoted bodies are never mistaken for DDL.
 *
 * Rule: each CREATE TABLE of a table in schema public or overdrafter (an
 * unqualified name counts as public) must be followed, in the same file, by
 * ALTER TABLE <name> ENABLE ROW LEVEL SECURITY with no later DISABLE. Enabling
 * RLS in a later migration does not count. Exempt:
 *   - partitions (CREATE TABLE ... PARTITION OF ...); the partitioned parent is
 *     not exempt;
 *   - temporary tables (they live in pg_temp, never in public);
 *   - unlogged tables created and dropped in the same file.
 *
 * Escape hatch: a comment on the CREATE line,
 *   create table public.x ( -- lint-allow: rls-off reason="why"
 * The reason is required; a hatch without one is a failure. A hatch with a
 * reason passes, is listed in the report, and when it shows up in a diff
 * (changed mode with --base-ref) it is reported as gate_loosening.
 *
 * Existing violations are listed in scripts/rls-new-tables-baseline.json,
 * keyed by file, table and a hash of the CREATE statement, like the OVD-846
 * baseline. A baselined table passes only while its CREATE is byte-identical;
 * new files are enforced. The baseline may only shrink.
 *
 * Gate loosening (Release Plan §6): baseline growth (added or widened entry),
 * an escape hatch added in the diff, and any edit to this script or its
 * portable-node runner are classified gate_loosening, which needs a Grok Bot
 * countersign on top of Blaine's card. Report only: it adds a gate_loosening
 * field to the JSON and a GATE LOOSENING line to the output, but never changes
 * the exit code.
 *
 * Usage:
 *   node scripts/lint-rls-new-tables.mjs --all [--write-baseline]
 *   node scripts/lint-rls-new-tables.mjs --changed-files-from <name-status.txt> --base-ref HEAD^1
 *   node scripts/lint-rls-new-tables.mjs <file.sql> ...
 * Options: --root <dir> (repository root, default cwd), --baseline <path>,
 *   --json-out <path>, --report (default; exit 0 on failures), --enforce (exit 1
 *   on failures).
 * Exit codes: 0 pass or report mode, 1 enforced failure, 2 usage or input error.
 *
 * test:portable-node runs it in report mode (scripts/lint-rls-new-tables.node-test.mjs).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareCodeUnits,
  escapeAnnotation,
  GATE_LOOSENING_LINE,
  GATE_LOOSENING_REQUIRES,
  gateLooseningLines,
  isPunct,
  isWord,
  readQualifiedName,
  reportVerdict,
  runLintCli,
  sha256,
  splitStatements,
  toJsonText,
  violationAnnotations,
} from "./lint-security-definer.mjs";

export { GATE_LOOSENING_LINE };

export const BASELINE_PATH = "scripts/rls-new-tables-baseline.json";
export const BASELINE_SCHEMA = "rls-new-tables-baseline.v1";
export const REPORT_SCHEMA = "rls-new-tables-lint.v1";
export const CHECKER_PATH = "scripts/lint-rls-new-tables.mjs";
export const RUNNER_PATH = "scripts/lint-rls-new-tables.node-test.mjs";
const CHECKER_FILES = [CHECKER_PATH, RUNNER_PATH];

export const LOOSENING_BASELINE_ADDED = "baseline_entry_added";
export const LOOSENING_BASELINE_WIDENED = "baseline_entry_widened";
export const LOOSENING_CHECKER_CHANGED = "checker_changed";
export const LOOSENING_ESCAPE_HATCH_ADDED = "escape_hatch_added";

export const MISSING_ENABLE_RLS = "enable_rls";
export const MISSING_ESCAPE_REASON = "escape_hatch_reason";
const MISSING_ORDER = [MISSING_ENABLE_RLS, MISSING_ESCAPE_REASON];

const MISSING_LABELS = {
  [MISSING_ENABLE_RLS]: "ALTER TABLE ... ENABLE ROW LEVEL SECURITY in the same file",
  [MISSING_ESCAPE_REASON]: 'a reason on the escape hatch (-- lint-allow: rls-off reason="...")',
};

export const RLS_SCHEMAS = new Set(["public", "overdrafter"]);

const ESCAPE_HATCH = /--\s*lint-allow:\s*rls-off\b(.*)$/i;
const ESCAPE_REASON = /\breason\s*=\s*"([^"]*)"/i;

// ---------------------------------------------------------------------------
// Statement analysis
// ---------------------------------------------------------------------------

export function formatTable(schema, name) {
  return `${schema}.${name}`;
}

function skipIfExists(tokens, k) {
  if (isWord(tokens[k], "if") && isWord(tokens[k + 1], "exists")) return k + 2;
  if (isWord(tokens[k], "if") && isWord(tokens[k + 1], "not") && isWord(tokens[k + 2], "exists")) return k + 3;
  return k;
}

function parseCreateTable(statement) {
  const { tokens } = statement;
  if (!isWord(tokens[0], "create")) return null;
  let k = 1;
  if (isWord(tokens[k], "global", "local")) k += 1;
  let persistence = "permanent";
  if (isWord(tokens[k], "temp", "temporary")) {
    persistence = "temporary";
    k += 1;
  } else if (isWord(tokens[k], "unlogged")) {
    persistence = "unlogged";
    k += 1;
  }
  if (!isWord(tokens[k], "table")) return null;
  k = skipIfExists(tokens, k + 1);
  const reference = readQualifiedName(tokens, k);
  if (!reference) return null;
  // Temporary tables always live in pg_temp, whatever the name says.
  const schema = persistence === "temporary" ? "pg_temp" : reference.schema;
  const partition = isWord(tokens[reference.next], "partition") && isWord(tokens[reference.next + 1], "of");
  return { kind: "create", schema, name: reference.name, table: formatTable(schema, reference.name), persistence, partition };
}

function parseAlterTable(statement) {
  const { tokens } = statement;
  if (!isWord(tokens[0], "alter") || !isWord(tokens[1], "table")) return null;
  let k = skipIfExists(tokens, 2);
  if (isWord(tokens[k], "only")) k += 1;
  const reference = readQualifiedName(tokens, k);
  if (!reference) return null;
  let rls;
  let depth = 0;
  for (let j = reference.next; j < tokens.length; j += 1) {
    const token = tokens[j];
    if (isPunct(token, "(")) depth += 1;
    if (isPunct(token, ")")) depth -= 1;
    if (depth !== 0) continue;
    if (isWord(token, "enable", "disable") && isWord(tokens[j + 1], "row") && isWord(tokens[j + 2], "level") && isWord(tokens[j + 3], "security")) {
      rls = token.value === "enable";
    }
  }
  if (rls === undefined) return null;
  return { kind: "rls", table: formatTable(reference.schema, reference.name), enabled: rls };
}

function parseDropTable(statement) {
  const { tokens } = statement;
  if (!isWord(tokens[0], "drop") || !isWord(tokens[1], "table")) return null;
  let k = skipIfExists(tokens, 2);
  const tables = [];
  while (k < tokens.length) {
    const reference = readQualifiedName(tokens, k);
    if (!reference) break;
    tables.push(formatTable(reference.schema, reference.name));
    k = reference.next;
    if (!isPunct(tokens[k], ",")) break;
    k += 1;
  }
  return tables.length ? { kind: "drop", tables } : null;
}

/** Parse the escape hatch comment on a source line. Returns {reason} or null. */
export function parseEscapeHatch(lineText) {
  const match = ESCAPE_HATCH.exec(lineText ?? "");
  if (!match) return null;
  const reason = ESCAPE_REASON.exec(match[1])?.[1]?.trim() ?? "";
  return { reason, comment: match[0].trim() };
}

/**
 * Lint one migration's SQL text.
 * @returns {{tables: object[], violations: object[], escapeHatches: object[]}}
 *   violations carry {file, line, table, missing, definitionSha256}.
 */
export function lintSql(sql, file) {
  const text = String(sql).replaceAll("\r\n", "\n");
  const lines = text.split("\n");
  const statements = splitStatements(text);
  const creates = [];
  const events = [];
  statements.forEach((statement, index) => {
    const parsed = parseCreateTable(statement) ?? parseAlterTable(statement) ?? parseDropTable(statement);
    if (!parsed) return;
    if (parsed.kind === "create") {
      creates.push({
        ...parsed,
        file,
        line: statement.line,
        statementIndex: index,
        definitionSha256: sha256(statement.text),
        escapeHatch: parseEscapeHatch(lines[statement.line - 1]),
      });
      return;
    }
    events.push({ ...parsed, index });
  });

  const tables = [];
  const violations = [];
  const escapeHatches = [];
  for (const create of creates) {
    const later = events.filter((event) => event.index > create.statementIndex);
    const dropped = later.some((event) => event.kind === "drop" && event.tables.includes(create.table));
    let exempt = null;
    if (!RLS_SCHEMAS.has(create.schema)) exempt = "schema";
    else if (create.partition) exempt = "partition";
    else if (create.persistence === "unlogged" && dropped) exempt = "unlogged_dropped";

    let rlsEnabled = false;
    for (const event of later) {
      if (event.kind === "rls" && event.table === create.table) rlsEnabled = event.enabled;
    }
    tables.push({ file, line: create.line, table: create.table, rlsEnabled, exempt });
    if (exempt) continue;

    const missing = [];
    const hatch = create.escapeHatch;
    if (hatch && hatch.reason) {
      escapeHatches.push({ file, line: create.line, table: create.table, reason: hatch.reason });
    } else if (!rlsEnabled) {
      missing.push(MISSING_ENABLE_RLS);
    }
    if (hatch && !hatch.reason) missing.push(MISSING_ESCAPE_REASON);
    if (missing.length) {
      violations.push({
        file,
        line: create.line,
        table: create.table,
        missing: MISSING_ORDER.filter((code) => missing.includes(code)),
        definitionSha256: create.definitionSha256,
      });
    }
  }
  return { tables, violations, escapeHatches };
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

export function baselineKey(entry) {
  return `${entry.file}\u0000${entry.table}\u0000${entry.definitionSha256}`;
}

export function toBaselineEntry(violation) {
  return {
    file: violation.file,
    table: violation.table,
    missing: [...violation.missing],
    definitionSha256: violation.definitionSha256,
  };
}

export function buildBaseline(violations) {
  const entries = violations.map(toBaselineEntry).sort((a, b) =>
    compareCodeUnits(a.file, b.file) ||
    compareCodeUnits(a.table, b.table) ||
    compareCodeUnits(a.definitionSha256, b.definitionSha256),
  );
  return {
    schema: BASELINE_SCHEMA,
    description:
      "Existing tables created without ENABLE ROW LEVEL SECURITY in the same migration (OVD-875). Generated by `node scripts/lint-rls-new-tables.mjs --all --write-baseline`. Entries may only be removed.",
    entries,
  };
}

export const serializeBaseline = toJsonText;

export function parseBaseline(text) {
  const parsed = JSON.parse(text);
  if (!parsed || parsed.schema !== BASELINE_SCHEMA || !Array.isArray(parsed.entries)) {
    throw new Error(`baseline is not a ${BASELINE_SCHEMA} document`);
  }
  return parsed;
}

function indexBaseline(baseline) {
  const index = new Map();
  for (const entry of baseline?.entries ?? []) index.set(baselineKey(entry), entry);
  return index;
}

/** True when the entry (or violation) is covered: same CREATE, no extra missing code. */
export function coveredBy(baseline, entry) {
  const known = indexBaseline(baseline).get(baselineKey(entry));
  return Boolean(known) && entry.missing.every((code) => known.missing.includes(code));
}

/** Entries in the head baseline that the base baseline does not cover. */
export function findBaselineGrowth(baseBaseline, headBaseline) {
  return (headBaseline?.entries ?? []).filter((entry) => !coveredBy(baseBaseline, entry));
}

/** Baseline entries the current violations no longer produce (safe to remove). */
export function findStaleBaselineEntries(baseline, violations) {
  const current = new Map(violations.map((violation) => [baselineKey(violation), violation]));
  return (baseline?.entries ?? []).filter((entry) => {
    const violation = current.get(baselineKey(entry));
    return !violation || violation.missing.join(",") !== entry.missing.join(",");
  });
}

const hatchKey = (hatch) => `${hatch.file}\u0000${hatch.table}\u0000${hatch.reason}`;

/**
 * Classify a PR's changes as gate_loosening (report only).
 * baseEscapeHatches are the hatches already present in the base copies of the
 * changed files; any other hatch in escapeHatches showed up in the diff.
 * @param {{baseBaseline?: object|null, headBaseline?: object|null, changedFiles?: {status: string, file: string}[], escapeHatches?: object[]|null, baseEscapeHatches?: object[]}} input
 * @returns {{detected: boolean, reasons: object[], requires: string[]}}
 */
export function findGateLoosening({
  baseBaseline = null,
  headBaseline = null,
  changedFiles = [],
  escapeHatches = null,
  baseEscapeHatches = [],
} = {}) {
  const reasons = [];
  if (baseBaseline && headBaseline) {
    const index = indexBaseline(baseBaseline);
    for (const entry of findBaselineGrowth(baseBaseline, headBaseline)) {
      const known = index.get(baselineKey(entry));
      if (known) {
        const missingAdded = entry.missing.filter((code) => !known.missing.includes(code));
        reasons.push({
          code: LOOSENING_BASELINE_WIDENED,
          file: BASELINE_PATH,
          table: entry.table,
          migration: entry.file,
          missing_added: missingAdded,
          message: `baseline entry for ${entry.file} ${entry.table} widened to also allow missing ${missingAdded.join(", ")}`,
        });
      } else {
        reasons.push({
          code: LOOSENING_BASELINE_ADDED,
          file: BASELINE_PATH,
          table: entry.table,
          migration: entry.file,
          message: `baseline entry added for ${entry.file} ${entry.table}`,
        });
      }
    }
  }
  if (escapeHatches) {
    const known = new Set(baseEscapeHatches.map(hatchKey));
    for (const hatch of escapeHatches) {
      if (known.has(hatchKey(hatch))) continue;
      reasons.push({
        code: LOOSENING_ESCAPE_HATCH_ADDED,
        file: hatch.file,
        line: hatch.line,
        table: hatch.table,
        reason: hatch.reason,
        message: `escape hatch lint-allow: rls-off added for ${hatch.table} at ${hatch.file}:${hatch.line} (reason: ${hatch.reason})`,
      });
    }
  }
  // Only files with a base copy: adding the checker does not loosen it.
  const edited = new Map();
  for (const { status, file } of changedFiles) {
    if (CHECKER_FILES.includes(file) && status !== "A") edited.set(file, status);
  }
  for (const [file, status] of [...edited].sort(([a], [b]) => compareCodeUnits(a, b))) {
    reasons.push({
      code: LOOSENING_CHECKER_CHANGED,
      file,
      status,
      message: `${file} ${status === "D" ? "deleted" : "edited"}; needs review (the head copy ran)`,
    });
  }
  return { detected: reasons.length > 0, reasons, requires: [...GATE_LOOSENING_REQUIRES] };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatViolation(violation) {
  return violation.missing.map(
    (code) => `${violation.file}:${violation.line} ${violation.table}: missing ${MISSING_LABELS[code]}`,
  );
}

/**
 * Lint a set of files and build the report object.
 * gate_loosening is report only and never affects ok. baseFiles (changed mode)
 * are the base copies of the linted files, used to tell new escape hatches
 * from old ones; pass null when there is no diff.
 * @param {{files: {file: string, sql: string}[], baseFiles?: {file: string, sql: string|null}[]|null, baseline?: object, baseBaseline?: object|null, headBaseline?: object|null, changedFiles?: {status: string, file: string}[], mode?: string, enforce?: boolean}} input
 */
export function lintFiles({
  files,
  baseFiles = null,
  baseline = null,
  baseBaseline = null,
  headBaseline = null,
  changedFiles = [],
  mode = "files",
  enforce = false,
}) {
  const tables = [];
  const escapeHatches = [];
  let violations = [];
  for (const { file, sql } of files) {
    const result = lintSql(sql, file);
    tables.push(...result.tables);
    violations.push(...result.violations);
    escapeHatches.push(...result.escapeHatches);
  }
  violations = violations.map((violation) => ({ ...violation, baselined: coveredBy(baseline, violation) }));
  const failing = violations.filter((violation) => !violation.baselined);
  const baselineGrowth = baseBaseline && headBaseline ? findBaselineGrowth(baseBaseline, headBaseline) : [];
  const staleBaselineEntries = mode === "full" && baseline ? findStaleBaselineEntries(baseline, violations) : [];
  const baseEscapeHatches = (baseFiles ?? []).flatMap(({ file, sql }) => (sql === null ? [] : lintSql(sql, file).escapeHatches));
  return {
    schema: REPORT_SCHEMA,
    mode,
    enforce,
    ok: failing.length === 0 && baselineGrowth.length === 0,
    files: files.map(({ file }) => file),
    summary: {
      files: files.length,
      tables: tables.length,
      exempt: tables.filter((table) => table.exempt).length,
      violations: violations.length,
      baselined: violations.length - failing.length,
      failing: failing.length,
      escapeHatches: escapeHatches.length,
      baselineGrowth: baselineGrowth.length,
      staleBaselineEntries: staleBaselineEntries.length,
    },
    violations,
    escapeHatches,
    baselineGrowth,
    staleBaselineEntries,
    gate_loosening: findGateLoosening({
      baseBaseline,
      headBaseline,
      changedFiles,
      escapeHatches: baseFiles ? escapeHatches : null,
      baseEscapeHatches,
    }),
  };
}

export function formatReport(report) {
  const lines = gateLooseningLines(report);
  for (const violation of report.violations.filter((v) => !v.baselined)) lines.push(...formatViolation(violation));
  for (const hatch of report.escapeHatches) {
    lines.push(`${hatch.file}:${hatch.line} ${hatch.table}: RLS check skipped by lint-allow: rls-off (reason: ${hatch.reason})`);
  }
  for (const entry of report.baselineGrowth) {
    lines.push(`${BASELINE_PATH}: baseline entry added for ${entry.file} ${entry.table} (baseline may only shrink)`);
  }
  const s = report.summary;
  lines.push(
    `rls-new-tables-lint: ${s.files} file(s), ${s.tables} CREATE TABLE(s), ${s.exempt} exempt, ` +
      `${s.failing} failing, ${s.baselined} baselined, ${s.escapeHatches} escape hatch(es), ${s.baselineGrowth} baseline addition(s)` +
      reportVerdict(report),
  );
  return lines.join("\n");
}

function githubAnnotations(report) {
  const lines = violationAnnotations(report, formatViolation, "RLS on new tables");
  if (report.gate_loosening?.detected) {
    // Report only, so always a warning even under --enforce.
    for (const reason of report.gate_loosening.reasons) {
      const where = reason.line ? `file=${reason.file},line=${reason.line}` : `file=${reason.file}`;
      lines.push(`::warning ${where},title=${GATE_LOOSENING_LINE.replaceAll(":", "")}::${escapeAnnotation(reason.message)}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(argv = process.argv.slice(2), io = {}) {
  return runLintCli(
    {
      name: "rls-new-tables-lint",
      baselinePath: BASELINE_PATH,
      parseBaseline,
      buildBaseline,
      lintFiles,
      formatReport,
      githubAnnotations,
      allowReport: true,
      withBaseFiles: true,
      writeBaselineFirst: true,
    },
    argv,
    io,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
