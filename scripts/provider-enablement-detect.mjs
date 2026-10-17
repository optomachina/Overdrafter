/**
 * Detect, from the content of a change, whether it enables a provider for
 * customers. The Provider go-live PR section is required only for such a
 * change. A path match alone never requires it, and disable or kill switch
 * changes never require it.
 *
 * Inputs are a `git diff --name-status --no-renames` list, a unified diff
 * (`git diff --no-renames HEAD^1 HEAD`), and a `readFile(side, path)` that
 * returns file text at the base or head. The registry and the envelope list are
 * compared per provider from that text, so a PR that turns one provider on and
 * another off still counts. Migrations are read from added lines, one SQL
 * statement at a time, counting only SET assignments and inserted values.
 */

import ts from "typescript";

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

  for (const line of String(diffText).replaceAll("\r\n", "\n").split("\n")) {
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

/**
 * Files that implement the gate itself. A change to any of them cannot be
 * judged by the copy it edits, so the gate asks for a reviewer note.
 */
export const GATE_FILES = Object.freeze([
  "scripts/lib/entry-point.mjs",
  "scripts/provider-enablement-detect.mjs",
  "scripts/validate-pr-body.mjs",
  "scripts/validate-pr-body.test.mjs",
  ".github/workflows/pr-body-gate.yml",
]);

const PRODUCTION_EGRESS_NONE = "none";

function parseRegistryProviders(text) {
  const registry = JSON.parse(text);
  const providers = new Map();
  if (!registry || !Array.isArray(registry.providers)) {
    throw new Error("registry has no providers array");
  }
  for (const entry of registry.providers) {
    if (!entry || typeof entry.key !== "string") throw new Error("registry provider without a string key");
    providers.set(entry.key, { liveAdapter: entry.liveAdapter === true, egress: entry.egress });
  }
  return providers;
}

/**
 * Compare the registry per provider key at the base and at the head. A
 * provider is enabling when its liveAdapter goes from false or absent to true,
 * or its egress gains a production value. Another provider turning off never
 * offsets it. Unreadable input fails closed.
 */
function detectRegistry(baseText, headText) {
  if (headText === null || headText === undefined) {
    return ["registry file content is unavailable, so the change cannot be compared per provider"];
  }
  let head;
  let base = new Map();
  try {
    head = parseRegistryProviders(headText);
    if (baseText !== null && baseText !== undefined) base = parseRegistryProviders(baseText);
  } catch (error) {
    return [`registry could not be parsed (${error instanceof Error ? error.message : error}); treated as enabling`];
  }
  const reasons = [];
  for (const [key, now] of head) {
    const before = base.get(key);
    if (now.liveAdapter && !before?.liveAdapter) {
      reasons.push(`registry provider "${key}" gains liveAdapter: true`);
    }
    const nowEgress = typeof now.egress === "string" ? now.egress : PRODUCTION_EGRESS_NONE;
    const beforeEgress = typeof before?.egress === "string" ? before.egress : PRODUCTION_EGRESS_NONE;
    if (nowEgress !== PRODUCTION_EGRESS_NONE && nowEgress !== beforeEgress) {
      reasons.push(`registry provider "${key}" gains production egress ("${nowEgress}")`);
    }
  }
  return reasons;
}

const ENVELOPE_EXPORT = "REVIEWED_PROVIDER_DISPATCH_ENVELOPES";

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/**
 * Structurally read the provider keys of REVIEWED_PROVIDER_DISPATCH_ENVELOPES,
 * independent of formatting. Throws when the export is missing or an entry's
 * provider is not a string literal.
 */
export function parseEnvelopeProviders(source) {
  const sourceFile = ts.createSourceFile("providerDispatchEnvelope.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let initializer = null;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === ENVELOPE_EXPORT && declaration.initializer) {
        initializer = declaration.initializer;
      }
    }
  }
  if (!initializer) throw new Error(`${ENVELOPE_EXPORT} is not declared`);
  let array = unwrapExpression(initializer);
  if (
    ts.isCallExpression(array) &&
    array.arguments.length === 1 &&
    ts.isPropertyAccessExpression(array.expression) &&
    array.expression.name.text === "freeze"
  ) {
    array = unwrapExpression(array.arguments[0]);
  }
  if (!ts.isArrayLiteralExpression(array)) throw new Error(`${ENVELOPE_EXPORT} is not an array literal`);
  const providers = new Set();
  array.elements.forEach((element, index) => {
    const object = unwrapExpression(element);
    if (!ts.isObjectLiteralExpression(object)) throw new Error(`${ENVELOPE_EXPORT}[${index}] is not an object literal`);
    const property = object.properties.find((candidate) => ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === "provider");
    const value = property && ts.isPropertyAssignment(property) ? unwrapExpression(property.initializer) : null;
    if (!value || !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
      throw new Error(`${ENVELOPE_EXPORT}[${index}] provider is not a string literal`);
    }
    providers.add(value.text);
  });
  return providers;
}

