import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  GATE_LOOSENING_LINE as SHARED_GATE_LOOSENING_LINE,
  GATE_LOOSENING_REQUIRES,
  SENSITIVE_CLASSES,
  SENSITIVE_PATHS_FILE,
  compileGlob,
  createMatcher,
  findGateLoosening,
  loadSensitivePaths,
  normalizePath,
  readSensitivePathsText,
} from "./lib/sensitive-paths.mjs";
import { safeInline } from "./proof-check.mjs";

/**
 * Sensitive-class detector (OVD-844, report mode). Classifies every file a PR
 * changes into sensitive classes and auto-merge safe categories and writes a
 * head-sha-keyed JSON result for the auto-merge eligibility check (OVD-845).
 *
 * Path classes come only from the shared sensitive-paths list (OVD-873):
 * docs/sensitive-paths.json through scripts/lib/sensitive-paths.mjs, both
 * read from this checkout's working tree (the base, in CI), never from a ref.
 * This detector never copies those globs. scripts/sensitive-classes.json
 * holds only what this detector adds: SQL content rules (rls, definer) over
 * changed SQL read at the PR head, and the auto-merge safe categories.
 *
 * The CLI runs from the base checkout. It reads the changed files and their
 * status from the GitHub API and reads changed SQL files at the PR head as
 * data only; nothing from the PR is executed. Sensitive classes win over safe
 * categories, and the detector fails closed: a file is non-sensitive only when
 * it has a safe category and no sensitive class. Any other file (no class and
 * no safe category, or a rename whose two names land in different categories)
 * gets the pseudo-class "unclassified". Any config, API, truncation or
 * file-list problem sets status "error" so a consumer fails closed. Every
 * path is checked to be a non-empty string, and an empty file list must be
 * the PR's own count of zero, before the shared matcher sees it:
 * the matcher reads a non-string as its string form and an empty list as not
 * sensitive.
 *
 * Output schema change for OVD-845 (version 2). The OVD-844 design's version 1
 * example used this detector's own class names; classes are now the shared
 * list's (schema, migrations, auth, payments, provider_dispatch, secrets,
 * infra_ci, deps) followed by the SQL content classes (rls, definer):
 *   migration  -> migrations, plus schema for any .sql, supabase/config.toml
 *                 and docs/migration-drafts/** (so a migration is both)
 *   billing    -> payments
 *   provider   -> provider_dispatch
 *   ci, infra  -> infra_ci
 *   auth, secrets, deps -> unchanged
 *   rls, definer -> unchanged, from SQL content only (a path naming rls at
 *                 the start of a name or after -, _, . or , is auth on the
 *                 shared list; rls after any other character, or at a
 *                 camelCase boundary such as quoteRls, is not: a glob that
 *                 matched it would also match src/lib/urls.ts. The coverage
 *                 sweep test, sensitive-class-sweep.test.mjs, checks the
 *                 residual against 0163daf7's rules)
 *   unclassified -> now a pseudo-class owned by this detector (below)
 * Fail closed (still version 2; changed before OVD-845 consumed any result):
 * a file with no sensitive class and no safe category has classes
 * ["unclassified"] and reason "unclassified:no-safe-category", so it counts in
 * sensitive_count and in classes / multi_class like any other class. The
 * result's classes list "unclassified" last. The top-level unclassified array
 * still lists those files' paths. A file with a safe category and no
 * sensitive class (classes [], category set) is the only non-sensitive file.
 * files[].reasons read "<class>:path:<glob>" (one per matching shared glob),
 * "<class>:sql:<tokens>", "<category>:path:<glob>" or
 * "unclassified:no-safe-category"; a rename's old name is prefixed
 * "previous:". gate_loosening.reasons hold this detector's reasons
 * ({kind, path, message, ...}) and the shared list's findGateLoosening
 * reasons, which keep every field and gain kind (its code), path (its file)
 * and source "sensitive-paths".
 *
 * gate_loosening (report only) is judged by this base copy, so a PR editing
 * the detector, its config, the shared list or the matcher cannot change its
 * own judgement: this detector diffs the base and head copies of its config,
 * and the shared list's findGateLoosening judges docs/sensitive-paths.json and
 * the code that applies it (GATE_CODE_FILES).
 *
 * OVD-845 requirement: the uploaded artifact is not a trusted gate by itself.
 * Under pull_request the workflow YAML comes from the PR, so a PR can edit
 * .github/workflows/sensitive-class.yml (or add a workflow that uploads an
 * artifact named sensitive-class) and publish a clean result. Before OVD-845
 * relies on this result it must either recompute it in a trusted context
 * (workflow_run, or pull_request_target with a base checkout and no head
 * code executed) or confirm from the API file list, independently of the
 * artifact, that the PR touches no .github/** file. In both cases it must
 * check that the producing run's workflow path is
 * .github/workflows/sensitive-class.yml and its head sha is the PR head, and
 * treat a missing artifact as needs-Blaine.
 */

export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const CONFIG_REPO_PATH = "scripts/sensitive-classes.json";
export const CONFIG_PATH = path.join(REPO_ROOT, CONFIG_REPO_PATH);
export const CONFIG_VERSION = 1;
export const OUTPUT_VERSION = 2;
/** Classes that only SQL content rules give. */
export const SQL_CONTENT_CLASSES = Object.freeze(["rls", "definer"]);
/** The pseudo-class of a file with no sensitive class and no safe category (fail closed). */
export const UNCLASSIFIED = "unclassified";
/** Every output class, in output order. */
export const OUTPUT_CLASSES = Object.freeze([...SENSITIVE_CLASSES, ...SQL_CONTENT_CLASSES, UNCLASSIFIED]);
export const MAX_FILES = 3000;
const PER_PAGE = 100;

const TOP_KEYS = new Set(["version", "description", "syntax", "sql_content", "safe_categories"]);
const CATEGORY_KEYS = new Set(["description", "paths", "path_keywords", "exclude", "exclude_keywords"]);
const SQL_KEYS = new Set(["paths", "rules"]);
const SQL_RULE_KEYS = new Set(["class", "tokens"]);
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const KEYWORD_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------- paths

