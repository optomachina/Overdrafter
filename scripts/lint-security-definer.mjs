#!/usr/bin/env node
/**
 * OVD-846: lint SECURITY DEFINER functions in Supabase migrations.
 *
 * Every CREATE [OR REPLACE] FUNCTION ... SECURITY DEFINER must, in the same
 * migration file:
 *   1. pin search_path in the function header (SET search_path = '' or a list
 *      that does not start with public and has no user-writable schema). An
 *      ALTER FUNCTION <sig> SET search_path later in the same file also counts;
 *   2. REVOKE ALL|EXECUTE ON FUNCTION <sig> FROM PUBLIC and FROM anon (one
 *      statement listing both is fine), not re-granted later in the file;
 *   3. GRANT EXECUTE ON FUNCTION <sig> TO <role> for some role other than
 *      PUBLIC or anon.
 *
 * Existing violations are listed in scripts/security-definer-baseline.json,
 * keyed by file, signature and a hash of the CREATE statement. A baselined
 * function passes only while its definition is byte-identical and it misses no
 * more clauses than recorded, so re-creating it in a new migration, or editing
 * it, requires full compliance. The baseline may only shrink: with --base-ref,
 * any entry that the base commit's baseline does not cover is reported as
 * baseline growth.
 *
 * Gate loosening (Release Plan §6): baseline growth (an added entry, or an
 * entry that misses more clauses than the base copy records) and any edit to
 * this script or its CI workflow are classified as gate_loosening, which needs
 * a Grok Bot countersign on top of Blaine's card. The checker has no allow-list
 * other than the baseline. Edits to the checker are flagged for review whatever
 * they change; adding the checker (no base copy) is not flagged. Detection is
 * report only: it adds a gate_loosening field to the JSON and a GATE LOOSENING
 * line to the output, but never changes the exit code. --enforce still fails
 * on baseline growth, as it does without gate loosening, and does not fail on
 * a checker edit alone. Checker edits are seen only with --changed-files-from.
 *
 * Usage:
 *   node scripts/lint-security-definer.mjs --all [--write-baseline]
 *   node scripts/lint-security-definer.mjs --changed-files-from <name-status.txt> --base-ref HEAD^1
 *   node scripts/lint-security-definer.mjs <file.sql> ...
 * Options: --root <dir> (repository root, default cwd), --baseline <path>,
 *   --json-out <path>, --enforce (exit 1 on failures; report mode exits 0).
 * Exit codes: 0 pass or report mode, 1 enforced failure, 2 usage or input error.
 *
 * The CI workflow runs the base commit's copy of this file, so it must stay a
 * single dependency-free module.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = "supabase/migrations";
export const BASELINE_PATH = "scripts/security-definer-baseline.json";
export const BASELINE_SCHEMA = "security-definer-baseline.v1";
export const REPORT_SCHEMA = "security-definer-lint.v1";
export const CHECKER_PATH = "scripts/lint-security-definer.mjs";
export const WORKFLOW_PATH = ".github/workflows/security-definer-lint.yml";
const CHECKER_FILES = [CHECKER_PATH, WORKFLOW_PATH];

export const GATE_LOOSENING_REQUIRES = ["grokbot_countersign", "blaine_card"];
export const GATE_LOOSENING_LINE = "GATE LOOSENING: needs Grok Bot countersign + Blaine's card";
export const LOOSENING_BASELINE_ADDED = "baseline_entry_added";
export const LOOSENING_BASELINE_WIDENED = "baseline_entry_widened";
export const LOOSENING_CHECKER_CHANGED = "checker_changed";

export const MISSING_SEARCH_PATH = "search_path";
export const MISSING_REVOKE_PUBLIC = "revoke_public";
export const MISSING_REVOKE_ANON = "revoke_anon";
export const MISSING_GRANT = "grant";
const MISSING_ORDER = [MISSING_SEARCH_PATH, MISSING_REVOKE_PUBLIC, MISSING_REVOKE_ANON, MISSING_GRANT];

const MISSING_LABELS = {
  [MISSING_SEARCH_PATH]: "SET search_path = '' (or a pinned list without public first)",
  [MISSING_REVOKE_PUBLIC]: "REVOKE ... FROM PUBLIC",
  [MISSING_REVOKE_ANON]: "REVOKE ... FROM anon",
  [MISSING_GRANT]: "GRANT EXECUTE ... TO <role>",
};

const OPEN_ROLES = new Set(["public", "anon"]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/**
 * Split SQL into tokens, skipping comments. Tolerant: an unterminated string,
 * identifier, comment or dollar body runs to the end of the input.
 * Token types: word (value lowercased), ident (quoted identifier), string,
 * dollar (dollar-quoted body), number, param ($1), punct.
 * @returns {{type: string, value: string, start: number, end: number, line: number}[]}
 */
