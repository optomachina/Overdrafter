import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { headerText, isRetiredDraft } from "./ephemeral-db-apply.mjs";

/**
 * Migration function collision guard (OVD-762 motivation).
 *
 * A SQL function is replaced wholesale by the last `create or replace function`
 * that runs. supabase/migrations is applied in filename order, so a migration
 * that restates an earlier function is ordinary history. A draft under
 * docs/migration-drafts has no place in that order: it is promoted later, and
 * whatever body it carries replaces the deployed one, including a newer body
 * written after the draft was copied. This check finds those draft restatements
 * and fails unless the draft names the body it was written against.
 *
 * Offline and read only: it reads SQL text, never connects to a database and
 * never runs SQL. See docs/migration-function-collisions.md.
 */

export const MIGRATIONS_DIR = "supabase/migrations";
export const DRAFTS_DIR = "docs/migration-drafts";
export const SUPERSESSIONS_FILE = "docs/migration-drafts/function-supersessions.json";

const MD5_PATTERN = /^[0-9a-f]{32}$/;
const WORD_START = /[A-Za-z_\u{80}-\u{10FFFF}]/u;
const WORD_PART = /[A-Za-z_0-9$\u{80}-\u{10FFFF}]/u;
const DIGIT = /[0-9]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u{80}-\u{10FFFF}][A-Za-z_0-9\u{80}-\u{10FFFF}]*)?\$/u;

const ARGUMENT_MODES = ["in", "out", "inout", "variadic"];
const MULTIWORD_TYPES = [
  ["double", "precision"],
  ["character", "varying"],
  ["bit", "varying"],
  ["timestamp", "with"],
  ["timestamp", "without"],
  ["time", "with"],
  ["time", "without"],
  ["national", "character"],
];
const TYPE_ALIASES = new Map([
  ["int", "integer"],
  ["int4", "integer"],
  ["int8", "bigint"],
  ["int2", "smallint"],
  ["bool", "boolean"],
  ["float8", "double precision"],
  ["float4", "real"],
  ["varchar", "character varying"],
  ["decimal", "numeric"],
  ["timestamp with time zone", "timestamptz"],
  ["timestamp without time zone", "timestamp"],
  ["time with time zone", "timetz"],
  ["time without time zone", "time"],
]);