/**
 * A path the shared matcher may see: a non-empty string that is still
 * non-empty once trimmed and once its leading ./ or / is removed.
 */
export function isValidPath(value) {
  return typeof value === "string" && value.trim() !== "" && normalizePath(value) !== "";
}

/** Split a path into lower-case words on non-alphanumerics and camelCase boundaries. */
export function pathWords(path) {
  return String(path)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * A keyword matches consecutive path words; its last part may prefix the last
 * word. With `anywhere` (exclusions, which must fail closed) the first part
 * may also end the first word, so a one-word keyword matches inside a word
 * ('auth' matches 'unauthorized').
 */
function keywordMatches(words, keyword, anywhere = false) {
  const parts = keyword.split("-");
  const last = parts.length - 1;
  const matchPart = (word, part, offset) => {
    if (anywhere && offset === 0) return last === 0 ? word.includes(part) : word.endsWith(part);
    return offset === last ? word.startsWith(part) : word === part;
  };
  for (let start = 0; start + parts.length <= words.length; start += 1) {
    if (parts.every((part, offset) => matchPart(words[start + offset], part, offset))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- config

function stringList(value, where, errors, pattern) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    errors.push(`${where} must be an array of non-empty strings`);
    return [];
  }
  if (pattern) {
    for (const item of value) if (!pattern.test(item)) errors.push(`${where} has invalid keyword "${item}"`);
  }
  return value;
}

// The shared matcher's glob syntax and semantics (picomatch with dot and nocase).
function compileGlobs(list, where, errors) {
  return list.flatMap((glob) => {
    try {
      return [compileGlob(glob)];
    } catch (error) {
      errors.push(`${where}: ${messageOf(error)}`);
      return [];
    }
  });
}

function compileCategory(name, entry, errors) {
  const where = `safe_categories.${name}`;
  if (!NAME_PATTERN.test(name)) errors.push(`${where}: invalid name`);
  if (OUTPUT_CLASSES.includes(name)) errors.push(`${where}: name collides with a class`);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  for (const key of Object.keys(entry)) if (!CATEGORY_KEYS.has(key)) errors.push(`${where}: unknown rule key "${key}"`);
  const paths = stringList(entry.paths, `${where}.paths`, errors);
  return {
    name,
    paths: compileGlobs(paths, `${where}.paths`, errors),
    pathGlobs: paths,
    keywords: stringList(entry.path_keywords, `${where}.path_keywords`, errors, KEYWORD_PATTERN),
    exclude: compileGlobs(stringList(entry.exclude, `${where}.exclude`, errors), `${where}.exclude`, errors),
    excludeKeywords: stringList(entry.exclude_keywords, `${where}.exclude_keywords`, errors, KEYWORD_PATTERN),
  };
}

/**
 * Validate and compile the parsed detector config (SQL content rules and safe
 * categories). Unknown keys (a "classes" section included: path classes live
 * in docs/sensitive-paths.json), bad globs and SQL rules for a class outside
 * SQL_CONTENT_CLASSES are errors, never silently ignored.
 * @returns {{config: object|null, errors: string[]}}
 */
export function compileConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config: null, errors: ["config must be a JSON object"] };
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) errors.push(`config: unknown key "${key}"`);
  if (raw.version !== CONFIG_VERSION) errors.push(`config: version must be ${CONFIG_VERSION}`);
  let categories = [];
  const rawCategories = raw.safe_categories;
  if (!rawCategories || typeof rawCategories !== "object" || Array.isArray(rawCategories) || Object.keys(rawCategories).length === 0) {
    errors.push("config: safe_categories must be a non-empty object");
  } else {
    categories = Object.entries(rawCategories).map(([name, entry]) => compileCategory(name, entry, errors)).filter(Boolean);
  }

  const sql = raw.sql_content;
  let sqlContent = { paths: [], rules: [] };
  if (!sql || typeof sql !== "object" || Array.isArray(sql)) {
    errors.push("config: sql_content must be an object");
  } else {
    for (const key of Object.keys(sql)) if (!SQL_KEYS.has(key)) errors.push(`sql_content: unknown rule key "${key}"`);
    const rules = Array.isArray(sql.rules) ? sql.rules : (errors.push("sql_content.rules must be an array"), []);
    sqlContent = {
      paths: compileGlobs(stringList(sql.paths, "sql_content.paths", errors), "sql_content.paths", errors),
      rules: rules.flatMap((rule, index) => {
        const where = `sql_content.rules[${index}]`;
        if (!rule || typeof rule !== "object") return errors.push(`${where} must be an object`), [];
        for (const key of Object.keys(rule)) if (!SQL_RULE_KEYS.has(key)) errors.push(`${where}: unknown rule key "${key}"`);
        if (!SQL_CONTENT_CLASSES.includes(rule.class)) errors.push(`${where}: unknown class "${rule.class}"`);
        const tokens = stringList(rule.tokens, `${where}.tokens`, errors, /^[a-z_]+$/);
        if (tokens.length === 0) errors.push(`${where}.tokens must not be empty`);
        return [{ class: rule.class, tokens }];
      }),
    };
  }
  return errors.length ? { config: null, errors } : { config: { categories, sqlContent }, errors: [] };
}

/**
 * Load the detector config and the shared sensitive-paths list from one
 * checkout. The list is read from root's working tree (never a git ref), so
 * in CI the base checkout's copy judges the PR. Any read, parse or validation
 * failure becomes an error and config is null.
 * @returns {{config: object|null, errors: string[], raw?: object, sensitivePathsText?: string}}
 */