export function tokenize(sql) {
  const text = String(sql);
  const tokens = [];
  let i = 0;
  let line = 1;
  const advance = (to) => {
    for (let k = i; k < to; k += 1) if (text.charCodeAt(k) === 10) line += 1;
    i = to;
  };
  const push = (type, value, start, startLine) =>
    tokens.push({ type, value, start, end: i, line: startLine });

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (/\s/.test(ch)) {
      advance(i + 1);
      continue;
    }
    if (ch === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      advance(nl === -1 ? text.length : nl);
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 0;
      let k = i;
      while (k < text.length) {
        if (text[k] === "/" && text[k + 1] === "*") {
          depth += 1;
          k += 2;
        } else if (text[k] === "*" && text[k + 1] === "/") {
          depth -= 1;
          k += 2;
          if (depth === 0) break;
        } else {
          k += 1;
        }
      }
      advance(Math.min(k, text.length));
      continue;
    }
    const start = i;
    const startLine = line;
    if (ch === "'") {
      const value = readQuoted(text, i, "'", false);
      advance(value.end);
      push("string", value.value, start, startLine);
      continue;
    }
    if (ch === '"') {
      const value = readQuoted(text, i, '"', false);
      advance(value.end);
      push("ident", value.value, start, startLine);
      continue;
    }
    if (ch === "$") {
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 256));
      if (tag) {
        const delimiter = tag[0];
        const close = text.indexOf(delimiter, i + delimiter.length);
        const bodyEnd = close === -1 ? text.length : close;
        const end = close === -1 ? text.length : close + delimiter.length;
        const value = text.slice(i + delimiter.length, bodyEnd);
        advance(end);
        push("dollar", value, start, startLine);
        continue;
      }
      let k = i + 1;
      while (k < text.length && /[0-9]/.test(text[k])) k += 1;
      advance(Math.max(k, i + 1));
      push("param", text.slice(start, i), start, startLine);
      continue;
    }
    if (WORD_START.test(ch)) {
      let k = i + 1;
      while (k < text.length && WORD_PART.test(text[k])) k += 1;
      const word = text.slice(i, k);
      // E'...' escape strings, plus B'', X'', N'' and U&'' prefixes.
      if (text[k] === "'" && /^[eEbBxXnN]$/.test(word)) {
        const value = readQuoted(text, k, "'", /^[eE]$/.test(word));
        advance(value.end);
        push("string", value.value, start, startLine);
        continue;
      }
      if (/^[uU]$/.test(word) && text[k] === "&" && (text[k + 1] === "'" || text[k + 1] === '"')) {
        const quote = text[k + 1];
        const value = readQuoted(text, k + 1, quote, false);
        advance(value.end);
        push(quote === "'" ? "string" : "ident", value.value, start, startLine);
        continue;
      }
      advance(k);
      push("word", word.toLowerCase(), start, startLine);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next ?? ""))) {
      let k = i + 1;
      while (k < text.length && /[0-9.eE]/.test(text[k])) k += 1;
      advance(k);
      push("number", text.slice(start, i), start, startLine);
      continue;
    }
    if (ch === ":" && next === ":") {
      advance(i + 2);
      push("punct", "::", start, startLine);
      continue;
    }
    advance(i + 1);
    push("punct", ch, start, startLine);
  }
  return tokens;
}

function readQuoted(text, openIndex, quote, backslashEscapes) {
  let k = openIndex + 1;
  let value = "";
  while (k < text.length) {
    const c = text[k];
    if (backslashEscapes && c === "\\") {
      value += text[k + 1] ?? "";
      k += 2;
      continue;
    }
    if (c === quote) {
      if (text[k + 1] === quote) {
        value += quote;
        k += 2;
        continue;
      }
      return { value, end: k + 1 };
    }
    value += c;
    k += 1;
  }
  return { value, end: text.length };
}

/**
 * Group tokens into top-level statements split on semicolons.
 * @returns {{tokens: object[], start: number, end: number, line: number, text: string}[]}
 */
export function splitStatements(sql) {
  const text = String(sql);
  const statements = [];
  let current = [];
  const flush = (end) => {
    if (current.length === 0) return;
    const start = current[0].start;
    statements.push({ tokens: current, start, end, line: current[0].line, text: text.slice(start, end) });
    current = [];
  };
  for (const token of tokenize(text)) {
    if (token.type === "punct" && token.value === ";") {
      flush(token.start);
      continue;
    }
    current.push(token);
  }
  flush(current.length ? current[current.length - 1].end : text.length);
  return statements;
}

// ---------------------------------------------------------------------------
// Signature parsing and normalisation
// ---------------------------------------------------------------------------

export const isWord = (token, ...values) => token?.type === "word" && (values.length === 0 || values.includes(token.value));
export const isPunct = (token, value) => token?.type === "punct" && token.value === value;

const TYPE_ALIASES = new Map([
  ["int", "integer"],
  ["int4", "integer"],
  ["int8", "bigint"],
  ["int2", "smallint"],
  ["bool", "boolean"],
  ["varchar", "character varying"],
  ["char", "character"],
  ["bpchar", "character"],
  ["float8", "double precision"],
  ["float4", "real"],
  ["float", "double precision"],
  ["decimal", "numeric"],
  ["timestamptz", "timestamp with time zone"],
  ["timestamp", "timestamp without time zone"],
  ["timetz", "time with time zone"],
  ["time", "time without time zone"],
  ["varbit", "bit varying"],
  ["char varying", "character varying"],
]);