function md5(text) {
  return createHash("md5").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Lexing. Comments are dropped; strings, quoted identifiers and dollar quoted
// bodies are single tokens, so a `create function` inside a DO block, a body or
// a string is never read as a definition.
// ---------------------------------------------------------------------------

function skipLineComment(sql, index) {
  const eol = sql.indexOf("\n", index);
  return eol === -1 ? sql.length : eol;
}

function skipBlockComment(sql, index) {
  let depth = 1;
  let cursor = index + 2;
  while (cursor < sql.length && depth > 0) {
    const pair = sql.slice(cursor, cursor + 2);
    if (pair === "/*") {
      depth += 1;
      cursor += 2;
    } else if (pair === "*/") {
      depth -= 1;
      cursor += 2;
    } else {
      cursor += 1;
    }
  }
  return cursor;
}

/** Reads a quoted run starting after the opening quote; a doubled quote is one literal quote. */
function readQuoted(sql, start, quote, backslashEscapes) {
  let cursor = start;
  let value = "";
  while (cursor < sql.length) {
    const char = sql[cursor];
    if (backslashEscapes && char === "\\") {
      value += sql[cursor + 1] ?? "";
      cursor += 2;
    } else if (char === quote && sql[cursor + 1] === quote) {
      value += quote;
      cursor += 2;
    } else if (char === quote) {
      return { value, end: cursor + 1 };
    } else {
      value += char;
      cursor += 1;
    }
  }
  return { value, end: cursor };
}

function readDollarQuoted(sql, index) {
  const tag = DOLLAR_TAG.exec(sql.slice(index, index + 80));
  if (!tag) return null;
  const bodyStart = index + tag[0].length;
  const close = sql.indexOf(tag[0], bodyStart);
  if (close === -1) return { value: sql.slice(bodyStart), end: sql.length };
  return { value: sql.slice(bodyStart, close), end: close + tag[0].length };
}

function readRunEnd(sql, index, pattern) {
  let cursor = index + 1;
  while (cursor < sql.length && pattern.test(sql[cursor])) cursor += 1;
  return cursor;
}

function readLiteral(sql, index) {
  const char = sql[index];
  const next = sql[index + 1];
  if (char === "'") {
    const { value, end } = readQuoted(sql, index + 1, "'", false);
    return { token: { type: "string", value }, end };
  }
  if ((char === "e" || char === "E") && next === "'") {
    const { value, end } = readQuoted(sql, index + 2, "'", true);
    return { token: { type: "string", value }, end };
  }
  if (char === '"') {
    const { value, end } = readQuoted(sql, index + 1, '"', false);
    return { token: { type: "ident", value }, end };
  }
  if (char === "$") {
    const dollar = readDollarQuoted(sql, index);
    if (dollar) return { token: { type: "dollar", value: dollar.value }, end: dollar.end };
  }
  return null;
}

function nextLexeme(sql, index) {
  const char = sql[index];
  if (/\s/.test(char)) return { end: index + 1 };
  if (char === "-" && sql[index + 1] === "-") return { end: skipLineComment(sql, index) };
  if (char === "/" && sql[index + 1] === "*") return { end: skipBlockComment(sql, index) };
  const literal = readLiteral(sql, index);
  if (literal) return literal;
  if (WORD_START.test(char)) {
    const end = readRunEnd(sql, index, WORD_PART);
    return { token: { type: "word", value: sql.slice(index, end) }, end };
  }
  if (DIGIT.test(char)) {
    const end = readRunEnd(sql, index, DIGIT);
    return { token: { type: "number", value: sql.slice(index, end) }, end };
  }
  return { token: { type: "punct", value: char }, end: index + 1 };
}

function countNewlines(sql, from, to) {
  let count = 0;
  for (let cursor = from; cursor < to; cursor += 1) {
    if (sql[cursor] === "\n") count += 1;
  }
  return count;
}

export function tokenizeSql(sql) {
  const tokens = [];
  let index = 0;
  let line = 1;
  while (index < sql.length) {
    const { token, end } = nextLexeme(sql, index);
    if (token) tokens.push({ ...token, line });
    line += countNewlines(sql, index, end);
    index = end;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Function identity: schema, name and input argument types.
// ---------------------------------------------------------------------------

function isWord(token, ...values) {
  return token?.type === "word" && values.includes(token.value.toLowerCase());
}

function isPunct(token, value) {
  return token?.type === "punct" && token.value === value;
}

function identifierValue(token) {
  return token.type === "ident" ? token.value : token.value.toLowerCase();
}

function canonicalType(text) {
  let type = text.toLowerCase().replace(/\s+/g, " ").trim();
  type = type.replace(/\s*\.\s*/g, ".").replace(/\s*\[\s*\d*\s*\]/g, "[]");
  type = type.replace(/\b(?:public|pg_catalog)\./g, "");
  let suffix = "";
  while (type.endsWith("[]")) {
    suffix += "[]";
    type = type.slice(0, -2).trim();
  }
  // A length, precision or scale never changes which function is meant.
  type = type.replace(/\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\)/g, "");
  return `${TYPE_ALIASES.get(type) ?? type}${suffix}`;
}

function startsMultiwordType(first, second) {
  return first.type === "word" && MULTIWORD_TYPES.some(
    ([head, tail]) => first.value.toLowerCase() === head && isWord(second, tail),
  );
}

/** `[mode] [name] type [default expr]` to the canonical type text. */
function argumentType(argumentTokens) {
  let tokens = argumentTokens;
  const cut = tokens.findIndex((token, position) => position > 0 && (isWord(token, "default") || isPunct(token, "=")));
  if (cut !== -1) tokens = tokens.slice(0, cut);
  if (isWord(tokens[0], ...ARGUMENT_MODES)) tokens = tokens.slice(1);
  if (tokens.length > 1 && ["word", "ident"].includes(tokens[0].type)) {
    const [first, second] = tokens;
    const typeStartsHere = isPunct(second, ".") || isPunct(second, "(") || isPunct(second, "[")
      || startsMultiwordType(first, second);
    if (!typeStartsHere) tokens = tokens.slice(1);
  }
  return canonicalType(tokens.map((token) => token.value).join(" "));
}

function splitTopLevel(tokens) {
  const groups = [];
  let depth = 0;
  let current = [];
  for (const token of tokens) {
    if (isPunct(token, "(") || isPunct(token, "[")) depth += 1;
    if (isPunct(token, ")") || isPunct(token, "]")) depth -= 1;
    if (isPunct(token, ",") && depth === 0) {
      groups.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Tokens inside the parentheses that open at `open`, and the index after the matching close. */
function readParenthesized(tokens, open) {
  let depth = 0;
  const inner = [];
  for (let cursor = open + 1; cursor < tokens.length; cursor += 1) {
    if (isPunct(tokens[cursor], "(")) depth += 1;
    if (isPunct(tokens[cursor], ")")) {
      if (depth === 0) return { inner, end: cursor + 1 };
      depth -= 1;
    }
    inner.push(tokens[cursor]);
  }
  return { inner, end: tokens.length };
}

/** Reads `[schema.]name(args)` starting at `start`; null when it is not that shape. */
function readSignature(tokens, start) {
  let cursor = start;
  const nameTokens = [];
  while (cursor < tokens.length && !isPunct(tokens[cursor], "(") && !isPunct(tokens[cursor], ";")) {
    if (!isPunct(tokens[cursor], ".")) nameTokens.push(tokens[cursor]);
    cursor += 1;
  }
  const namesOk = nameTokens.length >= 1 && nameTokens.length <= 2
    && nameTokens.every((token) => ["word", "ident"].includes(token.type));
  if (!isPunct(tokens[cursor], "(") || !namesOk) return null;
  const { inner, end } = readParenthesized(tokens, cursor);
  const argumentTypes = splitTopLevel(inner)
    .filter((group) => !isWord(group[0], "out"))
    .map(argumentType);
  const schema = nameTokens.length === 2 ? identifierValue(nameTokens[0]) : "public";
  const name = identifierValue(nameTokens.at(-1));
  return { signature: `${schema}.${name}(${argumentTypes.join(",")})`, end };
}

function readBody(tokens, start) {
  for (let cursor = start; cursor < tokens.length && !isPunct(tokens[cursor], ";"); cursor += 1) {
    if (isWord(tokens[cursor], "as") && ["dollar", "string"].includes(tokens[cursor + 1]?.type)) {
      return tokens[cursor + 1].value;
    }
  }
  return null;
}

function readCreate(tokens, position) {
  let cursor = position + 1;
  if (isWord(tokens[cursor], "or") && isWord(tokens[cursor + 1], "replace")) cursor += 2;
  if (!isWord(tokens[cursor], "function", "procedure")) return null;
  const identity = readSignature(tokens, cursor + 1);
  if (!identity) return null;
  const body = readBody(tokens, identity.end);
  return {
    action: "define",
    signature: identity.signature,
    bodyMd5: body === null ? null : md5(body),
    bodyBytes: body === null ? null : Buffer.byteLength(body, "utf8"),
    line: tokens[position].line,
  };
}

function readDrops(tokens, position) {
  let cursor = position + 1;
  if (!isWord(tokens[cursor], "function", "procedure")) return [];
  cursor += 1;
  if (isWord(tokens[cursor], "if") && isWord(tokens[cursor + 1], "exists")) cursor += 2;
  const drops = [];
  for (;;) {
    const identity = readSignature(tokens, cursor);
    if (!identity) break;
    drops.push({ action: "drop", signature: identity.signature, line: tokens[position].line });
    if (!isPunct(tokens[identity.end], ",")) break;
    cursor = identity.end + 1;
  }
  return drops;
}

/**
 * Every top level `create [or replace] function|procedure` (identity plus the md5
 * of its body, the value `md5(pg_proc.prosrc)` shows for a dollar quoted body) and
 * every `drop function|procedure`, in source order.
 */
export function scanFunctionEvents(sql) {
  const tokens = tokenizeSql(sql);
  const events = [];
  tokens.forEach((token, position) => {
    if (isWord(token, "create")) {
      const created = readCreate(tokens, position);
      if (created) events.push(created);
    } else if (isWord(token, "drop")) {
      events.push(...readDrops(tokens, position));
    }
  });
  return events;
}

// ---------------------------------------------------------------------------
// Reading the tree.
// ---------------------------------------------------------------------------

function listSqlFiles(root, relativeDir) {
  let entries;
  try {
    entries = readdirSync(path.join(root, relativeDir), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => `${relativeDir}/${entry.name}`)
    .sort((left, right) => left.localeCompare(right));
}

function withSource(events, file, kind) {
  return events.map((event) => ({ ...event, file, kind }));
}

/**
 * Events from every migration (in filename order) and every forward draft.
 *
 * Skipped drafts: `.rollback.sql` files restore the body they replaced by design
 * and run only as the inverse of their own forward file; a draft whose header says
 * SUPERSEDED or "Do not apply this draft" is kept as history only (the same rule
 * scripts/ephemeral-db-apply.mjs uses to retire a draft).
 */
export function collectFunctionEvents(root) {
  const events = [];
  for (const file of listSqlFiles(root, MIGRATIONS_DIR)) {
    const sql = readFileSync(path.join(root, file), "utf8");
    events.push(...withSource(scanFunctionEvents(sql), file, "migration"));
  }
  for (const file of listSqlFiles(root, DRAFTS_DIR)) {
    if (file.endsWith(".rollback.sql")) continue;
    const sql = readFileSync(path.join(root, file), "utf8");
    if (isRetiredDraft(headerText(sql))) continue;
    events.push(...withSource(scanFunctionEvents(sql), file, "draft"));
  }
  return events;
}

export function parseSupersessions(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${SUPERSESSIONS_FILE} is not valid JSON: ${error.message}`);
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.supersessions)) {
    throw new Error(`${SUPERSESSIONS_FILE} must be {"version": 1, "supersessions": [...]}`);
  }
  return parsed.supersessions.map((entry, index) => {
    for (const field of ["signature", "file", "supersedesMd5", "reason"]) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`${SUPERSESSIONS_FILE} supersessions[${index}]: "${field}" must be a non-empty string`);
      }
    }
    if (!MD5_PATTERN.test(entry.supersedesMd5)) {
      throw new Error(`${SUPERSESSIONS_FILE} supersessions[${index}]: "supersedesMd5" must be 32 lowercase hex characters`);
    }
    const { signature, file, supersedesMd5, reason } = entry;
    return { signature, file, supersedesMd5, reason };
  });
}

// ---------------------------------------------------------------------------
// Decision.
// ---------------------------------------------------------------------------

function byFileThenLine(left, right) {
  return left.file.localeCompare(right.file) || left.line - right.line;
}

/**
 * Migrations apply in filename order, so the deployed body is the last migration
 * event (a trailing drop leaves none). Every body any migration ever carried is
 * history: a draft equal to one of them is an archived copy of something already
 * promoted, not a promotion candidate. What is left, one definition per draft
 * file, is the set of bodies that can still be promoted.
 */
function classifySignature(group) {
  const history = new Set();
  let deployed = null;
  for (const event of group.filter((item) => item.kind === "migration").sort(byFileThenLine)) {
    if (event.action === "define") {
      history.add(event.bodyMd5);
      deployed = event;
    } else {
      deployed = null;
    }
  }
  const lastPerDraft = new Map();
  for (const event of group.filter((item) => item.kind === "draft" && item.action === "define").sort(byFileThenLine)) {
    lastPerDraft.set(event.file, event);
  }
  const pending = [...lastPerDraft.values()]
    .filter((event) => !history.has(event.bodyMd5))
    .sort(byFileThenLine);
  return { deployed, pending };
}

function describe(event) {
  return `${event.file} (md5 ${event.bodyMd5})`;
}

function entrySnippet(signature, file, supersedesMd5) {
  return JSON.stringify({ signature, file, supersedesMd5, reason: "<why the draft may replace that body>" });
}

function createAllowlist(supersessions) {
  const used = new Set();
  const indexesFor = ([file, signature, supersedesMd5]) => supersessions.flatMap((entry, index) => (
    entry.file === file && entry.signature === signature && entry.supersedesMd5 === supersedesMd5 ? [index] : []
  ));
  return {
    /** True when an entry matches any of the [file, signature, md5] lookups; matching entries count as used. */
    accepts(...lookups) {
      const matches = lookups.flatMap(indexesFor);
      matches.forEach((index) => used.add(index));
      return matches.length > 0;
    },
    unused: () => supersessions.filter((_, index) => !used.has(index)),
  };
}

function groupBySignature(events) {
  const groups = new Map();
  for (const event of events) {
    const group = groups.get(event.signature) ?? [];
    group.push(event);
    groups.set(event.signature, group);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right));
}

function deployedViolation(signature, draft, deployed) {
  return `${signature}: ${describe(draft)} would replace the deployed body from ${describe(deployed)} and does not name it as superseded. `
    + `Rebase the draft onto that body, then add ${entrySnippet(signature, draft.file, deployed.bodyMd5)} to ${SUPERSESSIONS_FILE}.`;
}

function pairViolation(signature, first, second) {
  return `${signature}: ${describe(first)} and ${describe(second)} define it differently, and whichever is promoted second replaces the other. `
    + `Add ${entrySnippet(signature, second.file, first.bodyMd5)} to ${SUPERSESSIONS_FILE} (an entry on either draft clears the pair).`;
}

function signatureViolations(signature, group, allowlist) {
  const { deployed, pending } = classifySignature(group);
  const violations = [];
  pending.forEach((draft, position) => {
    if (deployed && !allowlist.accepts([draft.file, signature, deployed.bodyMd5])) {
      violations.push(deployedViolation(signature, draft, deployed));
    }
    for (const other of pending.slice(position + 1)) {
      const accepted = other.bodyMd5 === draft.bodyMd5
        || allowlist.accepts([draft.file, signature, other.bodyMd5], [other.file, signature, draft.bodyMd5]);
      if (!accepted) violations.push(pairViolation(signature, draft, other));
    }
  });
  return violations;
}

/**
 * Pure decision over the events from collectFunctionEvents and the entries from
 * parseSupersessions. Returns violation lines, sorted; empty means clean.
 *
 * For each signature, every promotable draft body must be accounted for:
 *   - against the deployed body, the draft's file names that body's md5;
 *   - against another promotable draft body, either draft's file names the other's md5.
 * An entry that no longer accounts for anything is a violation too, so the list
 * cannot rot into a standing waiver and a rebase that changes a body is noticed.
 */
export function findFunctionCollisions(events, supersessions = []) {
  const allowlist = createAllowlist(supersessions);
  const unreadable = events.filter((event) => event.action === "define" && event.bodyMd5 === null);
  const violations = unreadable.map((event) => (
    `${event.file}:${event.line}: ${event.signature} has no body this check can read; use a dollar quoted or single quoted AS body.`
  ));
  const readable = events.filter((event) => event.action === "drop" || event.bodyMd5 !== null);
  for (const [signature, group] of groupBySignature(readable)) {
    violations.push(...signatureViolations(signature, group, allowlist));
  }
  for (const entry of allowlist.unused()) {
    violations.push(
      `${SUPERSESSIONS_FILE}: unused entry for ${entry.signature} in ${entry.file} naming md5 ${entry.supersedesMd5}: `
      + "that draft no longer defines the function, or nothing it would replace has that body. Remove or update the entry.",
    );
  }
  return violations.sort((left, right) => left.localeCompare(right));
}

export function inspectFunctionCollisions(root) {
  const events = collectFunctionEvents(root);
  let supersessions = [];
  try {
    supersessions = parseSupersessions(readFileSync(path.join(root, SUPERSESSIONS_FILE), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return findFunctionCollisions(events, supersessions);
}

function parseRoot(argv) {
  const flag = argv.indexOf("--root");
  return flag === -1 ? process.cwd() : path.resolve(argv[flag + 1] ?? "");
}

function main() {
  let violations;
  try {
    violations = inspectFunctionCollisions(parseRoot(process.argv.slice(2)));
  } catch (error) {
    console.error(`Migration function collision check could not run: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (violations.length > 0) {
    console.error("Migration function collision check failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Migration function collision check passed.");
}

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isDirectExecution) {
  main();
}