export function loadConfig({ root = REPO_ROOT, file = path.join(root, CONFIG_REPO_PATH) } = {}) {
  const errors = [];
  let raw;
  let compiled = null;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`config could not be read: ${messageOf(error)}`);
  }
  if (errors.length === 0) {
    const result = compileConfig(raw);
    compiled = result.config;
    errors.push(...result.errors);
  }
  let matcher = null;
  let sensitivePathsText = null;
  try {
    matcher = createMatcher(loadSensitivePaths({ root }));
    sensitivePathsText = readSensitivePathsText({ root });
  } catch (error) {
    errors.push(`${SENSITIVE_PATHS_FILE} could not be loaded: ${messageOf(error)}`);
  }
  if (errors.length) return { config: null, errors, raw };
  return { config: { ...compiled, matcher }, errors: [], raw, sensitivePathsText };
}

// ---------------------------------------------------------------- classify

function entryReason(entry, path, words) {
  if (entry.exclude.some((re) => re.test(path))) return null;
  if (entry.excludeKeywords.some((keyword) => keywordMatches(words, keyword, true))) return null;
  const glob = entry.paths.findIndex((re) => re.test(path));
  if (glob !== -1) return `path:${entry.pathGlobs[glob]}`;
  const keyword = entry.keywords.find((candidate) => keywordMatches(words, candidate));
  return keyword ? `path_keyword:${keyword}` : null;
}

/**
 * Classify one path. Its classes are the shared list's (config.matcher, every
 * spelling of the path); the first matching safe category applies only when
 * no class matched. A path with neither has classes [] and category null here;
 * detect gives its file the "unclassified" class. Throws on a path isValidPath
 * rejects.
 * @returns {{classes: string[], category: string|null, reasons: string[]}}
 */
export function classifyPath(path, config) {
  if (!isValidPath(path)) throw new TypeError(`invalid path ${JSON.stringify(path)}`);
  const matches = config.matcher.match(path);
  const classes = SENSITIVE_CLASSES.filter((name) => matches.some((entry) => entry.class === name));
  if (classes.length) {
    const reasons = classes.flatMap((name) => matches.filter((entry) => entry.class === name).map((entry) => `${name}:path:${entry.glob}`));
    return { classes, category: null, reasons };
  }
  const words = pathWords(path);
  for (const entry of config.categories) {
    const reason = entryReason(entry, path, words);
    if (reason) return { classes, category: entry.name, reasons: [`${entry.name}:${reason}`] };
  }
  return { classes, category: null, reasons: [] };
}

// ---------------------------------------------------------------- SQL

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
const MAX_SQL_DEPTH = 8;
/** SQL bodies that tokenize to more than this many tokens are not scanned; they fail closed. */
export const MAX_SQL_TOKENS = 100_000;

/** Thrown by sqlWords when a body exceeds the token budget. */
export class SqlTooLargeError extends Error {}

/**
 * Tokenize SQL text into lower-case words, dropping line and (nested) block
 * comments and quoted identifiers. Every single-quoted, E'' and dollar-quoted
 * string is tokenized recursively as SQL, because a string can be code: a DO
 * block (`DO LANGUAGE plpgsql $$…$$`), an old-style function body
 * (`AS '…'`) or dynamic SQL (`EXECUTE '…'`, `EXECUTE $q$…$q$`). This fails
 * closed: a string literal that merely mentions CREATE POLICY also matches.
 * Below MAX_SQL_DEPTH nesting levels the body is split into plain words.
 */
export function sqlWords(text) {
  return tokenizeSql(String(text), 0, new SqlBudget());
}

/** Shared token budget across one body and every string nested inside it. */
class SqlBudget {
  left = MAX_SQL_TOKENS;

  take() {
    this.left -= 1;
    if (this.left < 0) throw new SqlTooLargeError(`more than ${MAX_SQL_TOKENS} tokens`);
  }
}

const isWordChar = (char) => /[A-Za-z0-9_]/.test(char ?? "");

/** Index just past a line comment starting at index. Postgres ends one at CR as well as LF. */
function skipLineComment(sql, index) {
  let at = index;
  while (at < sql.length && sql[at] !== "\n" && sql[at] !== "\r") at += 1;
  return at + 1;
}

/** Index just past a (nested) block comment starting at index. */
function skipBlockComment(sql, index) {
  let at = index + 2;
  let level = 1;
  while (at < sql.length && level > 0) {
    const pair = sql.slice(at, at + 2);
    if (pair === "/*") (level += 1), (at += 2);
    else if (pair === "*/") (level -= 1), (at += 2);
    else at += 1;
  }
  return at;
}

/** One character (or escape) of a quoted body at index: [text to append, characters consumed], or null at the closing quote. */
function quotedStep(sql, index, quote, backslash) {
  const char = sql[index];
  // A letter escape (\n, \t, \x41) separates words; other escapes are the character.
  if (backslash && char === "\\") return [/[A-Za-z]/.test(sql[index + 1] ?? "") ? " " : sql.slice(index + 1, index + 2), 2];
  if (char === quote && sql[index + 1] === quote) return [quote, 2];
  if (char === quote) return null;
  return [char, 1];
}

/** Read a single- or double-quoted token starting at index: its body and the index just past it. */
function readQuoted(sql, index, backslash) {
  const quote = sql[index];
  let at = index + 1;
  let body = "";
  while (at < sql.length) {
    const step = quotedStep(sql, at, quote, backslash);
    if (!step) return { body, end: at + 1 };
    body += step[0];
    at += step[1];
  }
  return { body, end: at };
}

/** The dollar-quote tag starting at index, or null. */
function dollarTagAt(sql, index) {
  if (sql[index] !== "$" || isWordChar(sql[index - 1])) return null;
  const match = DOLLAR_TAG.exec(sql.slice(index, index + 64));
  return match ? match[0] : null;
}