const MULTIWORD_TYPE_CONTINUATIONS = new Map([
  ["double", new Set(["precision"])],
  ["character", new Set(["varying"])],
  ["char", new Set(["varying"])],
  ["national", new Set(["character", "char"])],
  ["bit", new Set(["varying"])],
  ["timestamp", new Set(["with", "without"])],
  ["time", new Set(["with", "without"])],
  ["interval", new Set(["year", "month", "day", "hour", "minute", "second"])],
]);

const ARG_MODES = new Set(["in", "out", "inout", "variadic"]);

/**
 * Read a possibly schema-qualified name at index. Unquoted parts are already
 * lowercased by the tokenizer; quoted parts keep their case. Returns
 * {schema, name, next} or null.
 */
export function readQualifiedName(tokens, index) {
  const part = (token) => {
    if (token?.type === "word") return token.value;
    if (token?.type === "ident") return token.value;
    return null;
  };
  const first = part(tokens[index]);
  if (first === null) return null;
  if (isPunct(tokens[index + 1], ".")) {
    const second = part(tokens[index + 2]);
    if (second !== null) return { schema: first, name: second, next: index + 3 };
  }
  return { schema: "public", name: first, next: index + 1 };
}

/** Index of the token closing the parenthesis opened at openIndex. */
function matchParen(tokens, openIndex) {
  let depth = 0;
  for (let k = openIndex; k < tokens.length; k += 1) {
    if (isPunct(tokens[k], "(") || isPunct(tokens[k], "[")) depth += 1;
    else if (isPunct(tokens[k], ")") || isPunct(tokens[k], "]")) {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return tokens.length;
}

function splitTopLevel(tokens, separator = ",") {
  const groups = [];
  let current = [];
  let depth = 0;
  for (const token of tokens) {
    if (isPunct(token, "(") || isPunct(token, "[")) depth += 1;
    if (isPunct(token, ")") || isPunct(token, "]")) depth -= 1;
    if (depth === 0 && isPunct(token, separator)) {
      groups.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length) groups.push(current);
  return groups;
}

function typeTokensToString(tokens) {
  let out = "";
  let array = "";
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (isPunct(token, "(")) {
      k = matchParen(tokens, k);
      continue;
    }
    if (isPunct(token, "[")) {
      array += "[]";
      k = matchParen(tokens, k);
      continue;
    }
    if (isWord(token, "array")) {
      array += "[]";
      continue;
    }
    if (isPunct(token, ".") || isPunct(token, "%")) {
      out += token.value;
      continue;
    }
    if (out && !out.endsWith(".") && !out.endsWith("%")) out += " ";
    out += token.value;
  }
  return { base: out.trim(), array };
}

/** Normalise one type name: lowercase aliases, drop typmods and public/pg_catalog. */
export function normalizeType(tokens) {
  const { base, array } = typeTokensToString(tokens);
  let type = base.replace(/^(public|pg_catalog)\./, "");
  type = TYPE_ALIASES.get(type) ?? type;
  return `${type}${array}`;
}

/** Parse the tokens of one argument. Returns {mode, type} (type normalised). */
function parseArgument(tokens) {
  let end = tokens.length;
  for (let k = 0, depth = 0; k < tokens.length; k += 1) {
    if (isPunct(tokens[k], "(") || isPunct(tokens[k], "[")) depth += 1;
    if (isPunct(tokens[k], ")") || isPunct(tokens[k], "]")) depth -= 1;
    if (depth === 0 && (isWord(tokens[k], "default") || isPunct(tokens[k], "="))) {
      end = k;
      break;
    }
  }
  let rest = tokens.slice(0, end);
  let mode = "in";
  if (rest.length > 1 && isWord(rest[0]) && ARG_MODES.has(rest[0].value)) {
    mode = rest[0].value;
    rest = rest.slice(1);
  }
  if (rest.length > 1 && !startsTypeOnly(rest)) rest = rest.slice(1);
  return { mode, type: normalizeType(rest) };
}

/** True when the token list is a bare type (no leading argument name). */
function startsTypeOnly(tokens) {
  const [first, second] = tokens;
  if (isPunct(second, ".") || isPunct(second, "(") || isPunct(second, "[") || isPunct(second, "%")) return true;
  if (isWord(first) && isWord(second, "array")) return true;
  if (isWord(first) && isWord(second)) {
    const continuations = MULTIWORD_TYPE_CONTINUATIONS.get(first.value);
    if (continuations?.has(second.value)) return true;
  }
  return false;
}

/** Identity argument types (OUT arguments excluded) from the tokens inside the parens. */
export function parseArgumentTypes(tokens) {
  return splitTopLevel(tokens)
    .filter((group) => group.length > 0)
    .map(parseArgument)
    .filter((arg) => arg.mode !== "out")
    .map((arg) => arg.type);
}

export function formatSignature(schema, name, argTypes) {
  return `${schema}.${name}(${argTypes.join(",")})`;
}

/**
 * Parse a function reference (as written in CREATE, ALTER, GRANT or REVOKE)
 * starting at index. Returns {schema, name, args (null when omitted), next}.
 */
function readFunctionReference(tokens, index) {
  const qualified = readQualifiedName(tokens, index);
  if (!qualified) return null;
  if (!isPunct(tokens[qualified.next], "(")) {
    return { schema: qualified.schema, name: qualified.name, args: null, next: qualified.next };
  }
  const close = matchParen(tokens, qualified.next);
  const args = parseArgumentTypes(tokens.slice(qualified.next + 1, close));
  return { schema: qualified.schema, name: qualified.name, args, next: close + 1 };
}

// ---------------------------------------------------------------------------
// Statement analysis
// ---------------------------------------------------------------------------

/** Parse SET search_path value tokens starting at index (after SET search_path). */
function readSearchPathValue(tokens, index) {
  let k = index;
  if (isPunct(tokens[k], "=") || isWord(tokens[k], "to")) k += 1;
  if (isWord(tokens[k], "from") && isWord(tokens[k + 1], "current")) {
    return { schemas: null, raw: "FROM CURRENT" };
  }
  const items = [];
  const rawParts = [];
  while (k < tokens.length) {
    const token = tokens[k];
    if (token.type === "string") {
      rawParts.push(`'${token.value}'`);
      for (const piece of token.value.split(",")) {
        const schema = piece.trim().replace(/^"(.*)"$/, "$1");
        if (schema) items.push(schema);
      }
    } else if (token.type === "word" || token.type === "ident") {
      rawParts.push(token.type === "ident" ? `"${token.value}"` : token.value);
      items.push(token.value);
    } else {
      break;
    }
    k += 1;
    if (!isPunct(tokens[k], ",")) break;
    k += 1;
  }
  return { schemas: items, raw: rawParts.join(", ") };
}

/** Whether a parsed search_path value is pinned safely. Returns a reason string when not. */
export function searchPathProblem(value) {
  if (!value) return "no SET search_path";
  if (value.schemas === null) return `search_path ${value.raw} is not pinned`;
  const schemas = value.schemas.map((schema) => schema.toLowerCase());
  if (schemas.length === 0) return null;
  if (schemas[0] === "public") return `search_path = ${value.raw} starts with public`;
  if (schemas.includes("$user")) return `search_path = ${value.raw} includes "$user"`;
  const tempIndex = schemas.indexOf("pg_temp");
  if (tempIndex !== -1 && tempIndex !== schemas.length - 1) {
    return `search_path = ${value.raw} searches pg_temp before other schemas`;
  }
  return null;
}

function parseCreateFunction(statement) {
  const { tokens } = statement;
  if (!isWord(tokens[0], "create")) return null;
  let k = 1;
  if (isWord(tokens[k], "or") && isWord(tokens[k + 1], "replace")) k += 2;
  if (!isWord(tokens[k], "function")) return null;
  const reference = readFunctionReference(tokens, k + 1);
  if (!reference || reference.args === null) return null;

  let securityDefiner = false;
  let searchPath = null;
  let depth = 0;
  for (let j = reference.next; j < tokens.length; j += 1) {
    const token = tokens[j];
    if (isPunct(token, "(")) depth += 1;
    if (isPunct(token, ")")) depth -= 1;
    if (depth !== 0) continue;
    if (isWord(token, "security") && isWord(tokens[j + 1], "definer")) securityDefiner = true;
    if (isWord(token, "security") && isWord(tokens[j + 1], "invoker")) securityDefiner = false;
    if (isWord(token, "set") && isSearchPathName(tokens[j + 1])) {
      searchPath = readSearchPathValue(tokens, j + 2);
    }
  }
  return {
    kind: "create",
    schema: reference.schema,
    name: reference.name,
    signature: formatSignature(reference.schema, reference.name, reference.args),
    securityDefiner,
    searchPath,
  };
}

function isSearchPathName(token) {
  return (token?.type === "word" || token?.type === "ident") && token.value.toLowerCase() === "search_path";
}

function parseAlterFunction(statement) {
  const { tokens } = statement;
  if (!isWord(tokens[0], "alter") || !isWord(tokens[1], "function")) return null;
  const reference = readFunctionReference(tokens, 2);
  if (!reference) return null;
  let searchPath;
  for (let j = reference.next; j < tokens.length; j += 1) {
    if (isWord(tokens[j], "set") && isSearchPathName(tokens[j + 1])) {
      searchPath = readSearchPathValue(tokens, j + 2);
    }
    if (isWord(tokens[j], "reset") && (isSearchPathName(tokens[j + 1]) || isWord(tokens[j + 1], "all"))) {
      searchPath = null;
    }
  }
  if (searchPath === undefined) return null;
  return { kind: "alter", targets: [reference], searchPath };
}

const PRIVILEGE_OBJECT_WORDS = new Set(["function", "functions", "routine", "routines", "procedure", "procedures"]);

function parsePrivilegeStatement(statement) {
  const { tokens } = statement;
  const verb = tokens[0]?.type === "word" ? tokens[0].value : null;
  if (verb !== "grant" && verb !== "revoke") return null;
  let k = 1;
  if (verb === "revoke" && isWord(tokens[k], "grant") && isWord(tokens[k + 1], "option")) return null;
  const privileges = [];
  while (k < tokens.length && !isWord(tokens[k], "on")) {
    if (tokens[k].type === "word") privileges.push(tokens[k].value);
    k += 1;
  }
  if (!privileges.includes("all") && !privileges.includes("execute")) return null;
  k += 1;
  const roleKeyword = verb === "grant" ? "to" : "from";
  let targets = [];
  let schemas = null;
  if (isWord(tokens[k], "all") && PRIVILEGE_OBJECT_WORDS.has(tokens[k + 1]?.value) && isWord(tokens[k + 2], "in")) {
    k += 4; // ALL FUNCTIONS IN SCHEMA
    schemas = [];
    while (k < tokens.length && !isWord(tokens[k], roleKeyword)) {
      if (tokens[k].type === "word" || tokens[k].type === "ident") schemas.push(tokens[k].value);
      k += 1;
    }
  } else if (isWord(tokens[k]) && PRIVILEGE_OBJECT_WORDS.has(tokens[k].value)) {
    k += 1;
    while (k < tokens.length && !isWord(tokens[k], roleKeyword)) {
      const reference = readFunctionReference(tokens, k);
      if (!reference) {
        k += 1;
        continue;
      }
      targets.push(reference);
      k = reference.next;
      if (isPunct(tokens[k], ",")) k += 1;
    }
  } else {
    return null;
  }
  k += 1;
  const roles = [];
  while (k < tokens.length) {
    const token = tokens[k];
    if (isWord(token, "cascade", "restrict", "granted", "with")) break;
    if (token.type === "word") roles.push(token.value);
    else if (token.type === "ident") roles.push(token.value.toLowerCase() === "public" ? "\"public\"" : token.value);
    k += 1;
    if (!isPunct(tokens[k], ",")) break;
    k += 1;
  }
  if (roles.length === 0) return null;
  return { kind: verb, targets, schemas, roles: roles.map((role) => role.toLowerCase()) };
}

function referenceMatches(reference, definer) {
  if (reference.schema !== definer.schema || reference.name !== definer.name) return false;
  if (reference.args === null) return true;
  return formatSignature(reference.schema, reference.name, reference.args) === definer.signature;
}

function statementTargets(event, definer, eventIndex) {
  if (event.schemas) {
    // Schema-wide statements only cover functions that already exist.
    return eventIndex > definer.statementIndex && event.schemas.includes(definer.schema);
  }
  return event.targets.some((reference) => referenceMatches(reference, definer));
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Lint one migration's SQL text.
 * @returns {{definers: object[], violations: object[]}} violations carry
 *   {file, line, signature, missing, problems, definitionSha256}.
 */
export function lintSql(sql, file) {
  const statements = splitStatements(String(sql).replaceAll("\r\n", "\n"));
  const events = [];
  const definers = [];
  statements.forEach((statement, index) => {
    const parsed =
      parseCreateFunction(statement) ?? parseAlterFunction(statement) ?? parsePrivilegeStatement(statement);
    if (!parsed) return;
    if (parsed.kind === "create") {
      if (parsed.securityDefiner) {
        definers.push({
          ...parsed,
          file,
          line: statement.line,
          statementIndex: index,
          definitionSha256: sha256(statement.text),
        });
      }
      return;
    }
    events.push({ ...parsed, index });
  });

  const violations = [];
  for (const definer of definers) {
    const problems = {};
    let searchPath = definer.searchPath;
    for (const event of events) {
      if (event.kind === "alter" && event.index > definer.statementIndex && statementTargets(event, definer, event.index)) {
        searchPath = event.searchPath;
      }
    }
    const pathProblem = searchPathProblem(searchPath);
    if (pathProblem) problems[MISSING_SEARCH_PATH] = pathProblem;

    // Final state per open role: revoked when some REVOKE names it and no later
    // GRANT to it (or to PUBLIC, which anon inherits) re-opens it.
    const lastRevoke = { public: -1, anon: -1 };
    const lastGrant = { public: -1, anon: -1 };
    let explicitGrant = false;
    for (const event of events) {
      if (event.kind !== "grant" && event.kind !== "revoke") continue;
      if (!statementTargets(event, definer, event.index)) continue;
      for (const role of event.roles) {
        if (event.kind === "revoke" && OPEN_ROLES.has(role)) lastRevoke[role] = event.index;
        if (event.kind === "grant") {
          if (role === "public") {
            lastGrant.public = event.index;
            lastGrant.anon = event.index;
          } else if (role === "anon") {
            lastGrant.anon = event.index;
          } else if (!event.schemas) {
            explicitGrant = true;
          }
        }
      }
    }
    for (const [role, code] of [
      ["public", MISSING_REVOKE_PUBLIC],
      ["anon", MISSING_REVOKE_ANON],
    ]) {
      if (lastRevoke[role] === -1) problems[code] = `no REVOKE ... FROM ${role === "public" ? "PUBLIC" : "anon"}`;
      else if (lastGrant[role] > lastRevoke[role]) problems[code] = `EXECUTE re-granted to ${role} after the REVOKE`;
    }
    if (!explicitGrant) problems[MISSING_GRANT] = "no explicit GRANT EXECUTE to a role other than PUBLIC or anon";

    const missing = MISSING_ORDER.filter((code) => code in problems);
    if (missing.length) {
      violations.push({
        file,
        line: definer.line,
        signature: definer.signature,
        missing,
        problems,
        definitionSha256: definer.definitionSha256,
      });
    }
  }
  return {
    definers: definers.map(({ file: f, line, signature, definitionSha256 }) => ({ file: f, line, signature, definitionSha256 })),
    violations,
  };
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

export function baselineKey(entry) {
  return `${entry.file}\u0000${entry.signature}\u0000${entry.definitionSha256}`;
}

export function toBaselineEntry(violation) {
  return {
    file: violation.file,
    signature: violation.signature,
    missing: [...violation.missing],
    definitionSha256: violation.definitionSha256,
  };
}

export function buildBaseline(violations) {
  const entries = violations.map(toBaselineEntry).sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.signature.localeCompare(b.signature) ||
    a.definitionSha256.localeCompare(b.definitionSha256),
  );
  return {
    schema: BASELINE_SCHEMA,
    description:
      "Existing SECURITY DEFINER violations (OVD-846). Generated by `node scripts/lint-security-definer.mjs --all --write-baseline`. Entries may only be removed.",
    entries,
  };
}

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

/** True when the entry (or violation) is covered: same definition, no extra missing clause. */
function coveredBy(index, entry) {
  const known = index.get(baselineKey(entry));
  return Boolean(known) && entry.missing.every((code) => known.missing.includes(code));
}

/** Entries in the head baseline that the base baseline does not cover. */
export function findBaselineGrowth(baseBaseline, headBaseline) {
  const index = indexBaseline(baseBaseline);
  return (headBaseline?.entries ?? []).filter((entry) => !coveredBy(index, entry));
}

/**
 * Classify a PR's changes as gate_loosening (report only).
 * @param {{baseBaseline?: object|null, headBaseline?: object|null, changedFiles?: {status: string, file: string}[]}} input
 * @returns {{detected: boolean, reasons: object[], requires: string[]}}
 */
export function findGateLoosening({ baseBaseline = null, headBaseline = null, changedFiles = [] } = {}) {
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
          signature: entry.signature,
          migration: entry.file,
          missing_added: missingAdded,
          message: `baseline entry for ${entry.file} ${entry.signature} widened to also allow missing ${missingAdded.join(", ")}`,
        });
      } else {
        reasons.push({
          code: LOOSENING_BASELINE_ADDED,
          file: BASELINE_PATH,
          signature: entry.signature,
          migration: entry.file,
          message: `baseline entry added for ${entry.file} ${entry.signature}`,
        });
      }
    }
  }
  // Only files with a base copy: adding the checker does not loosen it.
  const edited = new Map();
  for (const { status, file } of changedFiles) {
    if (CHECKER_FILES.includes(file) && status !== "A") edited.set(file, status);
  }
  for (const [file, status] of [...edited].sort(([a], [b]) => a.localeCompare(b))) {
    reasons.push({
      code: LOOSENING_CHECKER_CHANGED,
      file,
      status,
      message: `${file} ${status === "D" ? "deleted" : "edited"}; needs review (the base copy ran)`,
    });
  }
  return { detected: reasons.length > 0, reasons, requires: [...GATE_LOOSENING_REQUIRES] };
}

