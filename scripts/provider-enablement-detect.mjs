/**
 * Detect, from the content of a diff, whether a change enables a provider for
 * customers. The Provider go-live PR section is required only for such a
 * change. A path match alone never requires it, and disable or kill switch
 * changes (a net decrease of every enabling signal) never require it.
 *
 * Inputs are a `git diff --name-status --no-renames` list and a unified diff
 * (`git diff --no-renames HEAD^1 HEAD`). Context lines are ignored; only added
 * and removed lines count, so a reformat that keeps the same counts is inert.
 */

export const PROVIDER_REGISTRY_FILE = "provider-integrations/provider-registry.v1.json";
export const PROVIDER_DISPATCH_ENVELOPE_FILE = "worker/src/providerDispatchEnvelope.ts";
export const MIGRATIONS_PREFIX = "supabase/migrations/";

const NAME_STATUS_LINE = /^([A-Z])(?:\d{1,3})?\t(.+)$/;

/**
 * Parse `git diff --name-status --no-renames` text into [{status, path}].
 * Plain path lines are treated as modified files.
 */
export function parseNameStatus(lines = []) {
  const entries = [];
  for (const raw of lines) {
    const line = String(raw).replaceAll("\\", "/").trim();
    if (!line) continue;
    const match = NAME_STATUS_LINE.exec(line);
    if (!match) {
      entries.push({ status: "M", path: line });
      continue;
    }
    for (const part of match[2].split("\t")) {
      const path = part.trim();
      if (path) entries.push({ status: match[1], path });
    }
  }
  return entries;
}

/**
 * Parse a unified diff into per-file hunks of added and removed lines.
 * @returns {Map<string, {hunks: {added: string[], removed: string[]}[], deleted: boolean}>}
 */
export function parseUnifiedDiff(diffText = "") {
  const files = new Map();
  let current = null;
  let hunk = null;
  let oldPath = null;

  for (const line of String(diffText).replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      hunk = null;
      oldPath = null;
      continue;
    }
    if (hunk === null && line.startsWith("--- ")) {
      oldPath = line.slice(4).replace(/^a\//, "");
      continue;
    }
    if (hunk === null && line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/^b\//, "");
      const deleted = target === "/dev/null";
      const path = deleted ? oldPath : target;
      if (path) {
        current = files.get(path) ?? { hunks: [], deleted };
        files.set(path, current);
      }
      continue;
    }
    if (line.startsWith("@@")) {
      if (current) {
        hunk = { added: [], removed: [] };
        current.hunks.push(hunk);
      }
      continue;
    }
    if (!current || !hunk) continue;
    if (line.startsWith("+")) hunk.added.push(line.slice(1));
    else if (line.startsWith("-")) hunk.removed.push(line.slice(1));
    else if (!line.startsWith(" ") && line !== "" && !line.startsWith("\\")) hunk = null;
  }

  return files;
}

function allLines(file, side) {
  return file.hunks.flatMap((hunk) => hunk[side]);
}

function countMatches(lines, pattern) {
  return lines.filter((line) => pattern.test(line)).length;
}

function netIncrease(file, pattern) {
  return countMatches(allLines(file, "added"), pattern) - countMatches(allLines(file, "removed"), pattern);
}

function detectRegistry(file) {
  const reasons = [];
  if (netIncrease(file, /"liveAdapter"\s*:\s*true\b/) > 0) {
    reasons.push("registry entry gains liveAdapter: true");
  }
  if (netIncrease(file, /"egress"\s*:\s*"stable_nat"/) > 0) {
    reasons.push('registry entry gains production egress ("stable_nat")');
  }
  return reasons;
}

const ENVELOPE_PROVIDER_LINE = /^\s{4}provider:\s*"([a-z][a-z0-9_]*)",?\s*$/;

function detectEnvelopeList(file) {
  const removedKeys = new Set(
    allLines(file, "removed")
      .map((line) => ENVELOPE_PROVIDER_LINE.exec(line)?.[1])
      .filter(Boolean),
  );
  const reasons = [];
  for (const hunk of file.hunks) {
    const addsEntry = hunk.added.some((line) => /^\s{4}requiredAdmission:/.test(line));
    if (!addsEntry) continue;
    for (const line of hunk.added) {
      const key = ENVELOPE_PROVIDER_LINE.exec(line)?.[1];
      if (key && !removedKeys.has(key)) {
        reasons.push(`REVIEWED_PROVIDER_DISPATCH_ENVELOPES gains provider "${key}"`);
      }
    }
  }
  return reasons;
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") quote = true;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function insertValuesEnable(sql) {
  const insert = /insert\s+into\s+[\w."]+\s*\(([^)]*)\)\s*values\s*\(([\s\S]*?)\)\s*(?:on\s+conflict|;|$)/gi;
  for (const match of sql.matchAll(insert)) {
    const columns = match[1].split(",").map((column) => column.trim().toLowerCase());
    const values = splitTopLevel(match[2]).map((value) => value.replace(/::[\w.\[\]]+\s*$/, "").trim().toLowerCase());
    const flag = columns.indexOf("generic_dispatch_enabled");
    if (flag !== -1 && values[flag] === "true") return true;
    const state = columns.indexOf("admission_state");
    if (state !== -1 && values[state] === "'approved'") return true;
  }
  return false;
}

function detectAdmissionSql(file) {
  const sql = stripSqlComments(allLines(file, "added").join("\n"));
  const reasons = [];
  if (
    /\bgeneric_dispatch_enabled\s*(?::=|=)\s*true\b/i.test(sql) ||
    /\badmission_state\s*(?::=|=)\s*'approved'/i.test(sql) ||
    insertValuesEnable(sql)
  ) {
    reasons.push("migration sets generic_dispatch_enabled = true or admission_state = 'approved'");
  }
  return reasons;
}

/**
 * @param {{ changedFiles?: string[], diffText?: string }} input
 * @returns {{ file: string, reason: string }[]} enabling findings; empty when
 * the change does not enable a provider.
 */
export function detectProviderEnablement({ changedFiles = [], diffText = "" } = {}) {
  const diff = parseUnifiedDiff(diffText);
  const present = new Set(
    parseNameStatus(changedFiles)
      .filter((entry) => entry.status !== "D")
      .map((entry) => entry.path),
  );
  const findings = [];

  for (const [path, file] of diff) {
    if (file.deleted || (present.size > 0 && !present.has(path))) continue;
    let reasons = [];
    if (path === PROVIDER_REGISTRY_FILE) reasons = detectRegistry(file);
    else if (path === PROVIDER_DISPATCH_ENVELOPE_FILE) reasons = detectEnvelopeList(file);
    else if (path.startsWith(MIGRATIONS_PREFIX) && path.endsWith(".sql")) reasons = detectAdmissionSql(file);
    for (const reason of reasons) findings.push({ file: path, reason });
  }

  return findings;
}