/** The token at index: { words, end }. Comments give no words; strings give their body's words. */
function sqlTokenAt(sql, index, depth, budget, previous) {
  const char = sql[index];
  const pair = sql.slice(index, index + 2);
  if (pair === "--") return { words: [], end: skipLineComment(sql, index) };
  if (pair === "/*") return { words: [], end: skipBlockComment(sql, index) };
  if (char === "'" || char === '"') return quotedToken(sql, index, depth, budget, previous);
  const tag = dollarTagAt(sql, index);
  if (tag) return dollarToken(sql, index, tag, depth, budget);
  if (/[A-Za-z_]/.test(char)) {
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index, index + 256))[0];
    return { words: [word.toLowerCase()], end: index + word.length };
  }
  return { words: /\s/.test(char) ? [] : [char], end: index + 1 };
}

/** A quoted token. E'' strings take backslash escapes, and drop the e word the prefix produced. Identifiers give no words. */
function quotedToken(sql, index, depth, budget, previous) {
  const char = sql[index];
  const backslash = char === "'" && /e/i.test(sql[index - 1] ?? "") && !isWordChar(sql[index - 2]);
  const { body, end } = readQuoted(sql, index, backslash);
  const words = char === "'" ? sqlBodyWords(body, depth, budget) : [];
  return { words, end, dropPrevious: backslash && previous === "e" };
}

function dollarToken(sql, index, tag, depth, budget) {
  const bodyStart = index + tag.length;
  const found = sql.indexOf(tag, bodyStart);
  const close = found === -1 ? sql.length : found;
  return { words: sqlBodyWords(sql.slice(bodyStart, close), depth, budget), end: Math.min(sql.length, close + tag.length) };
}

function tokenizeSql(sql, depth, budget) {
  const words = [];
  let index = 0;
  while (index < sql.length) {
    const token = sqlTokenAt(sql, index, depth, budget, words.at(-1));
    if (token.dropPrevious) {
      words.pop();
      budget.left += 1;
    }
    for (const word of token.words) {
      budget.take();
      words.push(word);
    }
    index = token.end;
  }
  return words;
}

function sqlBodyWords(body, depth, budget) {
  if (depth < MAX_SQL_DEPTH) return tokenizeSql(body, depth + 1, budget);
  return body.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? [];
}

/** Classes whose token sequences occur in the SQL text, with reasons. */
export function classifySql(text, config) {
  const words = sqlWords(text);
  const classes = [];
  const reasons = [];
  for (const rule of config.sqlContent.rules) {
    const found = words.some((_, start) => rule.tokens.every((token, offset) => words[start + offset] === token));
    if (!found) continue;
    if (!classes.includes(rule.class)) classes.push(rule.class);
    reasons.push(`${rule.class}:sql:${rule.tokens.join(" ")}`);
  }
  return { classes, reasons };
}

// ---------------------------------------------------------------- detect

// Every status except "removed" has head content; an unknown status is read too.
const readsHead = (status) => status !== "removed";

/** Why a changed-file entry cannot be classified, or null. */
function fileProblem(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) return "is not an object";
  if (!isValidPath(file.filename)) return `filename ${JSON.stringify(file.filename) ?? String(file.filename)} is not a non-empty path`;
  if (typeof file.status !== "string" || file.status === "") return `${file.filename} has no status`;
  const previous = file.previous_filename;
  if (previous !== undefined && previous !== null && !isValidPath(previous)) {
    return `${file.filename} has previous_filename ${JSON.stringify(previous) ?? String(previous)}, which is not a non-empty path`;
  }
  if (file.status === "renamed" && !isValidPath(previous)) return `${file.filename} is renamed but has no previous_filename`;
  return null;
}

/**
 * Classify a list of changed files. Each entry must be a well-formed file
 * (fileProblem) and the list must be non-empty unless allowEmpty (the PR's
 * own changed_files count is 0); anything else is an error and the bad entry
 * never reaches the matcher.
 * @param {object} input
 * @param {{filename: string, status: string, previous_filename?: string}[]} input.files
 * @param {(path: string) => Promise<string>} [input.readHeadFile] head content of a SQL file
 * @param {object} input.config loadConfig().config (or compileConfig() plus a matcher)
 */
export async function detect({ files, readHeadFile, config, sha = null, baseSha = null, errors = [], allowEmpty = false }) {
  const allErrors = [...errors];
  const list = Array.isArray(files) ? files : [];
  if (!Array.isArray(files)) allErrors.push("the changed-file list is not an array");
  else if (files.length === 0 && !allowEmpty) allErrors.push("the changed-file list is empty, but the PR does not report zero changed files");
  const valid = [];
  for (const [index, file] of list.entries()) {
    const problem = fileProblem(file);
    if (problem) allErrors.push(`changed file ${index + 1}: ${problem}`);
    else valid.push(file);
  }
  // Read every SQL head body up front; results stay in changed-file order.
  const limit = limiter(HEAD_READ_CONCURRENCY);
  const sqlScans = await Promise.all(valid.map((file) => limit(() => scanHeadSql(file, readHeadFile, config))));
  const results = [];
  const notices = [];
  for (const [index, file] of valid.entries()) {
    const scan = sqlScans[index];
    if (scan.error) allErrors.push(scan.error);
    if (scan.notice) notices.push(scan.notice);
    results.push(classifyFile(file, config, scan));
  }

  const classes = OUTPUT_CLASSES.filter((name) => results.some((file) => file.classes.includes(name)));
  return {
    version: OUTPUT_VERSION,
    sha,
    base_sha: baseSha,
    status: allErrors.length ? "error" : "ok",
    classes,
    sensitive_count: results.filter((file) => file.classes.length).length,
    multi_class: classes.length > 1,
    files: results,
    unclassified: results.filter((file) => file.classes.includes(UNCLASSIFIED)).map((file) => file.path),
    errors: allErrors,
    ...(notices.length ? { manual_review: notices } : {}),
  };
}

/** At most this many head reads (GitHub contents API calls) in flight at once. */
const HEAD_READ_CONCURRENCY = 8;

/** Run async tasks with at most `size` in flight. */
function limiter(size) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return (task) =>
    new Promise((resolve, reject) => {
      const start = () => {
        active += 1;
        task().then(resolve, reject).finally(release);
      };
      if (active < size) start();
      else waiting.push(start);
    });
}