/** Baseline entries the current violations no longer produce (safe to remove). */
export function findStaleBaselineEntries(baseline, violations) {
  const current = new Map(violations.map((violation) => [baselineKey(violation), violation]));
  return (baseline?.entries ?? []).filter((entry) => {
    const violation = current.get(baselineKey(entry));
    return !violation || violation.missing.join(",") !== entry.missing.join(",");
  });
}

/** Split violations into baselined and failing. */
export function applyBaseline(violations, baseline) {
  const index = indexBaseline(baseline);
  return violations.map((violation) => ({ ...violation, baselined: coveredBy(index, violation) }));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatViolation(violation) {
  return violation.missing.map((code) => {
    const detail = violation.problems?.[code];
    const suffix = detail && code === MISSING_SEARCH_PATH ? ` (${detail})` : "";
    return `${violation.file}:${violation.line} ${violation.signature}: missing ${MISSING_LABELS[code]}${suffix}`;
  });
}

/**
 * Lint a set of files and build the report object.
 * gate_loosening is report only and never affects ok.
 * @param {{files: {file: string, sql: string}[], baseline?: object, baseBaseline?: object|null, headBaseline?: object|null, changedFiles?: {status: string, file: string}[], mode?: string, enforce?: boolean}} input
 */
export function lintFiles({
  files,
  baseline = null,
  baseBaseline = null,
  headBaseline = null,
  changedFiles = [],
  mode = "files",
  enforce = false,
}) {
  const definers = [];
  let violations = [];
  for (const { file, sql } of files) {
    const result = lintSql(sql, file);
    definers.push(...result.definers);
    violations.push(...result.violations);
  }
  violations = applyBaseline(violations, baseline);
  const failing = violations.filter((violation) => !violation.baselined);
  const baselineGrowth = baseBaseline && headBaseline ? findBaselineGrowth(baseBaseline, headBaseline) : [];
  const staleBaselineEntries = mode === "full" && baseline ? findStaleBaselineEntries(baseline, violations) : [];
  return {
    schema: REPORT_SCHEMA,
    mode,
    enforce,
    ok: failing.length === 0 && baselineGrowth.length === 0,
    files: files.map(({ file }) => file),
    summary: {
      files: files.length,
      definers: definers.length,
      violations: violations.length,
      baselined: violations.length - failing.length,
      failing: failing.length,
      baselineGrowth: baselineGrowth.length,
      staleBaselineEntries: staleBaselineEntries.length,
    },
    violations,
    baselineGrowth,
    staleBaselineEntries,
    gate_loosening: findGateLoosening({ baseBaseline, headBaseline, changedFiles }),
  };
}

/** Leading report lines: the GATE LOOSENING banner and its reasons (none when not detected). */
export function gateLooseningLines(report) {
  if (!report.gate_loosening?.detected) return [];
  return [
    `${GATE_LOOSENING_LINE} (report only, does not block)`,
    ...report.gate_loosening.reasons.map((reason) => `  gate_loosening ${reason.code}: ${reason.message}`),
  ];
}

/** Summary line tail: stale entry count (full mode) and the PASS/FAIL verdict. */
export function reportVerdict(report) {
  const stale = report.summary.staleBaselineEntries;
  return (
    (report.mode === "full" ? `, ${stale} stale baseline entr${stale === 1 ? "y" : "ies"}` : "") +
    (report.ok ? " — PASS" : report.enforce ? " — FAIL" : " — FAIL (report mode, not enforced)")
  );
}

export function formatReport(report) {
  const lines = gateLooseningLines(report);
  for (const violation of report.violations.filter((v) => !v.baselined)) lines.push(...formatViolation(violation));
  for (const entry of report.baselineGrowth) {
    lines.push(`${BASELINE_PATH}: baseline entry added for ${entry.file} ${entry.signature} (baseline may only shrink)`);
  }
  const s = report.summary;
  lines.push(
    `security-definer-lint: ${s.files} file(s), ${s.definers} SECURITY DEFINER function(s), ` +
      `${s.failing} failing, ${s.baselined} baselined, ${s.baselineGrowth} baseline addition(s)` +
      reportVerdict(report),
  );
  return lines.join("\n");
}

export const escapeAnnotation = (value) => String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** GitHub annotations for unbaselined violations (error under --enforce, else warning). */
export function violationAnnotations(report, formatViolationLines, title) {
  const level = report.enforce ? "error" : "warning";
  return report.violations
    .filter((v) => !v.baselined)
    .flatMap((violation) =>
      formatViolationLines(violation).map(
        (message) => `::${level} file=${violation.file},line=${violation.line},title=${title}::${escapeAnnotation(message)}`,
      ),
    );
}

function githubAnnotations(report) {
  const level = report.enforce ? "error" : "warning";
  const lines = violationAnnotations(report, formatViolation, "SECURITY DEFINER lint");
  for (const entry of report.baselineGrowth) {
    lines.push(`::${level} file=${BASELINE_PATH},title=SECURITY DEFINER baseline::${escapeAnnotation(`baseline entry added for ${entry.signature}`)}`);
  }
  if (report.gate_loosening?.detected) {
    // Report only, so always a warning even under --enforce.
    const files = [...new Set(report.gate_loosening.reasons.map((reason) => reason.file))];
    for (const file of files) {
      const messages = report.gate_loosening.reasons.filter((reason) => reason.file === file).map((reason) => reason.message);
      lines.push(`::warning file=${file},title=${GATE_LOOSENING_LINE.replaceAll(":", "")}::${escapeAnnotation(messages.join("\n"))}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const MIGRATION_PATH = /^supabase\/migrations\/[^/]+\.sql$/;
const NAME_STATUS_LINE = /^([A-Z])(?:\d{1,3})?\t(.+)$/;

/** Parse `git diff --name-status --no-renames` text into {status, file}; bare paths count as modified. */
export function parseNameStatus(nameStatusText) {
  const changes = [];
  for (const raw of String(nameStatusText).split("\n")) {
    const line = raw.replaceAll("\\", "/").trim();
    if (!line) continue;
    const match = NAME_STATUS_LINE.exec(line);
    const status = match ? match[1] : "M";
    const file = (match ? match[2].split("\t").pop() : line).trim();
    changes.push({ status, file });
  }
  return changes;
}

/** Changed migration files (added or modified) from `git diff --name-status --no-renames` text. */
export function changedMigrationFiles(nameStatusText) {
  const files = parseNameStatus(nameStatusText)
    .filter(({ status, file }) => status !== "D" && MIGRATION_PATH.test(file))
    .map(({ file }) => file);
  return [...new Set(files)].sort(compareCodeUnits);
}

export function listMigrationFiles(root) {
  return readdirSync(path.join(root, MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort(compareCodeUnits)
    .map((name) => `${MIGRATIONS_DIR}/${name}`);
}

function parseArgs(argv, allowReport) {
  const options = { all: false, files: [], enforce: false, writeBaseline: false };
  if (allowReport) options.report = false;
  const valueFlags = new Map([
    ["--root", "root"],
    ["--baseline", "baseline"],
    ["--base-ref", "baseRef"],
    ["--json-out", "jsonOut"],
    ["--changed-files-from", "changedFilesFrom"],
  ]);
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    if (arg === "--all") options.all = true;
    else if (arg === "--enforce") options.enforce = true;
    else if (allowReport && arg === "--report") options.report = true;
    else if (arg === "--write-baseline") options.writeBaseline = true;
    else if (valueFlags.has(arg)) {
      const value = argv[k + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[valueFlags.get(arg)] = value;
      k += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  if (options.enforce && options.report) throw new Error("--enforce and --report are mutually exclusive");
  if (options.writeBaseline && !options.all) throw new Error("--write-baseline requires --all");
  if (!options.all && !options.changedFilesFrom && options.files.length === 0) options.all = true;
  return options;
}

export function readRefFile(root, ref, file, { binary = "/usr/bin/git" } = {}) {
  if (process.platform === "win32") throw new Error("git on Windows requires WSL");
  const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 };
  const entry = execFileSync(binary, ["ls-tree", "-z", ref, "--", `:(literal)${file}`], options);
  return entry ? execFileSync(binary, ["show", `${ref}:${file}`], options) : null;
}

export const toJsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * CLI driver shared by the migration lint family (this rule and
 * scripts/lint-rls-new-tables.mjs). rule: {name, baselinePath, parseBaseline,
 * buildBaseline, lintFiles, formatReport, githubAnnotations}, plus optional
 * allowReport (accept --report), withBaseFiles (pass the base copies of changed
 * files to lintFiles) and writeBaselineFirst (write the baseline before reading
 * the existing one).
 */
export function runLintCli(rule, argv, { stdout = console.log, stderr = console.error, env = process.env } = {}) {
  let options;
  try {
    options = parseArgs(argv, rule.allowReport);
  } catch (error) {
    stderr(`${rule.name}: ${error.message}`);
    return 2;
  }
  const root = path.resolve(options.root ?? process.cwd());
  const baselineFile = options.baseline ?? rule.baselinePath;
  const read = (file) => ({ file, sql: readFileSync(path.join(root, file), "utf8") });
  const writeBaseline = (files, mode) => {
    const report = rule.lintFiles({ files: files.map(read), mode });
    const baseline = rule.buildBaseline(report.violations);
    writeFileSync(path.resolve(root, baselineFile), toJsonText(baseline));
    stdout(`${rule.name}: wrote ${baseline.entries.length} baseline entries to ${baselineFile}`);
    return 0;
  };
  try {
    let files;
    let mode;
    let changedFiles = [];
    if (options.all) {
      mode = "full";
      files = listMigrationFiles(root);
    } else if (options.changedFilesFrom) {
      mode = "changed";
      const nameStatus = readFileSync(path.resolve(root, options.changedFilesFrom), "utf8");
      files = changedMigrationFiles(nameStatus);
      changedFiles = parseNameStatus(nameStatus);
    } else {
      mode = "files";
      files = options.files.map((file) => path.relative(root, path.resolve(root, file)).replaceAll("\\", "/"));
    }
    if (options.writeBaseline && rule.writeBaselineFirst) return writeBaseline(files, mode);

    let headBaseline = null;
    try {
      headBaseline = rule.parseBaseline(readFileSync(path.resolve(root, baselineFile), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`${baselineFile}: ${error.message}`);
    }
    let baseBaseline = null;
    let baseFiles = null;
    if (options.baseRef) {
      const text = readRefFile(root, options.baseRef, baselineFile);
      if (text !== null) baseBaseline = rule.parseBaseline(text);
      if (rule.withBaseFiles && mode === "changed") {
        baseFiles = files.map((file) => ({ file, sql: readRefFile(root, options.baseRef, file) }));
      }
    }

    if (options.writeBaseline) return writeBaseline(files, mode);

    const report = rule.lintFiles({
      files: files.map(read),
      ...(rule.withBaseFiles ? { baseFiles } : {}),
      // The base commit's baseline is the allow-list when there is one, so a PR
      // cannot widen it by editing its own copy.
      baseline: baseBaseline ?? headBaseline,
      baseBaseline,
      headBaseline,
      changedFiles,
      mode,
      enforce: options.enforce,
    });
    if (options.jsonOut) writeFileSync(path.resolve(root, options.jsonOut), toJsonText(report));
    if (env.GITHUB_ACTIONS === "true") for (const line of rule.githubAnnotations(report)) stdout(line);
    stdout(rule.formatReport(report));
    return options.enforce && !report.ok ? 1 : 0;
  } catch (error) {
    stderr(`${rule.name}: ${error.message}`);
    return 2;
  }
}

export function main(argv = process.argv.slice(2), io = {}) {
  return runLintCli(
    {
      name: "security-definer-lint",
      baselinePath: BASELINE_PATH,
      parseBaseline,
      buildBaseline,
      lintFiles,
      formatReport,
      githubAnnotations,
    },
    argv,
    io,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

export function compareCodeUnits(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