function detectEnvelopeList(baseText, headText) {
  if (headText === null || headText === undefined) {
    return [`${ENVELOPE_EXPORT} content is unavailable, so the change cannot be compared`];
  }
  let head;
  let base = new Set();
  try {
    head = parseEnvelopeProviders(headText);
    if (baseText !== null && baseText !== undefined) base = parseEnvelopeProviders(baseText);
  } catch (error) {
    return [`${ENVELOPE_EXPORT} could not be parsed (${error instanceof Error ? error.message : error}); treated as enabling`];
  }
  return [...head].filter((key) => !base.has(key)).map((key) => `${ENVELOPE_EXPORT} gains provider "${key}"`);
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Replace quoted string contents with underscores so keyword scans skip them. */
function maskQuoted(text) {
  let out = "";
  let quote = false;
  for (const ch of text) {
    if (quote) {
      if (ch === "'") quote = false;
      out += ch === "'" ? ch : "_".repeat(ch.length);
    } else {
      if (ch === "'") quote = true;
      out += ch;
    }
  }
  return out;
}

function splitStatements(sql) {
  const masked = maskQuoted(sql);
  const parts = [];
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === ";") {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(sql.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function splitTopLevel(text) {
  const masked = maskQuoted(text);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

const SET_END_KEYWORDS = new Set(["where", "from", "returning"]);

/**
 * Text of every top-level SET clause in a statement (UPDATE ... SET and
 * ON CONFLICT DO UPDATE SET). A WHERE, FROM, or RETURNING keyword ends it, so
 * a value only mentioned in a filter is never read as an assignment.
 */
function setClauses(statement) {
  const masked = maskQuoted(statement);
  const clauses = [];
  const words = [...masked.matchAll(/[A-Za-z_]\w*|\(|\)/g)];
  let depth = 0;
  let open = null;
  for (const word of words) {
    const token = word[0];
    if (token === "(") depth += 1;
    else if (token === ")") depth -= 1;
    else if (depth === 0) {
      const lower = token.toLowerCase();
      if (open !== null && SET_END_KEYWORDS.has(lower)) {
        clauses.push(statement.slice(open, word.index));
        open = null;
      } else if (open === null && lower === "set") {
        open = word.index + token.length;
      }
    }
  }
  if (open !== null) clauses.push(statement.slice(open));
  return clauses;
}

const ENABLE_FLAG_ASSIGNMENT = /^(?:[\w"]+\.)?"?generic_dispatch_enabled"?\s*(?::=|=)\s*true\b/i;
const ENABLE_STATE_ASSIGNMENT = /^(?:[\w"]+\.)?"?admission_state"?\s*(?::=|=)\s*'approved'/i;

function setAssignmentEnables(statement) {
  return setClauses(statement).some((clause) =>
    splitTopLevel(clause).some(
      (assignment) => ENABLE_FLAG_ASSIGNMENT.test(assignment) || ENABLE_STATE_ASSIGNMENT.test(assignment),
    ),
  );
}

function valueTuples(text) {
  const masked = maskQuoted(text);
  const tuples = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === "(") {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (masked[i] === ")") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        tuples.push(text.slice(start, i));
        start = -1;
      }
    }
  }
  return tuples;
}

function insertValuesEnable(statement) {
  const match = /insert\s+into\s+[\w."]+\s*\(([^)]*)\)\s*values\s*([\s\S]*)$/i.exec(statement);
  if (!match) return false;
  const columns = match[1].split(",").map((column) => column.trim().replaceAll('"', "").toLowerCase());
  const flag = columns.indexOf("generic_dispatch_enabled");
  const state = columns.indexOf("admission_state");
  const valuesText = match[2].split(/\bon\s+conflict\b/i)[0];
  for (const tuple of valueTuples(valuesText)) {
    const values = splitTopLevel(tuple).map((value) => value.replace(/::[\w.[\]]+\s*$/, "").trim().toLowerCase());
    if (flag !== -1 && values[flag] === "true") return true;
    if (state !== -1 && values[state] === "'approved'") return true;
  }
  return false;
}

function detectAdmissionSql(file) {
  const sql = stripSqlComments(allLines(file, "added").join("\n"));
  const enables = splitStatements(sql).some(
    (statement) => setAssignmentEnables(statement) || insertValuesEnable(statement),
  );
  return enables ? ["migration sets generic_dispatch_enabled = true or admission_state = 'approved'"] : [];
}

/**
 * @param {{
 *   changedFiles?: string[],
 *   diffText?: string,
 *   readFile?: (side: "base" | "head", path: string) => string | null,
 * }} input `readFile` returns the file text at the base or the head, or null
 * when the file does not exist there. The registry and the envelope list are
 * compared structurally from it, never from diff lines.
 * @returns {{ file: string, reason: string, kind: "provider" | "gate" }[]}
 * findings; empty when the change neither enables a provider nor edits the
 * gate itself. Provider findings require the Provider go-live section; gate
 * findings require a reviewer note.
 */
export function detectProviderEnablement({ changedFiles = [], diffText = "", readFile = null } = {}) {
  const diff = parseUnifiedDiff(diffText);
  const entries = parseNameStatus(changedFiles);
  const present = new Set(entries.filter((entry) => entry.status !== "D").map((entry) => entry.path));
  const findings = [];

  const touched = new Set([...diff.keys(), ...entries.map((entry) => entry.path)]);
  for (const path of GATE_FILES) {
    if (touched.has(path)) {
      findings.push({ file: path, reason: "edits the PR body gate itself", kind: "gate" });
    }
  }

  const read = (side, path) => (typeof readFile === "function" ? readFile(side, path) : null);
  const candidates = new Set([...diff.keys(), ...present]);
  for (const path of candidates) {
    const file = diff.get(path);
    if (file?.deleted || (present.size > 0 && !present.has(path))) continue;
    let reasons = [];
    if (path === PROVIDER_REGISTRY_FILE) reasons = detectRegistry(read("base", path), read("head", path));
    else if (path === PROVIDER_DISPATCH_ENVELOPE_FILE) reasons = detectEnvelopeList(read("base", path), read("head", path));
    else if (file && path.startsWith(MIGRATIONS_PREFIX) && path.endsWith(".sql")) reasons = detectAdmissionSql(file);
    for (const reason of reasons) findings.push({ file: path, reason, kind: "provider" });
  }

  return findings;
}