const NO_SQL = Object.freeze({ classes: [], reasons: [] });

/** SQL content classes for one file's head body: { classes, reasons, notice?, error? }. */
async function scanHeadSql(file, readHeadFile, config) {
  if (!readsHead(file.status) || !config.sqlContent.paths.some((re) => re.test(file.filename))) return NO_SQL;
  let body;
  try {
    if (!readHeadFile) throw new Error("no head reader");
    body = await readHeadFile(file.filename);
  } catch (error) {
    return { ...NO_SQL, error: `could not read ${file.filename} at head: ${messageOf(error)}` };
  }
  try {
    return classifySql(body, config);
  } catch (error) {
    if (!(error instanceof SqlTooLargeError)) return { ...NO_SQL, error: `could not read ${file.filename} at head: ${messageOf(error)}` };
    // Too large to scan: treat as every class the SQL scan could have found.
    return {
      classes: [...new Set(config.sqlContent.rules.map((rule) => rule.class))],
      reasons: [`sql:oversized:>${MAX_SQL_TOKENS}`],
      notice: `SQL body ${file.filename} rejected for size: exceeds the limit of ${MAX_SQL_TOKENS} tokens; manual review is required`,
    };
  }
}

/** The result entry for one well-formed changed file, given its SQL scan. */
function classifyFile(file, config, scan) {
  const paths = [file.filename];
  if (file.previous_filename && file.previous_filename !== file.filename) paths.push(file.previous_filename);
  const classes = [];
  const reasons = [];
  const categories = [];
  for (const path of paths) {
    const result = classifyPath(path, config);
    const label = path === file.filename ? "" : "previous:";
    for (const name of result.classes) if (!classes.includes(name)) classes.push(name);
    reasons.push(...result.reasons.map((reason) => label + reason));
    categories.push(result.category);
  }
  for (const name of scan.classes) if (!classes.includes(name)) classes.push(name);
  reasons.push(...scan.reasons);
  // A rename keeps its safe category only when both names share it.
  const category = !classes.length && categories.every((name) => name && name === categories[0]) ? categories[0] : null;
  // Fail closed: only a safe category makes a file with no class non-sensitive.
  if (!classes.length && !category) {
    classes.push(UNCLASSIFIED);
    reasons.push(`${UNCLASSIFIED}:no-safe-category`);
  }
  classes.sort((a, b) => OUTPUT_CLASSES.indexOf(a) - OUTPUT_CLASSES.indexOf(b));
  const entry = { path: file.filename, status: file.status, classes, category, reasons };
  if (paths.length > 1) entry.previous_path = file.previous_filename;
  return entry;
}

/** The result for a run that could not classify anything. */
export function errorResult(errors, { sha = null, baseSha = null } = {}) {
  const gate_loosening = detectGateLoosening({ incomplete: "the PR could not be classified" });
  return { version: OUTPUT_VERSION, sha, base_sha: baseSha, status: "error", classes: [], sensitive_count: 0, multi_class: false, files: [], unclassified: [], errors, gate_loosening };
}

// ---------------------------------------------------------------- gate loosening

export const DETECTOR_REPO_PATH = "scripts/sensitive-class-detect.mjs";
export const WORKFLOW_REPO_PATH = ".github/workflows/sensitive-class.yml";
// The detector imports proof-check.mjs, so an edit there changes it after merge.
// The shared matcher it also imports is judged by findGateLoosening (matcher_changed).
export const DETECTOR_HELPER_REPO_PATH = "scripts/proof-check.mjs";
const GATE_PATHS = [CONFIG_REPO_PATH, DETECTOR_REPO_PATH, DETECTOR_HELPER_REPO_PATH, WORKFLOW_REPO_PATH];
// Every safe category field that affects matching: the whole category schema
// (CATEGORY_KEYS, which the validator keeps closed) except description text.
export const CATEGORY_MATCH_FIELDS = [...CATEGORY_KEYS].filter((field) => field !== "description");
// The reason kind for one item added to or removed from a safe category field.
// A path takes the first safe category that matches, so narrowing a category
// lets a path fall through to a later one: that loosens a rename just as a
// widening does. A field missing here is flagged both ways (category_changed).
const CATEGORY_FIELD_EFFECTS = {
  paths: { added: "exemption_added", removed: "category_narrowed" },
  path_keywords: { added: "exemption_added", removed: "category_narrowed" },
  exclude: { added: "category_narrowed", removed: "exemption_widened" },
  exclude_keywords: { added: "category_narrowed", removed: "exemption_widened" },
};
const UNKNOWN_FIELD_EFFECT = { added: "category_changed", removed: "category_changed" };

const listOf = (entry, field) => (Array.isArray(entry?.[field]) ? entry[field] : []);
const objectOf = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const sqlRuleKey = (rule) => `${rule?.class}:${Array.isArray(rule?.tokens) ? rule.tokens.join(" ") : ""}`;

/**
 * Report-only gate_loosening classification of this detector's own config
 * (scripts/sensitive-classes.json) and gate files, run by the base copy of
 * this script so a PR cannot change its own judgement. Each of these needs a
 * Grok Bot countersign on top of Blaine's card. Reason kinds:
 * - not_checked: the changed-file list is incomplete, so a config edit cannot
 *   be ruled out;
 * - gate_changed, gate_removed: the detector script, its proof-check.mjs
 *   helper or its workflow is edited or removed (CI runs the base copy, so the
 *   edit takes effect only after merge);
 * - config_unreadable, config_invalid: the head config is removed, renamed,
 *   unreadable, unparseable or invalid under the base validator, or the base
 *   config cannot be read (fail closed);
 * - rule_narrowed: a sql_content path is removed or edited (an edit is a
 *   removal plus an addition);
 * - sql_rule_removed: a sql_content rule is removed or edited;
 * - exemption_added: a path or path_keywords item added to a safe category
 *   (a new or renamed category adds all of its own);
 * - exemption_widened: an exclude or exclude_keywords item removed from a safe
 *   category;
 * - category_narrowed: a safe category is removed or renamed, loses a path or
 *   path_keywords item, or gains an exclude or exclude_keywords item. A path
 *   takes the first safe category that matches and a rename stays safe only
 *   when both names land in the same one, so a path that falls through to a
 *   later category can make a rename safe;
 * - category_order_changed: the safe categories kept from base change order;
 * - category_changed: any change to a safe category field with no recorded
 *   effect (none today; it keeps a new schema field from passing silently).
 * Every safe_categories edit that can change a classification is flagged.
 * Path classes are not judged here: removing, narrowing or reclassifying a
 * glob in docs/sensitive-paths.json, and editing the matcher, are the shared
 * list's findGateLoosening reasons (gateLooseningForPull adds them).
 * Not loosening: added SQL rules or paths, description and syntax text, item
 * order or duplicates inside a list, and reordering sql_content rules (every
 * rule is checked, so their order does not matter).
 * The diff is textual, so it fails safe with false positives: an equivalent
 * rewrite (splitting a brace glob into two, a case-only edit) is flagged, an
 * exclusion on a new category is flagged although it only trims that
 * category, and so is a stale branch that edits the config after base has
 * added rules (the newer base rules look removed). gateFiles: [{ path,
 * status }] from the PR file list.
 */
export function detectGateLoosening({ baseRaw = null, headRaw = null, baseError = null, headError = null, gateFiles = [], incomplete = null }) {
  const reasons = [];
  const at = CONFIG_REPO_PATH;
  if (incomplete) reasons.push({ kind: "not_checked", path: at, message: `${at} loosening cannot be ruled out: ${incomplete}.` });
  for (const { path, status } of gateFiles) {
    if (path === CONFIG_REPO_PATH) continue;
    reasons.push(status === "removed"
      ? { kind: "gate_removed", path, message: `${path} is deleted.` }
      : { kind: "gate_changed", path, message: `${path} is edited; needs review that it does not relax the check (CI runs the base copy, so the edit takes effect only after merge).` });
  }
  if (!gateFiles.some((file) => file.path === CONFIG_REPO_PATH)) return finish(reasons);
  if (baseError) {
    reasons.push({ kind: "config_unreadable", ref: "base", path: at, message: `${at} at the base commit cannot be read (${baseError}); loosening cannot be checked.` });
    return finish(reasons);
  }
  if (headError) {
    reasons.push({ kind: "config_unreadable", ref: "head", path: at, message: `${at} at head cannot be read (${headError}).` });
    return finish(reasons);
  }
  const { errors } = compileConfig(headRaw);
  if (errors.length) {
    reasons.push({ kind: "config_invalid", ref: "head", path: at, message: `${at} at head is invalid: ${errors.join("; ")}.` });
    return finish(reasons);
  }
  reasons.push(...diffConfig(baseRaw, headRaw));
  return finish(reasons);
}

const finish = (reasons) => ({ detected: reasons.length > 0, reasons, requires: [...GATE_LOOSENING_REQUIRES] });

function diffConfig(base, head) {
  const at = CONFIG_REPO_PATH;
  const reasons = [];
  const baseCategories = objectOf(base.safe_categories);
  const headCategories = objectOf(head.safe_categories);

  // Safe categories. A path takes the first safe category that matches, and a
  // rename stays safe only when both names land in the same one, so any change
  // to which category a path lands in can exempt a file. Flagged: a removed
  // category, a reorder of the categories kept from base, and every item added
  // to or removed from any CATEGORY_MATCH_FIELDS field (a new category diffs
  // against an empty one). When none is flagged, every base category survives
  // with the same match sets in the same relative order and any new category
  // matches nothing, so every path lands where it did on base.
  for (const name of Object.keys(baseCategories)) {
    if (!Object.hasOwn(headCategories, name)) {
      reasons.push({ kind: "category_narrowed", path: at, entry: `safe_categories.${name}`, message: `${at} removes safe category "${name}"; a path it matched can fall through to a later category.` });
    }
  }
  const baseOrder = Object.keys(baseCategories).filter((name) => Object.hasOwn(headCategories, name));
  const headOrder = Object.keys(headCategories).filter((name) => Object.hasOwn(baseCategories, name));
  if (baseOrder.join("\n") !== headOrder.join("\n")) {
    reasons.push({ kind: "category_order_changed", path: at, entry: "safe_categories", value: headOrder, message: `${at} reorders safe categories from ${JSON.stringify(baseOrder)} to ${JSON.stringify(headOrder)}.` });
  }
  for (const [name, entry] of Object.entries(headCategories)) {
    const prior = Object.hasOwn(baseCategories, name) ? baseCategories[name] : {};
    for (const field of CATEGORY_MATCH_FIELDS) {
      const effect = CATEGORY_FIELD_EFFECTS[field] ?? UNKNOWN_FIELD_EFFECT;
      const before = new Set(listOf(prior, field));
      const after = new Set(listOf(entry, field));
      for (const value of after) {
        if (!before.has(value)) reasons.push({ kind: effect.added, path: at, entry: `safe_categories.${name}`, field, value, message: `${at} adds ${field} ${JSON.stringify(value)} to safe category "${name}".` });
      }
      for (const value of before) {
        if (!after.has(value)) reasons.push({ kind: effect.removed, path: at, entry: `safe_categories.${name}`, field, value, message: `${at} removes ${field} ${JSON.stringify(value)} from safe category "${name}".` });
      }
    }
  }

  const baseSql = objectOf(base.sql_content);
  const headSql = objectOf(head.sql_content);
  const keptPaths = new Set(listOf(headSql, "paths"));
  for (const value of listOf(baseSql, "paths")) {
    if (!keptPaths.has(value)) reasons.push({ kind: "rule_narrowed", path: at, entry: "sql_content", field: "paths", value, message: `${at} removes or edits sql_content path ${JSON.stringify(value)}.` });
  }
  const keptRules = new Set(listOf(headSql, "rules").map(sqlRuleKey));
  for (const rule of listOf(baseSql, "rules")) {
    if (!keptRules.has(sqlRuleKey(rule))) reasons.push({ kind: "sql_rule_removed", path: at, entry: "sql_content", value: sqlRuleKey(rule), message: `${at} removes or edits sql_content rule ${JSON.stringify(sqlRuleKey(rule))}.` });
  }
  return reasons;
}

/** A GitHub file entry as git --name-status --no-renames changes (what findGateLoosening reads). */
function nameStatusChanges(file) {
  const name = file?.filename;
  if (file?.status === "added" || file?.status === "copied") return [{ status: "A", file: name }];
  if (file?.status === "removed") return [{ status: "D", file: name }];
  if (file?.status === "renamed" && file.previous_filename) return [{ status: "D", file: file.previous_filename }, { status: "A", file: name }];
  return [{ status: "M", file: name }];
}

/**
 * The shared list's gate_loosening reasons (scripts/lib/sensitive-paths.mjs
 * findGateLoosening, not reimplemented here): a removed, narrowed or
 * reclassified glob in docs/sensitive-paths.json, a deleted or invalid list
 * (headText null or invalid), and an edit to the code that applies it
 * (GATE_CODE_FILES). baseText is the base checkout's copy; headText the PR
 * head's, or baseText when the PR does not touch the list.
 */
export function sharedListLoosening({ files, baseText, headText }) {
  const changedFiles = files.flatMap(nameStatusChanges).filter((change) => typeof change.file === "string");
  return findGateLoosening({ baseText, headText, changedFiles }).reasons.map((reason) => ({ kind: reason.code, path: reason.file, source: "sensitive-paths", ...reason }));
}

/**
 * Gate loosening for a PR from its file list: this detector's own config and
 * gate files (detectGateLoosening), plus the shared list's findGateLoosening.
 * A head copy is read (as data) only when the PR touches that file, so a
 * stale branch that leaves it alone is never judged against newer base rules.
 * A head read that fails is an API error: it is returned in errors (status
 * error) as well as flagged config_unreadable.
 * @returns {Promise<{gateLoosening: {detected: boolean, reasons: object[], requires: string[]}, errors: string[]}>}
 */
export async function gateLooseningForPull({ files, readHeadFile, baseRaw, baseError = null, sensitivePathsText = null, incomplete = null }) {
  const errors = [];
  const readHead = async (file) => {
    if (!readHeadFile) throw new Error("no head reader");
    return readHeadFile(file);
  };
  const gateFiles = [];
  for (const file of files) {
    for (const path of GATE_PATHS) {
      if (file?.filename === path) gateFiles.push({ path, status: file.status });
      else if (file?.previous_filename === path) gateFiles.push({ path, status: "removed" });
    }
  }
  const config = gateFiles.find((file) => file.path === CONFIG_REPO_PATH);
  let headRaw = null;
  let headError = null;
  if (config?.status === "removed") headError = "the file is removed";
  else if (config) {
    let text = null;
    try {
      text = await readHead(CONFIG_REPO_PATH);
    } catch (error) {
      headError = messageOf(error);
      errors.push(`could not read ${CONFIG_REPO_PATH} at head: ${headError}`);
    }
    if (headError === null) {
      try {
        headRaw = JSON.parse(text);
      } catch (error) {
        headError = messageOf(error);
      }
    }
  }
  const reasons = [...detectGateLoosening({ baseRaw, headRaw, baseError, headError, gateFiles, incomplete }).reasons];

  let headText = sensitivePathsText;
  if (files.some((file) => file?.filename === SENSITIVE_PATHS_FILE || file?.previous_filename === SENSITIVE_PATHS_FILE)) {
    const current = files.find((file) => file?.filename === SENSITIVE_PATHS_FILE && file.status !== "removed");
    headText = null; // deleted or renamed away: config_removed
    if (current) {
      try {
        headText = await readHead(SENSITIVE_PATHS_FILE);
      } catch (error) {
        // The glob diff cannot run; the base text keeps matcher_changed reporting.
        headText = sensitivePathsText;
        errors.push(`could not read ${SENSITIVE_PATHS_FILE} at head: ${messageOf(error)}`);
        reasons.push({ kind: "config_unreadable", ref: "head", path: SENSITIVE_PATHS_FILE, message: `${SENSITIVE_PATHS_FILE} at head cannot be read (${messageOf(error)}); loosening cannot be checked.` });
      }
    }
  }
  reasons.push(...sharedListLoosening({ files, baseText: sensitivePathsText, headText }));
  return { gateLoosening: finish(reasons), errors };
}

// ---------------------------------------------------------------- GitHub

/**
 * A minimal GitHub REST client over fetch.
 * @param {{token?: string, apiUrl?: string, fetchImpl?: typeof fetch}} options
 */
export function githubClient({ token, apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch } = {}) {
  const request = async (path, accept = "application/vnd.github+json") => {
    const headers = { accept, "x-github-api-version": "2022-11-28", "user-agent": "overdrafter-sensitive-class-detect" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${apiUrl}${path}`, { headers });
    if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
    return accept.endsWith("raw") ? response.text() : response.json();
  };
  return {
    json: (path) => request(path),
    raw: (path) => request(path, "application/vnd.github.raw"),
  };
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

/**
 * Read a PR's head and base, its changed files and a head reader. A list that
 * cannot be complete (more than MAX_FILES files, a failed page, a count that
 * disagrees with the PR, or a head that moved) is an error. changedFiles is
 * the PR's own count, so a consumer can tell an empty PR from a lost list.
 */
export async function fetchPullRequest(client, repo, number, { expectedHeadSha } = {}) {
  const pull = await client.json(`/repos/${repo}/pulls/${number}`);
  const sha = pull?.head?.sha ?? null;
  const baseSha = pull?.base?.sha ?? null;
  const errors = [];
  if (expectedHeadSha && sha !== expectedHeadSha) errors.push(`PR head moved: expected ${expectedHeadSha}, API has ${sha}`);
  const expected = pull?.changed_files;
  if (!Number.isInteger(expected)) errors.push("PR has no changed_files count");
  if (expected > MAX_FILES) errors.push(`PR changes ${expected} files; the API lists at most ${MAX_FILES}, so the list is truncated`);
  const files = [];
  for (let page = 1; page <= MAX_FILES / PER_PAGE; page += 1) {
    const batch = await client.json(`/repos/${repo}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`files page ${page} is not an array`);
    files.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  if (Number.isInteger(expected) && files.length !== expected) {
    errors.push(`file list is incomplete: API listed ${files.length} of ${expected} changed files`);
  }
  const readHeadFile = (path) => client.raw(`/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(sha)}`);
  return { sha, baseSha, files, changedFiles: Number.isInteger(expected) ? expected : null, readHeadFile, errors };
}

// ---------------------------------------------------------------- CLI

export const GATE_LOOSENING_LINE = `${SHARED_GATE_LOOSENING_LINE} (report only; does not fail the PR).`;

export function formatSummary(result) {
  const label = result.status === "ok" ? "OK" : "ERROR";
  const lines = [`### Sensitive classes: ${label}`, "", "Mode: `report` (this check never fails the PR)", ""];
  lines.push(`Head: ${safeInline(result.sha ?? "unknown")} · base: ${safeInline(result.base_sha ?? "unknown")}`, "");
  lines.push(`Classes: ${result.classes.length ? result.classes.map(safeInline).join(", ") : "none"}`);
  lines.push(`Sensitive files: ${result.sensitive_count} of ${result.files.length}${result.multi_class ? " (multi-class)" : ""}`);
  lines.push(`Unclassified (sensitive, no safe category): ${result.unclassified.length ? result.unclassified.map(safeInline).join(", ") : "none"}`, "");
  for (const error of result.errors) lines.push(`- error: ${safeInline(error)}`);
  if (result.errors.length) lines.push("");
  for (const notice of result.manual_review ?? []) lines.push(`- manual review: ${safeInline(notice)}`);
  if (result.manual_review?.length) lines.push("");
  if (result.gate_loosening?.detected) {
    lines.push(GATE_LOOSENING_LINE);
    for (const reason of result.gate_loosening.reasons) lines.push(`- ${safeInline(reason.message)}`);
    lines.push("");
  } else if (result.gate_loosening) {
    lines.push("Gate loosening: none", "");
  }
  if (result.files.length) {
    lines.push("| File | Status | Classes | Category |", "| --- | --- | --- | --- |");
    for (const file of result.files) {
      const name = safeInline(file.path).replaceAll("|", "\\|");
      const classes = file.classes.map((entry) => (entry === UNCLASSIFIED ? `**${entry}**` : entry)).join(", ");
      lines.push(`| ${name} | ${file.status ?? ""} | ${classes || "-"} | ${file.category ?? "-"} |`);
    }
    lines.push("");
  }
  const json = JSON.stringify(result, null, 2);
  const fence = "`".repeat(Math.max(3, ...(json.match(/`+/g) ?? []).map((run) => run.length + 1)));
  lines.push("<details><summary>JSON</summary>", "", `${fence}json`, json, fence, "", "</details>", "");
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {};
  const known = ["--repo", "--pr", "--json", "--config", "--head-sha"];
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split(/=(.*)/s, 2);
    if (!known.includes(name)) throw new Error(`unknown argument ${argv[index]}`);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`${name} needs a value`);
    options[name.slice(2)] = value;
  }
  if (!options.repo || !/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error("--repo owner/name is required");
  if (!/^\d+$/.test(options.pr ?? "")) throw new Error("--pr <number> is required");
  return options;
}

const usage = "Usage: node scripts/sensitive-class-detect.mjs --repo owner/name --pr <number> [--json out.json] [--head-sha <sha>] [--config file]\n"
  + "Reads GITHUB_TOKEN or GH_TOKEN. Path classes come from docs/sensitive-paths.json in this checkout.\n"
  + "Report mode: exits 0 whenever it writes a result, including status error.";

/**
 * @param {object} [options] root: the checkout whose docs/sensitive-paths.json
 *   and scripts/sensitive-classes.json judge (default: this script's own)
 * @returns {Promise<number>} 0 when a result was written, 2 on bad arguments
 */
export async function main(argv = process.argv.slice(2), env = process.env, { fetchImpl, stdout = process.stdout, root = REPO_ROOT } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(usage);
    return 2;
  }

  const { config, errors: configErrors, raw: baseRaw, sensitivePathsText } = loadConfig({ root, file: options.config });
  let result;
  if (!config) {
    result = errorResult(configErrors, { sha: options["head-sha"] ?? null });
  } else {
    try {
      const client = githubClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl: env.GITHUB_API_URL, fetchImpl });
      const pull = await fetchPullRequest(client, options.repo, options.pr, { expectedHeadSha: options["head-sha"] });
      result = await detect({ ...pull, config, allowEmpty: pull.changedFiles === 0 });
      const incomplete = pull.errors.length ? "the changed-file list is incomplete or stale" : null;
      const loosening = await gateLooseningForPull({ ...pull, baseRaw, sensitivePathsText, incomplete });
      result.gate_loosening = loosening.gateLoosening;
      if (loosening.errors.length) {
        result.errors.push(...loosening.errors);
        result.status = "error";
      }
    } catch (error) {
      result = errorResult([`GitHub API error: ${messageOf(error)}`], { sha: options["head-sha"] ?? null });
    }
  }

  if (options.json) writeFileSync(options.json, `${JSON.stringify(result, null, 2)}\n`);
  const summary = formatSummary(result);
  stdout.write(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  return 0;
}

/**
 * True when node was asked to run this file. Realpaths are compared because
 * node runs a script given through a symlinked path (macOS /tmp, for example)
 * from its real path; a plain comparison would skip the CLI and write nothing.
 */
function invokedAsScript(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  process.exitCode = await main();
}
