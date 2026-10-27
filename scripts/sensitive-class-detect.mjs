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
  pathCandidates,
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
 * holds only what this detector adds: SQL content rules (rls, definer, auth) over
 * changed SQL read at the PR head, auto-merge safe categories, and door report rules.
 *
 * The CLI runs from the base checkout. It reads the changed files and their
 * status from the GitHub API and reads changed files at pinned head/base revisions as
 * data only; nothing from the PR is executed. The result is an error when the
 * PR's base is not the checkout (--base-sha), its head is not --head-sha, or
 * either moves while the file list is read. Sensitive classes win over safe
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
 *   rls covers policies, ROW LEVEL SECURITY, BYPASSRLS/NOBYPASSRLS,
 *                 rolbypassrls and row_security; definer covers SECURITY DEFINER.
 *   auth also covers SQL role and session authorization switches.
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
 * "<class>:sql:<id>: <reason>", "sql:oversized:><MAX_SQL_TOKENS>" (SQL_OVERSIZED_REASON),
 * "<category>:path:<glob>" or
 * "unclassified:no-safe-category"; a rename's old name is prefixed
 * "previous:". gate_loosening.reasons hold this detector's reasons
 * ({kind, path, message, ...}) and the shared list's findGateLoosening
 * reasons, which keep every field and gain kind (its code), path (its file)
 * and source "sensitive-paths". sql_exemptions lists the SQL hits cleared
 * by test exemptions, separately from that config-diff metadata.
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
/** Classes SQL rules may name, including shared-list auth. */
export const SQL_RULE_CLASSES = Object.freeze([...SQL_CONTENT_CLASSES, "auth"]);
/** The pseudo-class of a file with no sensitive class and no safe category (fail closed). */
export const UNCLASSIFIED = "unclassified";
/** Every output class, in output order. */
export const OUTPUT_CLASSES = Object.freeze([...SENSITIVE_CLASSES, ...SQL_CONTENT_CLASSES, UNCLASSIFIED]);
export const MAX_FILES = 3000;
const PER_PAGE = 100;

const TOP_KEYS = new Set(["version", "description", "syntax", "sql_content", "safe_categories", "door"]);
const CATEGORY_KEYS = new Set(["description", "paths", "path_keywords", "exclude", "exclude_keywords"]);
const SQL_KEYS = new Set(["paths", "rules", "exemptions"]);
const SQL_RULE_KEYS = new Set(["id", "class", "tokens", "reason", "within", "after", "inside", "until", "informational"]);
const SQL_EXEMPTION_KEYS = new Set(["id", "reason", "paths", "rules", "targets", "gate_loosening"]);
// A whole lower-cased word as sqlWords emits it, or one punctuation character.
const SQL_TOKEN_PATTERN = /^(?:[a-z_][a-z0-9_$]*|[^\sA-Za-z0-9_$])$/;
// An exemption target is an unquoted lower-case role name, safe to splice into a RegExp.
const SQL_TARGET_PATTERN = /^[a-z_][a-z0-9_]*$/;
// The only rules an exemption can clear: SET [LOCAL] ROLE <target>, or RESET ROLE with no target.
const SQL_SET_ROLE_RULES = new Set(["auth_set_role", "auth_set_local_role"]);
const SQL_EXEMPTABLE_RULES = new Set([...SQL_SET_ROLE_RULES, "auth_reset_role"]);
// Postgres SQL whitespace; a comment counts as one space.
const SQL_SPACE = String.raw`[ \t\n\r\f]`;
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
function compileGlobs(list, where, errors, { caseSensitive = false } = {}) {
  return list.flatMap((glob) => {
    try {
      const compiled = compileGlob(glob);
      return [caseSensitive ? new RegExp(compiled.source, compiled.flags.replace("i", "")) : compiled];
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

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** `value` when it is an array; otherwise record `message` and give an empty list. */
function listOrError(value, message, errors) {
  if (Array.isArray(value)) return value;
  errors.push(message);
  return [];
}

function compileCategories(rawCategories, errors) {
  if (!isPlainObject(rawCategories) || Object.keys(rawCategories).length === 0) {
    errors.push("config: safe_categories must be a non-empty object");
    return [];
  }
  return Object.entries(rawCategories).map(([name, entry]) => compileCategory(name, entry, errors)).filter(Boolean);
}

const RULE_CONSTRAINT_KEYS = ["within", "after", "inside"];

function checkRuleIdentity(rule, where, ids, errors) {
  for (const key of Object.keys(rule)) if (!SQL_RULE_KEYS.has(key)) errors.push(`${where}: unknown rule key "${key}"`);
  if (typeof rule.id !== "string" || !NAME_PATTERN.test(rule.id)) errors.push(`${where}: invalid id`);
  else if (ids.has(rule.id)) errors.push(`${where}: duplicate id "${rule.id}"`);
  ids.add(rule.id);
  if (typeof rule.reason !== "string" || rule.reason.trim() === "") errors.push(`${where}: reason must be a non-empty string`);
  if (!SQL_RULE_CLASSES.includes(rule.class)) errors.push(`${where}: unknown class "${rule.class}"`);
}

/** Compile the within, after, inside and until fields of one SQL rule into `compiled`. */
function compileRuleConstraints(rule, compiled, where, errors) {
  for (const key of RULE_CONSTRAINT_KEYS) {
    if (rule[key] === undefined) continue;
    if (!Array.isArray(rule[key]) || rule[key].length === 0) {
      errors.push(`${where}.${key} must be a non-empty array of token lists`);
      continue;
    }
    compiled[key] = rule[key].map((sequence, at) => stringList(sequence, `${where}.${key}[${at}]`, errors, SQL_TOKEN_PATTERN));
    if (compiled[key].some((sequence) => sequence.length === 0)) errors.push(`${where}.${key} must not contain an empty token list`);
  }
  if (rule.until === undefined) return;
  if (typeof rule.until !== "string" || !SQL_TOKEN_PATTERN.test(rule.until)) errors.push(`${where}.until must be one token`);
  else compiled.until = rule.until;
}

/** @returns {object[]} the compiled rule in a list, or an empty list for an entry that is not an object */
function compileSqlRule(rule, index, ids, errors) {
  const where = `sql_content.rules[${index}]`;
  if (!rule || typeof rule !== "object") {
    errors.push(`${where} must be an object`);
    return [];
  }
  checkRuleIdentity(rule, where, ids, errors);
  const tokens = stringList(rule.tokens, `${where}.tokens`, errors, SQL_TOKEN_PATTERN);
  if (tokens.length === 0) errors.push(`${where}.tokens must not be empty`);
  const compiled = { id: rule.id, class: rule.class, tokens, reason: rule.reason, informational: rule.informational === true };
  if (rule.informational !== undefined && typeof rule.informational !== "boolean") errors.push(`${where}.informational must be a boolean`);
  compileRuleConstraints(rule, compiled, where, errors);
  return [compiled];
}

function checkExemptionIdentity(exemption, where, { ids, exemptionIds }, errors) {
  for (const key of Object.keys(exemption)) if (!SQL_EXEMPTION_KEYS.has(key)) errors.push(`${where}: unknown key "${key}"`);
  if (typeof exemption.id !== "string" || !NAME_PATTERN.test(exemption.id)) errors.push(`${where}: invalid id`);
  else if (exemptionIds.has(exemption.id) || ids.has(exemption.id)) errors.push(`${where}: duplicate id "${exemption.id}"`);
  exemptionIds.add(exemption.id);
  if (typeof exemption.reason !== "string" || exemption.reason.trim() === "") errors.push(`${where}: reason must be a non-empty string`);
  // Every exemption weakens the gate, so the config must say so in place.
  if (exemption.gate_loosening !== true) errors.push(`${where}: gate_loosening must be true`);
}

function checkExemptionRules(ruleIds, compiledRules, where, errors) {
  for (const id of ruleIds) {
    const rule = compiledRules.find((candidate) => candidate.id === id);
    if (!rule) errors.push(`${where}: unknown rule "${id}"`);
    else if (rule.informational) errors.push(`${where}: rule "${id}" is informational`);
    else if (!SQL_EXEMPTABLE_RULES.has(id)) errors.push(`${where}: rule "${id}" is not a SET [LOCAL] ROLE or RESET ROLE rule`);
  }
}

// SET [LOCAL] ROLE needs targets; RESET ROLE names no role, so an exemption for it alone takes none.
function exemptionTargets(exemption, setRole, where, errors) {
  const targets = exemption.targets === undefined && !setRole ? [] : stringList(exemption.targets, `${where}.targets`, errors, SQL_TARGET_PATTERN);
  if (setRole && targets.length === 0) errors.push(`${where}.targets must not be empty`);
  if (!setRole && exemption.targets !== undefined) errors.push(`${where}.targets is only allowed with a SET [LOCAL] ROLE rule`);
  return targets;
}

// The whole comment-stripped top-level statement must be SET [LOCAL] ROLE <unquoted target> [;]
// for the SET rules, or RESET ROLE [;] for auth_reset_role.
function exemptionStatements(ruleIds, targets) {
  const names = targets.filter((target) => SQL_TARGET_PATTERN.test(target)).join("|");
  const setStatement = new RegExp(`^set${SQL_SPACE}+(?:local${SQL_SPACE}+)?role${SQL_SPACE}+(?:${names})${SQL_SPACE}*;?$`, "i");
  const resetStatement = new RegExp(`^reset${SQL_SPACE}+role${SQL_SPACE}*;?$`, "i");
  return Object.fromEntries(ruleIds.filter((id) => SQL_EXEMPTABLE_RULES.has(id)).map((id) => [id, SQL_SET_ROLE_RULES.has(id) ? setStatement : resetStatement]));
}

/** @returns {object[]} the compiled exemption in a list, or an empty list for an entry that is not an object */
function compileExemption(exemption, index, context, errors) {
  const where = `sql_content.exemptions[${index}]`;
  if (!exemption || typeof exemption !== "object") {
    errors.push(`${where} must be an object`);
    return [];
  }
  checkExemptionIdentity(exemption, where, context, errors);
  const paths = stringList(exemption.paths, `${where}.paths`, errors);
  if (paths.length === 0) errors.push(`${where}.paths must not be empty`);
  const ruleIds = stringList(exemption.rules, `${where}.rules`, errors);
  if (ruleIds.length === 0) errors.push(`${where}.rules must not be empty`);
  checkExemptionRules(ruleIds, context.rules, where, errors);
  const setRole = ruleIds.some((id) => SQL_SET_ROLE_RULES.has(id));
  const targets = exemptionTargets(exemption, setRole, where, errors);
  // Exemption paths match case-sensitively: a looser match would loosen the gate further.
  const compiledPaths = compileGlobs(paths, `${where}.paths`, errors, { caseSensitive: true });
  return [{ id: exemption.id, reason: exemption.reason, paths: compiledPaths, rules: ruleIds, statements: exemptionStatements(ruleIds, targets) }];
}

function compileSqlContent(sql, errors) {
  for (const key of Object.keys(sql)) if (!SQL_KEYS.has(key)) errors.push(`sql_content: unknown rule key "${key}"`);
  const rules = listOrError(sql.rules, "sql_content.rules must be an array", errors);
  const ids = new Set();
  const compiledRules = rules.flatMap((rule, index) => compileSqlRule(rule, index, ids, errors));
  const exemptions = listOrError(sql.exemptions ?? [], "sql_content.exemptions must be an array", errors);
  const context = { ids, exemptionIds: new Set(), rules: compiledRules };
  const paths = compileGlobs(stringList(sql.paths, "sql_content.paths", errors), "sql_content.paths", errors);
  return { paths, rules: compiledRules, exemptions: exemptions.flatMap((exemption, index) => compileExemption(exemption, index, context, errors)) };
}

/**
 * Validate and compile the parsed detector config (SQL content rules and safe
 * categories). Unknown keys (a "classes" section included: path classes live
 * in docs/sensitive-paths.json), bad globs and SQL rules for a class outside
 * SQL_RULE_CLASSES are errors, never silently ignored.
 * @returns {{config: object|null, errors: string[]}}
 */
export function compileConfig(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { config: null, errors: ["config must be a JSON object"] };
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) errors.push(`config: unknown key "${key}"`);
  if (raw.version !== CONFIG_VERSION) errors.push(`config: version must be ${CONFIG_VERSION}`);
  const categories = compileCategories(raw.safe_categories, errors);
  let sqlContent = { paths: [], rules: [], exemptions: [] };
  if (isPlainObject(raw.sql_content)) sqlContent = compileSqlContent(raw.sql_content, errors);
  else errors.push("config: sql_content must be an object");
  return errors.length ? { config: null, errors } : { config: { categories, sqlContent, door: raw.door }, errors: [] };
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

// As in the Postgres scanner (scan.l ident_start/ident_cont, dolq_start/dolq_cont), every code point
// at or above U+0080 is an identifier and dollar-tag character: aé$$ and a—$$ are one identifier,
// $—$...$—$ is one dollar-quoted string. A word starts with [A-Za-z_] or a non-ASCII code point
// and continues with [A-Za-z0-9_$] or a non-ASCII code point; a tag takes the same without '$'.
const IDENT_START = String.raw`(?:[A-Za-z_]|[^\x00-\x7f])`;
const IDENT_CONT = String.raw`(?:[A-Za-z0-9_$]|[^\x00-\x7f])`;
const IDENTIFIER = new RegExp(`${IDENT_START}${IDENT_CONT}*`, "uy");
const IDENTIFIERS = new RegExp(`${IDENT_START}${IDENT_CONT}*`, "gu");
const WHOLE_IDENTIFIER = new RegExp(String.raw`^${IDENT_START}${IDENT_CONT}*(?![\s\S])`, "u");
const DOLLAR_TAG = new RegExp(String.raw`\$(?:${IDENT_START}(?:[A-Za-z0-9_]|[^\x00-\x7f])*)?\$`, "uy");
const WORD_CHAR_BEFORE = /(?:\w|[^\x00-\x7f])$/u;
// Everything else the tokenizer classifies: SQL whitespace and printable ASCII. What is left is an
// unexpected ASCII control character (U+0000-U+0008, U+000E-U+001F, U+007F).
const SQL_PLAIN_CHAR = /[ \t\n\r\f\v\x21-\x7e]/;
// Postgres ends a -- comment at LF or CR (non_newline is [^\n\r]).
const LINE_END = /[\n\r]/g;
const MAX_SQL_DEPTH = 8;
/** SQL bodies that tokenize to more than this many tokens are not scanned; they fail closed. */
export const MAX_SQL_TOKENS = 200_000;
// Bound scanning work even for comments or literals with very few tokens.
const MAX_SQL_CHARS = MAX_SQL_TOKENS * 256;

/** Thrown by sqlWords when a body exceeds the token budget. */
export class SqlTooLargeError extends Error {}
/** The reason a SQL file too large to scan gets (it fails closed). */
export const SQL_OVERSIZED_REASON = `sql:oversized:>${MAX_SQL_TOKENS}`;

/** A fresh token budget, shared by one sqlWords call and its nested bodies. Every token is charged once, where it is pushed. */
const newSqlBudget = () => ({ left: MAX_SQL_TOKENS });

/** Fail closed before scanning a body longer than MAX_SQL_CHARS. */
function checkSqlChars(sql) {
  if (sql.length > MAX_SQL_CHARS) throw new SqlTooLargeError(`more than ${MAX_SQL_CHARS} characters`);
}

/** Append tokens one at a time (no spread, so no stack overflow), spending the budget. */
function addSqlTokens(words, budget, tokens) {
  for (const token of tokens) {
    budget.left -= 1;
    if (budget.left < 0) throw new SqlTooLargeError(`more than ${MAX_SQL_TOKENS} tokens`);
    words.push(token);
  }
}
const STRING_LEXING_SETTINGS = ["standard_conforming_strings", "backslash_quote"];

function quotedIdentifierWord(body) {
  const word = body.toLowerCase();
  return WHOLE_IDENTIFIER.test(body) ? word : `"${word}"`;
}

function trimSqlSpace(text) {
  const whitespace = " \t\n\r\f\v";
  let start = 0;
  let end = text.length;
  while (start < end && whitespace.includes(text[start])) start += 1;
  while (end > start && whitespace.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/**
 * Tokenize SQL text into lower-case words, dropping line and (nested) block
 * comments. A double-quoted identifier becomes one lower-cased word, because
 * Postgres accepts quoted names (`SET "row_security"`, `"set_config"(…)`). A quoted name that is not
 * identifier-shaped keeps its quotes in the word, so a quoted ';', '(' or ')'
 * never acts as SQL syntax.
 * Every single-quoted, E'' and dollar-quoted string is tokenized recursively
 * as SQL, because a string can be code: a DO block
 * (`DO LANGUAGE plpgsql $$…$$`), an old-style function body (`AS '…'`) or
 * dynamic SQL (`EXECUTE '…'`, `EXECUTE $q$…$q$`). This fails closed: a string
 * literal that merely mentions CREATE POLICY also matches.
 * At MAX_SQL_DEPTH the body is split into plain words and auth_depth_limit
 * fails closed, including for empty bodies or escapes the fallback cannot decode.
 *
 * E'' escapes and newline-separated string continuations are decoded before
 * matching; U& strings and identifiers fail closed through auth_unicode_escape.
 * Known limits: names built at run time
 * (`'row_' || 'security'`, format(), EXECUTE of a variable) are not decoded,
 * and set_config with the setting name nested deeper than `(('role'))` or
 * passed as a variable does not match the role rules. auth_dynamic_role
 * catches EXECUTE and format() whose argument holds the word role. Additional
 * guards catch role commands in dynamic literals, including their raw comments, but not
 * one spelled from fragments (`execute 'set ' || 'ro' || 'le anon'`).
 */
export function sqlWords(text) {
  return sqlTokens(text).words;
}

/**
 * sqlWords with the 1-based source line of every word. A word inside a string
 * or dollar-quoted body gets the line it sits on in the file. `starts`/`ends` count the string or dollar-quoted bodies each word starts and ends
 * (a word can open or close several nested bodies at once). `statements` holds
 * the text of every statement split at a ';' outside strings, quoted
 * identifiers, dollar-quoted bodies and comments, with each comment replaced by
 * a space and only SQL whitespace trimmed; `statement` is the index of the statement each
 * word sits in (a word inside a string gets the statement holding the string).
 * A -- comment ends at LF or CR. `unknown` is the first character (code point
 * and line), at any string depth, that is an unexpected ASCII control character
 * (not SQL whitespace, printable ASCII or a non-ASCII word character), or null.
 * `guards` records non-exemptible depth-limit and dynamic-literal evidence.
 * @returns {{words: string[], lines: number[], starts: number[], ends: number[], statement: number[], statements: string[], unknown: {char: number, line: number}|null, guards: object[]}}
 */
export function sqlTokens(text, depth = 0, firstLine = 1, sourceLineAt = null, budget = newSqlBudget()) {
  const sql = String(text);
  checkSqlChars(sql);
  const scan = newScan(sql, depth, firstLine, sourceLineAt, budget);
  while (scan.index < scan.sql.length) scanToken(scan);
  scan.statements.push(trimSqlSpace(scan.current));
  // With an empty buffer psql's gexec can execute the previous query again.
  const gexec = scan.words.some((_, at) => sequenceAt(scan.words, at, ["\\", "gexec"]));
  for (const literal of scan.roleLiterals) {
    const parsedWords = scan.words.filter((_, at) => scan.statement[at] === literal.statement);
    const rawWords = rawSqlTokens(scan.statements[literal.statement]).words;
    if (gexec || [parsedWords, rawWords].some(hasDynamicSqlContext)) {
      scan.guards.push({ id: "auth_dynamic_sql", line: literal.line });
    }
  }
  const { words, lines, starts, ends, statement, statements, unknown, guards } = scan;
  return { words, lines, starts, ends, statement, statements, unknown, guards };
}

/** The state of one tokenizer run: the text, the output arrays and the scan position. */
function newScan(sql, depth, firstLine, sourceLineAt, budget) {
  const breaks = [];
  for (let at = sql.indexOf("\n"); at !== -1; at = sql.indexOf("\n", at + 1)) breaks.push(at);
  return {
    sql,
    budget,
    depth,
    firstLine,
    sourceLineAt,
    breaks,
    words: [],
    lines: [],
    starts: [],
    ends: [],
    statement: [],
    statements: [],
    guards: [],
    roleLiterals: [],
    // The first character no branch classifies, with its line; classifySql then applies no exemption.
    unknown: null,
    // The text of the statement being read, with each comment as a space.
    current: "",
    index: 0,
    // Where the last identifier ended and what it was, for the E'' prefix.
    lastWordEnd: -1,
    lastWord: "",
  };
}

/** The 1-based line of a text offset: the first line plus the line feeds before it. */
function lineAt({ breaks, firstLine, sourceLineAt }, offset) {
  if (sourceLineAt) return sourceLineAt(offset);
  let low = 0;
  let high = breaks.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (breaks[mid] < offset) low = mid + 1;
    else high = mid;
  }
  return firstLine + low;
}

function pushWord(scan, word, line) {
  addSqlTokens(scan.words, scan.budget, [word]);
  scan.lines.push(line);
  scan.starts.push(0);
  scan.ends.push(0);
  scan.statement.push(scan.statements.length);
}

function popWord(scan) {
  scan.words.pop();
  scan.budget.left += 1;
  scan.lines.pop();
  scan.starts.pop();
  scan.ends.pop();
  scan.statement.pop();
}

// Not target.push(...items): spreading a body of about 100k words overflows the call stack.
function appendAll(target, items) {
  for (const item of items) target.push(item);
}

/** Append the words of a string or dollar-quoted body that starts at `offset`; they sit one nesting level deeper. */
function pushBody(scan, body, offset, positions = null) {
  // Decoding and continuation remove source characters; retain the original line of each token.
  const sourceLineAt = (at) => lineAt(scan, positions ? (positions[at] ?? offset) : offset + at);
  const inner = sqlBodyTokens(body, scan.depth, sourceLineAt(0), sourceLineAt, scan.budget);
  scan.unknown ??= inner.unknown;
  appendAll(scan.guards, inner.guards);
  // Raw evidence can only add a guard for these words. Avoid an alternative reading
  // of unrelated bodies: quote delimiters must not consume the parsed-token budget.
  const raw = /grant|revoke|alter|set|standard_conforming_strings|backslash_quote/.test(body.toLowerCase())
    ? rawSqlTokens(body, sourceLineAt) : { words: [], lines: [] };
  for (const [at, word] of raw.words.entries()) {
    if (STRING_LEXING_SETTINGS.includes(word)) scan.guards.push({ id: `auth_${word}`, line: raw.lines[at] });
  }
  // A runtime transform can turn a comment into executable SQL (e.g. replace('-- GRANT ...')).
  // Inspect raw literal words as well as parsed words; never discard that evidence as a comment.
  if (hasRoleCommand(inner.words) || hasRawRoleCommand(raw.words)) {
    scan.roleLiterals.push({ line: sourceLineAt(0), statement: scan.statements.length });
  }
  if (inner.words.length === 0) return;
  inner.starts[0] += 1;
  inner.ends[inner.ends.length - 1] += 1;
  // Inner words were charged when produced; copying their metadata must not charge again.
  appendAll(scan.words, inner.words);
  appendAll(scan.lines, inner.lines);
  appendAll(scan.starts, inner.starts);
  appendAll(scan.ends, inner.ends);
  appendAll(scan.statement, inner.words.map(() => scan.statements.length));
}

// A -- comment ends at LF or CR; it counts as one space.
function scanLineComment(scan) {
  LINE_END.lastIndex = scan.index;
  const end = LINE_END.exec(scan.sql);
  scan.index = end === null ? scan.sql.length : end.index + 1;
  scan.current += " ";
}

// A /* */ comment nests; it counts as one space.
function scanBlockComment(scan) {
  const { sql } = scan;
  let level = 1;
  let index = scan.index + 2;
  while (index < sql.length && level > 0) {
    const pair = sql.slice(index, index + 2);
    if (pair === "/*") {
      level += 1;
      index += 2;
    } else if (pair === "*/") {
      level -= 1;
      index += 2;
    } else index += 1;
  }
  scan.index = index;
  scan.current += " ";
}

// PostgreSQL scan.l quotecontinue allows whitespace and -- comments with at least one LF or CR.
// Block comments do not participate in string continuation.
function continuedQuote(sql, from) {
  let index = from;
  let newline = false;
  while (index < sql.length) {
    if (/[ \t\n\r\f\v]/.test(sql[index])) {
      newline ||= sql[index] === "\n" || sql[index] === "\r";
      index += 1;
    } else if (sql.startsWith("--", index)) {
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
    } else break;
  }
  return newline && sql[index] === "'" ? index : -1;
}

// Consume the full escape, including octal bytes, hex bytes and Unicode code points.
// Unrecognized escapes quote the next character (e.g. \S is S), not a word separator.
function readEscape(sql, from) {
  const tail = sql.slice(from + 1);
  const numeric = /^(?:[0-7]{1,3}|x[\da-fA-F]{1,2}|u[\da-fA-F]{4}|U[\da-fA-F]{8})/.exec(tail)?.[0];
  if (numeric) {
    const octal = /^[0-7]/.test(numeric);
    let code = Number.parseInt(octal ? numeric : numeric.slice(1), octal ? 8 : 16);
    if (octal) code &= 0xff;
    return { value: String.fromCodePoint(code <= 0x10ffff ? code : 0xfffd), end: from + 1 + numeric.length };
  }
  const next = sql[from + 1];
  const controls = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  return { value: controls[next] ?? next ?? "\\", end: Math.min(sql.length, from + 2) };
}

// The body of the quoted string or name that opens at `from`, and where the scan resumes (after the
// closing quote, or at the end of an unterminated one). A doubled quote is one quote character.
function readQuoted(sql, from, quote, escapes) {
  let body = "";
  const positions = [];
  const append = (value, at) => {
    body += value;
    for (let i = 0; i < value.length; i += 1) positions.push(at);
  };
  let index = from + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (escapes && char === "\\") {
      const escape = readEscape(sql, index);
      append(escape.value, index);
      index = escape.end;
    } else if (char === quote && sql[index + 1] === quote) {
      append(quote, index);
      index += 2;
    } else if (char === quote) {
      const continuation = quote === "'" ? continuedQuote(sql, index + 1) : -1;
      if (continuation === -1) return { body, positions, end: index + 1 };
      // Keep the original string's escape mode, including for every subsequent segment.
      index = continuation + 1;
    } else {
      append(char, index);
      index += 1;
    }
  }
  return { body, positions, end: index };
}

// A single-quoted string is SQL again; a double-quoted name is one word.
function scanQuoted(scan) {
  const { sql } = scan;
  const from = scan.index;
  const quote = sql[from];
  // E'' only when the word right before the quote is exactly e (not the tail of aée or xe).
  const escapes = quote === "'" && scan.lastWordEnd === from && scan.lastWord === "e";
  if (escapes && scan.words.at(-1) === "e") popWord(scan);
  const { body, positions, end } = readQuoted(sql, from, quote, escapes);
  scan.index = end;
  if (quote === "'") pushBody(scan, body, from, positions);
  else if (body !== "") pushWord(scan, quotedIdentifierWord(body), lineAt(scan, from));
  scan.current += sql.slice(from, end);
}

// A dollar-quoted body ($$…$$, $tag$…$tag$) opening at the scan position; false when none does.
// An unterminated body runs to the end of the text.
function scanDollarQuoted(scan) {
  const { sql, index } = scan;
  if (sql[index] !== "$" || WORD_CHAR_BEFORE.test(sql.slice(Math.max(0, index - 2), index))) return false;
  DOLLAR_TAG.lastIndex = index;
  const tag = DOLLAR_TAG.exec(sql)?.[0];
  if (!tag) return false;
  const bodyStart = index + tag.length;
  const close = sql.indexOf(tag, bodyStart);
  pushBody(scan, sql.slice(bodyStart, close === -1 ? sql.length : close), bodyStart);
  scan.index = close === -1 ? sql.length : close + tag.length;
  scan.current += sql.slice(index, scan.index);
  return true;
}

// An identifier or keyword at the scan position, as one lower-case word; false when none starts there.
function scanIdentifier(scan) {
  const { sql, index } = scan;
  IDENTIFIER.lastIndex = index;
  if (!IDENTIFIER.test(sql)) return false;
  const word = sql.slice(index, IDENTIFIER.lastIndex);
  pushWord(scan, word.toLowerCase(), lineAt(scan, index));
  scan.index = index + word.length;
  scan.current += word;
  scan.lastWordEnd = scan.index;
  scan.lastWord = word.toLowerCase();
  return true;
}

// Any other character: SQL whitespace is dropped, the rest is a one-character word, and ';' ends a statement.
function scanOther(scan) {
  const { sql, index } = scan;
  const char = sql[index];
  if (!SQL_PLAIN_CHAR.test(char)) scan.unknown ??= { char: sql.codePointAt(index), line: lineAt(scan, index) };
  if (!/[ \t\n\r\f\v]/.test(char)) pushWord(scan, char, lineAt(scan, index));
  scan.index = index + 1;
  scan.current += char;
  if (char === ";") {
    scan.statements.push(trimSqlSpace(scan.current));
    scan.current = "";
  }
}

// Reads one token, or skips one comment, at the scan position.
function scanToken(scan) {
  const { sql, index } = scan;
  const char = sql[index];
  const next = sql[index + 1];
  if (char === "-" && next === "-") scanLineComment(scan);
  else if (char === "/" && next === "*") scanBlockComment(scan);
  else if (char === "'" || char === '"') scanQuoted(scan);
  else if (!scanDollarQuoted(scan) && !scanIdentifier(scan)) scanOther(scan);
}

function sqlBodyTokens(body, depth, firstLine, sourceLineAt, budget) {
  checkSqlChars(body);
  if (depth < MAX_SQL_DEPTH) return sqlTokens(body, depth + 1, firstLine, sourceLineAt, budget);
  const words = [];
  const lines = [];
  for (const match of body.matchAll(IDENTIFIERS)) {
    addSqlTokens(words, budget, [match[0].toLowerCase()]);
    lines.push(sourceLineAt(match.index));
  }
  // Too deep to tokenize: an unexpected ASCII control character still counts as unknown.
  const odd = /[\x00-\x08\x0e-\x1f\x7f]/.exec(body);
  const unknown = odd ? { char: odd[0].codePointAt(0), line: sourceLineAt(odd.index) } : null;
  return { words, lines, starts: words.map(() => 0), ends: words.map(() => 0), unknown,
    guards: [{ id: "auth_depth_limit", line: firstLine }] };
}

/**
 * Fallback for a file the tokenizer could not fully classify: every word and
 * punctuation character of the raw text, comments and string contents
 * included, with quote characters dropped so a quoted name is a plain word.
 * Everything sits at nesting level 0 and statements split at every ';'.
 */
function rawSqlTokens(text, sourceLineAt = null) {
  const sql = String(text);
  checkSqlChars(sql);
  // This is an alternative reading of already charged source, not additional nested tokens.
  // Bound each raw reading independently without charging parsed tokens a second time.
  const budget = newSqlBudget();
  const words = [];
  const lines = [];
  const statement = [];
  let line = 1;
  let statementIndex = 0;
  let last = 0;
  for (const match of sql.matchAll(new RegExp(String.raw`${IDENT_START}${IDENT_CONT}*|[^ \t\n\r\f\v'"$]`, "gu"))) {
    line += sql.slice(last, match.index).split("\n").length - 1;
    last = match.index;
    addSqlTokens(words, budget, [match[0].toLowerCase()]);
    lines.push(sourceLineAt ? sourceLineAt(match.index) : line);
    statement.push(statementIndex);
    if (match[0] === ";") statementIndex += 1;
  }
  return { words, lines, starts: words.map(() => 0), ends: words.map(() => 0), statement, statements: [] };
}

const sequenceAt = (words, start, tokens) => tokens.every((token, offset) => words[start + offset] === token);

const hasRoleCommand = (words) => words.some((word, at) => word === "grant" || word === "revoke" ||
  sequenceAt(words, at, ["alter", "role"]) || sequenceAt(words, at, ["set", "role"]));

// Runtime transforms may remove comment delimiters or other separators between command words.
const hasRawRoleCommand = (words) => words.includes("grant") || words.includes("revoke") ||
  words.some((word, at) => (word === "alter" || word === "set") && words.lastIndexOf("role") > at);

const hasDynamicSqlContext = (words) => words.some((word, at) => word === "execute" ||
  (["format", "concat", "concat_ws"].includes(word) && words[at + 1] === "(") || sequenceAt(words, at, ["|", "|"]) ||
  sequenceAt(words, at, ["\\", "gexec"]));

// These are additive guards, never eligible for the SET/RESET ROLE test exemptions.
// Match the entire pg_ namespace so newly introduced built-in roles fail closed too.
function supplementalAuthRules(readings) {
  const rules = STRING_LEXING_SETTINGS.map((setting) => ({
    id: `auth_${setting}`, tokens: [setting], reason: `${setting} can change SQL string lexing`,
  }));
  const create = [["create", "role"], ["create", "user"], ["create", "group"]];
  const roleStatements = [["grant"], ["set", "role"], ["set", "local", "role"], ["set", "session", "role"],
    ...create, ["alter", "role"], ["alter", "user"], ["alter", "group"]];
  for (const tokens of [[":"], ["\\", "gexec"]]) rules.push({
    id: "auth_psql_role", tokens, within: roleStatements, reason: "psql can construct or execute a role command at runtime",
  });
  const roles = new Set(readings.flatMap(({ tokens }) => tokens.words).filter((word) =>
    word.replace(/^"/, "").startsWith("pg_") ||
    ["supabase_etl_admin", "supabase_superuser", "pgbouncer", "current_user", "session_user", "current_role"].includes(word)));
  for (const role of roles) {
    rules.push(
      { id: "auth_grant_privileged_target", tokens: [role], within: [["grant"]], until: "to" },
      { id: "auth_in_role_privileged_target", tokens: [role], within: create, after: [["in", "role"], ["in", "group"]] },
      { id: "auth_alter_group_privileged_target", tokens: ["alter", "group", role, "add"] },
    );
    for (const clause of ["user", "role", "admin"]) rules.push({
      id: `auth_members_${clause}_privileged_target`, tokens: [role],
      within: [...create, ["alter", "role"], ["alter", "user"]], until: clause,
    });
  }
  return rules.map((rule) => ({ class: "auth", reason: "Membership in a privileged or executor-resolved role", ...rule }));
}

/** The string nesting level of every word: 0 outside any string, 1 inside one, and so on. */
function nestingLevels({ starts, ends }) {
  const levels = [];
  let level = 0;
  for (let at = 0; at < starts.length; at += 1) {
    level += starts[at];
    levels.push(level);
    level -= ends[at];
  }
  return levels;
}

/**
 * Whether the word at `at` ends a statement for a match at nesting `level`:
 * a ';' at that level or a shallower one. A ';' inside a string literal or
 * dollar-quoted body nested in the statement (`password ';'`) does not end it.
 */
const boundary = (words, levels, at, level) => words[at] === ";" && levels[at] <= level;

/** Whether one of the `within` sequences starts the statement before `start` (back to the previous ';'). */
function withinStatement(words, levels, start, within) {
  let first = start;
  while (first > 0 && !boundary(words, levels, first - 1, levels[start])) first -= 1;
  for (let at = first; at < start; at += 1) if (within.some((tokens) => sequenceAt(words, at, tokens))) return true;
  return false;
}

/** Whether `token` follows `from` before the statement of the match at `start` ends. */
function followedBy(words, levels, start, from, token) {
  for (let at = from; at < words.length && !boundary(words, levels, at, levels[start]); at += 1) if (words[at] === token) return true;
  return false;
}

/**
 * Whether the argument that opens at the last word of a matched `inside`
 * sequence (`last`, at string nesting `level`) is still open at `start`. A call
 * (`call`: the sequence ends in '(') is open until its matching ')'; any other
 * sequence is open to the end of its own statement. Parentheses and ';' count
 * only at `level`, and an argument inside a string ends with that string.
 */
function argumentOpen({ words, ends }, levels, { last, start, level, call }) {
  let depth = 0;
  // The scan starts at the sequence's last word, so a call's own '(' opens depth 1.
  for (let cursor = last; cursor < start; cursor += 1) {
    // A sequence inside a string ends with that string ('EXECUTE' does not reach the next literal).
    if (boundary(words, levels, cursor, level) || levels[cursor] - ends[cursor] < level) return false;
    if (!call || levels[cursor] !== level) continue;
    if (words[cursor] === "(") depth += 1;
    else if (words[cursor] === ")") depth -= 1;
    if (words[cursor] === ")" && depth <= 0) return false;
  }
  return true;
}

/** Whether the `inside` sequence `tokens` at `at` opens an argument that is still open at `start`. */
function sequenceOpensArgument(view, levels, start, at, tokens) {
  const last = at + tokens.length - 1;
  if (last >= start || !sequenceAt(view.words, at, tokens) || levels[at] > levels[start]) return false;
  return argumentOpen(view, levels, { last, start, level: levels[at], call: tokens.at(-1) === "(" });
}

/**
 * Whether the match at `start` lies in the argument of one of the `inside`
 * sequences in the same top-level statement. A sequence ending in '(' is a
 * call whose argument runs to its matching ')' (format(…)); any other
 * sequence takes everything after it up to the end of its own statement
 * (EXECUTE …). Parentheses and ';' count only at the sequence's string
 * nesting level, so those inside literals do not close the argument, and the
 * match may sit deeper (in a literal or dollar-quoted body) but not shallower.
 */
function insideArgument(view, levels, start, inside) {
  const { statement } = view;
  for (let at = start - 1; at >= 0 && statement[at] === statement[start]; at -= 1) {
    if (inside.some((tokens) => sequenceOpensArgument(view, levels, start, at, tokens))) return true;
  }
  return false;
}

/** Whether the within, after, inside and until constraints of `rule` hold for its match at `start`. */
function ruleConstraintsHold(rule, tokens, levels, start) {
  const { words } = tokens;
  if (rule.within && !withinStatement(words, levels, start, rule.within)) return false;
  if (rule.after && !withinStatement(words, levels, start, rule.after)) return false;
  if (rule.inside && !insideArgument(tokens, levels, start, rule.inside)) return false;
  return !rule.until || followedBy(words, levels, start, start + rule.tokens.length, rule.until);
}

/** The hit for the match of `rule` at `start`: exempt when an exemption's statement pattern matches its whole statement. */
function ruleHit(rule, { tokens, levels }, start, exemptions, path) {
  const hit = { id: rule.id, class: rule.class, path, line: tokens.lines[start], sensitive: !rule.informational };
  if (rule.informational) {
    hit.informational = true;
    return hit;
  }
  const { statements, statement } = tokens;
  const exemption = exemptions.find((entry) => entry.statements[rule.id]?.test(statements[statement[start]]) && levels[start] === 0);
  if (exemption) Object.assign(hit, { sensitive: false, exemption: exemption.id, gate_loosening: true });
  return hit;
}

/** Every hit of `rule` in one reading of the text. */
function readingHits(rule, reading, exemptions, path) {
  const { tokens, levels } = reading;
  const found = [];
  for (let start = 0; start < tokens.words.length; start += 1) {
    if (sequenceAt(tokens.words, start, rule.tokens) && ruleConstraintsHold(rule, tokens, levels, start)) {
      found.push(ruleHit(rule, reading, start, exemptions, path));
    }
  }
  return found;
}

/** The hits of every reading, keeping per line the larger count (the first reading's list is extended in place). */
function mergeReadingHits([merged, ...extras]) {
  const count = (list, line) => list.filter((hit) => hit.line === line).length;
  for (const extra of extras) {
    for (const line of new Set(extra.map((hit) => hit.line))) {
      const missing = count(extra, line) - count(merged, line);
      appendAll(merged, extra.filter((hit) => hit.line === line).slice(0, Math.max(0, missing)));
    }
  }
  return merged;
}

/** The exemptions that apply to `path`: none for a path that is not plain or a file with an unknown character. */
function exemptionsFor(config, path, unknown) {
  // A '.', '..' or empty segment could walk an exempt prefix out of its directory, so such a path is never exempt.
  const plainPath = path !== null && String(path).split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (!plainPath || unknown) return [];
  return config.sqlContent.exemptions.filter((entry) => entry.paths.some((re) => re.test(path)));
}

const unknownCharReason = ({ char, line }) => {
  const code = `U+${char.toString(16).toUpperCase().padStart(4, "0")}`;
  return `sql:tokenizer_unknown_char: ${code} on line ${line} is not a character the SQL tokenizer classifies, so no comment, string or statement exemption applies to this file and it fails closed`;
};

/** Every class a non-informational rule can add: the tokenizer may be out of step with Postgres, so any could be hidden. */
function failClosedClasses(rules) {
  const classes = [];
  for (const rule of rules) if (!rule.informational && !classes.includes(rule.class)) classes.push(rule.class);
  return classes;
}

/**
 * Classes whose token sequences occur in the SQL text. Each matching rule adds
 * the reason `<class>:sql:<id>: <reason>`. Every occurrence is also a hit with
 * its rule id, path and line. An informational rule's hits never add a class.
 * A rule with `inside` matches only within the argument of one of those
 * sequences (see insideArgument).
 * When `path` matches an exemption that lists the rule and the hit's whole
 * top-level statement (comments stripped) is exactly SET [LOCAL] ROLE with one
 * of the exemption's unquoted targets, the hit is exempt and is marked
 * gate_loosening: true and reported in the result's top-level sql_exemptions
 * list and job summary; the rule adds its class only for a hit that is not exempt.
 * A hit inside a string or dollar-quoted body is never exempt: its statement
 * holds the quoted text, which the statement pattern cannot match.
 * When the tokenizer meets a character it does not classify, the file gets no
 * exemption: the rules run over both the parsed tokens and rawSqlTokens (which
 * reads comments and quotes as code), the hits are the union of both (per rule
 * and line, the larger count), every hit stays sensitive, the reason
 * `sql:tokenizer_unknown_char: …` is added and the file fails closed with every
 * class a non-informational SQL rule can add (rls, definer, auth).
 * @returns {{classes: string[], reasons: string[], hits: object[]}}
 */
export function classifySql(text, config, path = null) {
  try {
    return classifySqlTokens(text, config, path);
  } catch (error) {
    if (!(error instanceof SqlTooLargeError)) throw error;
    return oversizedSql(config);
  }
}

/** Every configured SQL class is possible when scanning exceeds either size cap. */
function oversizedSql(config) {
  return { classes: [...new Set(config.sqlContent.rules.map((rule) => rule.class))], reasons: [SQL_OVERSIZED_REASON], hits: [] };
}

function classifySqlTokens(text, config, path) {
  const parsed = sqlTokens(text);
  // A character the tokenizer cannot classify may mean it is out of step with Postgres, so the file gets
  // no exemption at all: the rules also run over the raw text with comments and quotes read as code
  // (rawSqlTokens), whose structure is coarser, and every hit of either reading is reported.
  const { unknown } = parsed;
  const readings = (unknown ? [parsed, rawSqlTokens(text)] : [parsed]).map((tokens) => ({ tokens, levels: nestingLevels(tokens) }));
  const exemptions = exemptionsFor(config, path, unknown);
  const classes = unknown ? failClosedClasses(config.sqlContent.rules) : [];
  const reasons = unknown ? [unknownCharReason(unknown)] : [];
  const hits = [];
  for (const rule of [...config.sqlContent.rules, ...supplementalAuthRules(readings)]) {
    // Per reading, this rule's hits; with two readings, keep per line the larger count.
    const merged = mergeReadingHits(readings.map((reading) => readingHits(rule, reading, exemptions, path)));
    appendAll(hits, merged);
    if (!merged.some((hit) => hit.sensitive)) continue;
    if (!classes.includes(rule.class)) classes.push(rule.class);
    reasons.push(`${rule.class}:sql:${rule.id}: ${rule.reason}`);
  }
  for (const guard of parsed.guards) {
    if (!classes.includes("auth")) classes.push("auth");
    const reason = {
      auth_depth_limit: "SQL nesting reached the tokenizer depth limit",
      auth_dynamic_sql: "A dynamic SQL literal contains a role command, possibly inside a runtime-transformed comment",
      ...Object.fromEntries(STRING_LEXING_SETTINGS.map((setting) => [`auth_${setting}`, `${setting} can change SQL string lexing`])),
    }[guard.id];
    const message = `auth:sql:${guard.id}: ${reason}`;
    if (!reasons.includes(message)) reasons.push(message);
    if (!hits.some((hit) => hit.id === guard.id && hit.line === guard.line)) {
      hits.push({ ...guard, class: "auth", path, sensitive: true });
    }
  }
  hits.sort((a, b) => a.line - b.line);
  return { classes, reasons, hits };
}

// ---------------------------------------------------------------- door report (never changes legacy classification)

const DOOR_RULE_IDS = ["O-SQL", "O-MIGDIR", "O-SECRET", "O-NET", "O-DEP", "O-GATE", "O-RM"];
const MAX_DOOR_FILE_BYTES = 256 * 1024;
const MAX_DOOR_BYTES = 4 * 1024 * 1024;
const MAX_DOOR_SCANS = 200;
const MAX_DOOR_MS = 1000;

class DoorScanBudgetError extends Error {}

function doorBudget() {
  const deadline = performance.now() + MAX_DOOR_MS;
  let bytes = 0;
  const check = () => {
    if (performance.now() >= deadline) throw new DoorScanBudgetError();
  };
  return {
    check,
    deadline,
    consume(text) {
      check();
      // Bound input length before walking it to measure UTF-8 bytes.
      if (text.length > MAX_DOOR_FILE_BYTES) throw new DoorScanBudgetError();
      const size = Buffer.byteLength(text);
      bytes += size;
      if (size > MAX_DOOR_FILE_BYTES || bytes > MAX_DOOR_BYTES) throw new DoorScanBudgetError();
    },
  };
}

function doorConfig(config) {
  const door = config?.door;
  if (!isPlainObject(door) || !isPlainObject(door.classes) || !Array.isArray(door.rules)
      || Object.keys(door.classes).length !== OUTPUT_CLASSES.length
      || OUTPUT_CLASSES.some((name) => !["one-way", "revertable"].includes(door.classes[name]))
      || door.rules.length !== DOOR_RULE_IDS.length) throw new Error("invalid door config");
  const rules = new Map();
  for (const rule of door.rules) {
    if (!DOOR_RULE_IDS.includes(rule.id) || rules.has(rule.id) || !Array.isArray(rule.patterns)
        || typeof rule.reason !== "string" || !["head", "changed", "removed", "path"].includes(rule.scope)) throw new Error("invalid door rule");
    rules.set(rule.id, { ...rule, patterns: rule.patterns.map((pattern) => new RegExp(pattern, "im")) });
  }
  return { classes: door.classes, rules };
}

async function doorText(reader, file, timeoutMs, budget) {
  budget.check();
  if (!reader) throw new Error("missing content reader");
  const remaining = budget.deadline - performance.now();
  let timer;
  try {
    const text = await Promise.race([
      Promise.resolve().then(() => reader(file)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(remaining <= timeoutMs ? new DoorScanBudgetError() : new Error("door read timeout")), Math.min(timeoutMs, remaining)); }),
    ]);
    if (typeof text !== "string") throw new Error("unscannable content");
    budget.consume(text);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// A line multiset preserves deletions even when the same text occurs elsewhere.
function unmatchedLines(text, other) {
  const counts = new Map();
  for (const line of other.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  return text.split("\n").filter((line) => {
    const count = counts.get(line) ?? 0;
    if (count) counts.set(line, count - 1);
    return count === 0;
  }).join("\n");
}

const doorPathForms = (file) => pathCandidates(file).map((form) => form.normalize("NFKC").toLowerCase());
const testPath = (file) => /(?:\.(?:test|node-test)\.[^/]+$|(?:^|\/)(?:tests?|e2e)\/)/i.test(file);
const hostsIn = (text) => [...text.matchAll(/https?:\/\/[^\s"'`<>\\)]+/gi)].flatMap(([url]) => {
  try { return [new URL(url).hostname.toLowerCase()]; } catch { return []; }
});
const networkCall = /\b(?:fetch|axios|request)\s*(?:\.[a-z]+\s*)?\(|\bpage\s*\.\s*goto\s*\(/i;
const submitWords = /submit|place[\s_-]*order|checkout|send|confirm|request[\s_-]*quote/i;

// Each search resumes after the previous comment. An unclosed comment runs to EOF.
function stripDoorComments(text) {
  const chunks = [];
  let cursor = 0;
  let start;
  while ((start = text.indexOf("/*", cursor)) !== -1) {
    chunks.push(text.slice(cursor, start), " ");
    const end = text.indexOf("*/", start + 2);
    if (end === -1) return chunks.join("");
    cursor = end + 2;
  }
  chunks.push(text.slice(cursor));
  return chunks.join("");
}

function scanDoorContent({ text, base, added, removed, file, rules, add, budget }) {
  const test = (pattern, source) => {
    budget.check();
    const matched = pattern.test(source);
    budget.check();
    return matched;
  };
  const head = text;
  const changed = added + "\n" + removed;
  for (const id of ["O-SQL", "O-MIGDIR", "O-SECRET", "O-GATE"]) {
    budget.check();
    const rule = rules.get(id);
    const source = rule.scope === "changed" ? changed : rule.scope === "removed" ? removed : head;
    // Existing literal RPC names are not new functions. A computed name cannot be proved safe.
    const patterns = id === "O-SQL" ? rule.patterns.slice(0, -1) : rule.patterns;
    const sqlSpacing = id === "O-SQL" ? stripDoorComments(source) : source;
    if (patterns.some((pattern) => test(pattern, source) || test(pattern, sqlSpacing))) add(id, file.path);
  }
  if (test(rules.get("O-SQL").patterns.at(-1), head)) {
    const calls = [...head.matchAll(/\.rpc\s*\(\s*([^\n,)]+)/g)].map((match) => match[1].trim());
    const literal = /^["'][a-z_][a-z0-9_]*["']$/i;
    const baseNames = new Set([...base.matchAll(/\.rpc\s*\(\s*(["'][a-z_][a-z0-9_]*["'])/gi)].map((match) => match[1].slice(1, -1)));
    if (/\bsql\s*`/i.test(head) || !calls.length || calls.some((call) => !literal.test(call) || !baseNames.has(call.slice(1, -1)))) add("O-SQL", file.path);
  }
  // Scanning the entire head is deliberately conservative: comments and existing sends count.
  const sends = rules.get("O-NET").patterns.some((pattern) => test(pattern, head))
    || (networkCall.test(head) && /["'`](?:POST|PUT|PATCH|DELETE)["'`]/i.test(head));
  const click = /\bclick\s*\(/i.test(head) && submitWords.test(head);
  if (sends || click) add("O-NET", file.path);
  else if (networkCall.test(head)) {
    // An explicit non-GET/HEAD method, indirect options/client, SDK or request callback
    // is ambiguous. Pure fetch(url), GET/HEAD and page.goto(url) are read-only.
    const indirect = /,\s*[A-Za-z_$]/.test(head) || /\.\.\./.test(head) || /\[[^\]\n]*\]\s*:/.test(head);
    const methods = [...head.matchAll(/\b["']?method["']?\s*:\s*([^,}\n]+)/gi)].map((match) => match[1].trim());
    const unknownClient = /\b(?:axios|request)\s*\(/i.test(head) && !methods.length;
    if (indirect || unknownClient || methods.some((method) => !/^["'`](?:GET|HEAD)["'`]$/i.test(method))) add("net_ambiguous", file.path);
  } else if (/\b(?:new\s+\w*(?:Client|SDK)|webhook|sdk)\b/i.test(head) && !testPath(file.path)) add("net_ambiguous", file.path);
  const baseHosts = new Set(hostsIn(base));
  if (!sends && !click && hostsIn(added).some((host) => !baseHosts.has(host)) && !file.classes.includes("deps")) {
    add("net_read_only_new_host", file.path, false);
  }
  if (file.classes.includes("deps")) {
    // Only registry.npmjs.org tarballs are exempt. Funding URLs are not dependency sources.
    const depText = added.replaceAll(/https?:\/\/registry\.npmjs\.org\/[^\s"']+/g, "npm-registry-source");
    const install = rules.get("O-DEP").patterns.some((pattern) => test(pattern, depText));
    const resolved = [...added.matchAll(/["']?resolved["']?\s*:\s*["']([^"']+)["']/gi)].map((match) => match[1]);
    const foreign = resolved.some((url) => {
      try { return new URL(url).hostname !== "registry.npmjs.org"; } catch { return true; }
    });
    if (install || foreign) add("O-DEP", file.path);
  }
  // Removing a required section entry often removes only its quoted name.
  if (removed && /\bREQUIRED_SECTIONS\b/.test(base)) add("O-GATE", file.path);
  budget.check();
}

/**
 * Add only door/door_reasons to a detector result. Read pinned content as data,
 * never execute it. Missing coverage, errors, timeouts and scanner exceptions
 * fail closed in this report without changing the legacy result or its status.
 */
export async function doorTier(result, options = {}) {
  const reasons = [];
  let oneWay = false;
  const add = (code, path, blocking = true) => {
    if (blocking) oneWay = true;
    if (!reasons.some((reason) => reason.code === code && reason.path === path)) reasons.push({ code, ...(path ? { path } : {}) });
  };
  const budget = doorBudget();
  try {
    const { config = loadConfig().config, headSha = result.sha, files = result.files.map((file) => ({ filename: file.path, previous_filename: file.previous_path, status: file.status })), changedFiles = files.length, readHeadFile, readBaseFile, timeoutMs = 5000 } = options;
    const { classes, rules } = doorConfig(config);
    if (result.status !== "ok" || typeof result.sha !== "string" || !/^[a-f0-9]{40}$/i.test(result.sha) || result.sha !== headSha || result.files.length !== changedFiles || files.length !== changedFiles
        || new Set(result.files.map((file) => file.path)).size !== changedFiles
        || files.some((file) => !result.files.some((entry) => entry.path === file.filename && entry.status === file.status && (entry.previous_path ?? null) === (file.previous_filename ?? null)))) add("classifier_error");
    if (result.gate_loosening?.detected) add("O-GATE");
    for (const name of result.classes) if (classes[name] !== "revertable") add(`class:${name}`);
    let scanned = 0;
    for (const file of result.files) {
      budget.check();
      for (const name of file.classes) if (classes[name] !== "revertable") add(`class:${name}`, file.path);
      const paths = [file.path, file.previous_path].filter(Boolean);
      const forms = paths.flatMap(doorPathForms);
      if (forms.some((form) => form.startsWith("supabase/migrations/"))) add("O-MIGDIR", file.path);
      if (forms.some((form) => form.startsWith(".github/") || /(?:^|\/)(?:codeowners|.*ruleset.*|.*branch.protection.*)$/.test(form))) add("O-GATE", file.path);
      // Unicode compatibility spellings must not bypass the base matcher's classes.
      const pathClasses = paths.map((name) => doorPathForms(name).flatMap((form) => config.matcher.classify(form)));
      for (const names of pathClasses) for (const name of names) if (classes[name] !== "revertable") add(`class:${name}`, file.path);
      if ((file.status === "removed" || file.status === "renamed") && pathClasses.some((names) => names.length)) add("O-RM", file.path);
      if (file.previous_path && pathClasses.map((names) => names.some((name) => classes[name] !== "revertable") ? "one-way" : names.length ? "revertable" : "normal").some((door, _, doors) => door !== doors[0])) add("rename_mixed_doors", file.path);
      if (file.status === "removed" && testPath(file.path)) add("O-GATE", file.path);
      // A one-way class already determines this file. Do not add content reads
      // that could change legacy SQL reader failures or classifications.
      if (file.classes.some((name) => classes[name] !== "revertable")) continue;
      // Once the PR is one-way, more content reads cannot change the door; skip them
      // to bound GitHub API use. Past the scan cap, fail closed instead of reading.
      if (oneWay) continue;
      if (++scanned > MAX_DOOR_SCANS) {
        add("door_scan_cap");
        continue;
      }
      try {
        const text = file.status === "removed" ? "" : await doorText(readHeadFile, file.path, timeoutMs, budget);
        const base = file.status === "added" ? "" : await doorText(readBaseFile, file.previous_path ?? file.path, timeoutMs, budget);
        budget.check();
        scanDoorContent({ text, base, added: unmatchedLines(text, base), removed: unmatchedLines(base, text), file, rules, add, budget });
      } catch (error) {
        add(error instanceof DoorScanBudgetError ? "door_scan_budget" : "classifier_error", file.path);
      }
    }
    return { ...result, door: oneWay ? "one-way" : result.classes.length ? "revertable" : null, door_reasons: reasons };
  } catch (error) {
    add(error instanceof DoorScanBudgetError ? "door_scan_budget" : "classifier_error");
    return { ...result, door: "one-way", door_reasons: reasons };
  }
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

// Runs `task` over the items one at a time, in order. An async generator's `yield` awaits the promise it
// is given before the next item starts, so a PR with many SQL files reads its head files one by one.
async function* inSequence(items, task) {
  for (const [index, item] of items.entries()) yield task(item, index);
}

function addClasses(classes, names) {
  for (const name of names) if (!classes.includes(name)) classes.push(name);
}

/** The classes, reasons and safe categories from a file's name (and its previous name when it was renamed). */
function classifyNames(file, config) {
  const paths = [file.filename];
  if (file.previous_filename && file.previous_filename !== file.filename) paths.push(file.previous_filename);
  const classes = [];
  const reasons = [];
  const categories = [];
  for (const path of paths) {
    const result = classifyPath(path, config);
    const label = path === file.filename ? "" : "previous:";
    addClasses(classes, result.classes);
    reasons.push(...result.reasons.map((reason) => label + reason));
    categories.push(result.category);
  }
  return { paths, classes, reasons, categories };
}

/** The SQL classification of a file's head content, or the error that kept it from being read. */
async function classifyHeadSql(filename, config, readHeadFile) {
  try {
    if (!readHeadFile) throw new Error("no head reader");
    return { sql: classifySql(await readHeadFile(filename), config, filename) };
  } catch (error) {
    return { error: `could not read ${filename} at head: ${messageOf(error)}` };
  }
}

/** The result entry of one changed file; `entry` is null for a malformed file, and `errors` is what went wrong. */
async function classifyFile(file, index, config, readHeadFile) {
  const problem = fileProblem(file);
  if (problem) return { entry: null, errors: [`changed file ${index + 1}: ${problem}`] };
  const { paths, classes, reasons, categories } = classifyNames(file, config);
  const errors = [];
  let sqlHits = null;
  if (readsHead(file.status) && config.sqlContent.paths.some((re) => re.test(file.filename))) {
    const { sql, error } = await classifyHeadSql(file.filename, config, readHeadFile);
    if (error) errors.push(error);
    else {
      addClasses(classes, sql.classes);
      reasons.push(...sql.reasons);
      sqlHits = sql.hits;
    }
  }
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
  if (sqlHits) entry.sql_hits = sqlHits;
  return { entry, errors };
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
export async function detect({ files, readHeadFile, readBaseFile, config, sha = null, baseSha = null, errors = [], allowEmpty = false, changedFiles, headSha = sha }) {
  const headCache = new Map();
  const readHead = readHeadFile && ((file) => {
    if (!headCache.has(file)) headCache.set(file, Promise.resolve().then(() => readHeadFile(file)));
    return headCache.get(file);
  });
  const allErrors = [...errors];
  const list = Array.isArray(files) ? files : [];
  if (!Array.isArray(files)) allErrors.push("the changed-file list is not an array");
  else if (files.length === 0 && !allowEmpty) allErrors.push("the changed-file list is empty, but the PR does not report zero changed files");
  const results = [];
  for await (const outcome of inSequence(list, (file, index) => classifyFile(file, index, config, readHead))) {
    allErrors.push(...outcome.errors);
    if (outcome.entry) results.push(outcome.entry);
  }

  const classes = OUTPUT_CLASSES.filter((name) => results.some((file) => file.classes.includes(name)));
  const result = {
    version: OUTPUT_VERSION,
    sha,
    base_sha: baseSha,
    status: allErrors.length ? "error" : "ok",
    classes,
    sensitive_count: results.filter((file) => file.classes.length).length,
    multi_class: classes.length > 1,
    files: results,
    unclassified: results.filter((file) => file.classes.includes(UNCLASSIFIED)).map((file) => file.path),
    // SQL hits an exemption cleared; each one is a place the gate is looser than the plain rule.
    sql_exemptions: results.flatMap((file) => (file.sql_hits ?? []).filter((hit) => hit.gate_loosening)),
    errors: allErrors,
    ...manualReview(results),
  };
  return doorTier(result, { config, files: list, changedFiles, headSha, readHeadFile: readHead, readBaseFile });
}

/** A manual_review list for files whose SQL was too large to scan, or nothing. */
function manualReview(results) {
  const notices = results
    .filter((file) => file.reasons.includes(SQL_OVERSIZED_REASON))
    .map((file) => `SQL body ${file.path} rejected for size: exceeds the limit of ${MAX_SQL_TOKENS} tokens; manual review is required`);
  return notices.length ? { manual_review: notices } : {};
}

/** The result for a run that could not classify anything. */
export function errorResult(errors, { sha = null, baseSha = null } = {}) {
  const gate_loosening = detectGateLoosening({ incomplete: "the PR could not be classified" });
  return { version: OUTPUT_VERSION, sha, base_sha: baseSha, status: "error", classes: [], sensitive_count: 0, multi_class: false, files: [], unclassified: [], errors, gate_loosening, door: "one-way", door_reasons: [{ code: "classifier_error" }] };
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
const sqlRuleKey = (rule) => JSON.stringify([rule?.id, rule?.class, rule?.tokens, rule?.reason]);

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

function removedCategories(baseCategories, headCategories, at) {
  return Object.keys(baseCategories)
    .filter((name) => !Object.hasOwn(headCategories, name))
    .map((name) => ({ kind: "category_narrowed", path: at, entry: `safe_categories.${name}`, message: `${at} removes safe category "${name}"; a path it matched can fall through to a later category.` }));
}

function categoryOrderChange(baseCategories, headCategories, at) {
  const baseOrder = Object.keys(baseCategories).filter((name) => Object.hasOwn(headCategories, name));
  const headOrder = Object.keys(headCategories).filter((name) => Object.hasOwn(baseCategories, name));
  if (baseOrder.join("\n") === headOrder.join("\n")) return [];
  return [{ kind: "category_order_changed", path: at, entry: "safe_categories", value: headOrder, message: `${at} reorders safe categories from ${JSON.stringify(baseOrder)} to ${JSON.stringify(headOrder)}.` }];
}

/** Every item added to or removed from one match field of one safe category (a new category diffs against an empty one). */
function fieldChanges(name, field, prior, entry, at) {
  const effect = CATEGORY_FIELD_EFFECTS[field] ?? UNKNOWN_FIELD_EFFECT;
  const before = new Set(listOf(prior, field));
  const after = new Set(listOf(entry, field));
  const change = (kind, value, verb, preposition) => ({
    kind,
    path: at,
    entry: `safe_categories.${name}`,
    field,
    value,
    message: `${at} ${verb} ${field} ${JSON.stringify(value)} ${preposition} safe category "${name}".`,
  });
  return [
    ...[...after].filter((value) => !before.has(value)).map((value) => change(effect.added, value, "adds", "to")),
    ...[...before].filter((value) => !after.has(value)).map((value) => change(effect.removed, value, "removes", "from")),
  ];
}

// Safe categories. A path takes the first safe category that matches, and a
// rename stays safe only when both names land in the same one, so any change
// to which category a path lands in can exempt a file. Flagged: a removed
// category, a reorder of the categories kept from base, and every item added
// to or removed from any CATEGORY_MATCH_FIELDS field (a new category diffs
// against an empty one). When none is flagged, every base category survives
// with the same match sets in the same relative order and any new category
// matches nothing, so every path lands where it did on base.
function diffSafeCategories(baseCategories, headCategories, at) {
  return [
    ...removedCategories(baseCategories, headCategories, at),
    ...categoryOrderChange(baseCategories, headCategories, at),
    ...Object.entries(headCategories).flatMap(([name, entry]) => {
      const prior = Object.hasOwn(baseCategories, name) ? baseCategories[name] : {};
      return CATEGORY_MATCH_FIELDS.flatMap((field) => fieldChanges(name, field, prior, entry, at));
    }),
  ];
}

function sqlPathChanges(baseSql, headSql, at) {
  const kept = new Set(listOf(headSql, "paths"));
  return listOf(baseSql, "paths")
    .filter((value) => !kept.has(value))
    .map((value) => ({ kind: "rule_narrowed", path: at, entry: "sql_content", field: "paths", value, message: `${at} removes or edits sql_content path ${JSON.stringify(value)}.` }));
}

function sqlRuleRemovals(baseSql, headSql, at) {
  const kept = new Set(listOf(headSql, "rules").map(sqlRuleKey));
  return listOf(baseSql, "rules")
    .filter((rule) => !kept.has(sqlRuleKey(rule)))
    .map((rule) => ({ kind: "sql_rule_removed", path: at, entry: "sql_content", value: sqlRuleKey(rule), message: `${at} removes or edits sql_content rule ${JSON.stringify(sqlRuleKey(rule))}.` }));
}

// Keep the base rule identity above; structural restrictions and informational
// status also affect matching, so conservatively flag any edit to them.
const ruleConstraints = (rule) => JSON.stringify([rule?.within, rule?.after, rule?.inside, rule?.until, rule?.informational]);

function sqlRuleConstraintChanges(baseSql, headSql, at) {
  const headRules = listOf(headSql, "rules");
  return listOf(baseSql, "rules").flatMap((rule) => {
    const kept = headRules.find((candidate) => sqlRuleKey(candidate) === sqlRuleKey(rule));
    if (!kept || ruleConstraints(kept) === ruleConstraints(rule)) return [];
    return [{ kind: "sql_rule_changed", path: at, entry: "sql_content", value: rule.id, message: `${at} changes SQL rule constraints for ${rule.id}.` }];
  });
}

// Added or edited SQL exemptions can clear hits that were sensitive on base.
function sqlExemptionChanges(baseSql, headSql, at) {
  const known = new Set(listOf(baseSql, "exemptions").map((entry) => JSON.stringify(entry)));
  return listOf(headSql, "exemptions")
    .filter((exemption) => !known.has(JSON.stringify(exemption)))
    .map((exemption) => ({ kind: "exemption_added", path: at, entry: "sql_content.exemptions", value: exemption.id, message: `${at} adds or edits SQL exemption ${exemption.id}.` }));
}

function diffConfig(base, head) {
  const at = CONFIG_REPO_PATH;
  const categories = diffSafeCategories(objectOf(base.safe_categories), objectOf(head.safe_categories), at);
  const baseSql = objectOf(base.sql_content);
  const headSql = objectOf(head.sql_content);
  return [
    ...(JSON.stringify(base.door) !== JSON.stringify(head.door) ? [{ kind: "door_changed", path: at, message: `${at} changes door rules; needs governance review.` }] : []),
    ...categories,
    ...sqlPathChanges(baseSql, headSql, at),
    ...sqlRuleRemovals(baseSql, headSql, at),
    ...sqlRuleConstraintChanges(baseSql, headSql, at),
    ...sqlExemptionChanges(baseSql, headSql, at),
  ];
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

const pullShas = (pull) => ({ sha: pull?.head?.sha ?? null, baseSha: pull?.base?.sha ?? null });

/**
 * Read a PR's head and base, its changed files and a head reader. A list that
 * cannot be complete (more than MAX_FILES files, a failed page, a count that
 * disagrees with the PR, or a head that moved) is an error. changedFiles is
 * the PR's own count, so a consumer can tell an empty PR from a lost list.
 *
 * expectedBaseSha is the commit whose rules judge the PR (the workflow's base
 * checkout). A PR whose base has moved past it is an error: the result would
 * report the newer base while older rules classified it.
 *
 * The files endpoint lists the live PR, not a fixed head, so a push (or a base
 * change) while the pages are read can swap the files and keep the count. The
 * PR is read again after the last page, and a head or base that changed in
 * between is an error. Head content is read at the first head sha, so the
 * SQL and config reads are pinned already.
 */
export async function fetchPullRequest(client, repo, number, { expectedHeadSha, expectedBaseSha } = {}) {
  const pull = await client.json(`/repos/${repo}/pulls/${number}`);
  const { sha, baseSha } = pullShas(pull);
  const errors = [];
  if (expectedHeadSha && sha !== expectedHeadSha) errors.push(`PR head moved: expected ${expectedHeadSha}, API has ${sha}`);
  if (expectedBaseSha && baseSha !== expectedBaseSha) {
    errors.push(`PR base moved: the rules come from ${expectedBaseSha}, API has ${baseSha}`);
  }
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
  const after = pullShas(await client.json(`/repos/${repo}/pulls/${number}`));
  if (after.sha !== sha) errors.push(`PR head moved while its files were listed: ${sha} before, ${after.sha} after`);
  if (after.baseSha !== baseSha) errors.push(`PR base moved while its files were listed: ${baseSha} before, ${after.baseSha} after`);
  if (Number.isInteger(expected) && files.length !== expected) {
    errors.push(`file list is incomplete: API listed ${files.length} of ${expected} changed files`);
  }
  const readHeadFile = (path) => client.raw(`/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(sha)}`);
  const readBaseFile = (path) => client.raw(`/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(baseSha)}`);
  return { sha, baseSha, files, readBaseFile, changedFiles: Number.isInteger(expected) ? expected : null, readHeadFile, errors };
}

// ---------------------------------------------------------------- CLI

export const GATE_LOOSENING_LINE = `${SHARED_GATE_LOOSENING_LINE} (report only; does not fail the PR).`;

// A table cell: single-line text with the cell separator escaped.
const tableCell = (text) => safeInline(text).replaceAll("|", String.raw`\|`);

function summaryHeader(result) {
  const label = result.status === "ok" ? "OK" : "ERROR";
  const lines = [
    `### Sensitive classes: ${label}`,
    "",
    "Mode: `report` (this check never fails the PR)",
    "",
    `Head: ${safeInline(result.sha ?? "unknown")} · base: ${safeInline(result.base_sha ?? "unknown")}`,
    "",
    `Classes: ${result.classes.length ? result.classes.map(safeInline).join(", ") : "none"}`,
    `Door (report only): ${result.door ?? "none"}`,
    ...(result.door_reasons ?? []).map((reason) => `- door: ${safeInline(reason.code)}${reason.path ? ` (${safeInline(reason.path)})` : ""}`),
    `Sensitive files: ${result.sensitive_count} of ${result.files.length}${result.multi_class ? " (multi-class)" : ""}`,
    `Unclassified (sensitive, no safe category): ${result.unclassified.length ? result.unclassified.map(safeInline).join(", ") : "none"}`,
    "",
  ];
  for (const error of result.errors) lines.push(`- error: ${safeInline(error)}`);
  if (result.errors.length) lines.push("");
  for (const notice of result.manual_review ?? []) lines.push(`- manual review: ${safeInline(notice)}`);
  if (result.manual_review?.length) lines.push("");
  return lines;
}

function gateLooseningLines(result) {
  const gate = result.gate_loosening;
  if (gate?.detected) return [GATE_LOOSENING_LINE, ...gate.reasons.map((reason) => `- ${safeInline(reason.message)}`), ""];
  return gate ? ["Gate loosening: none", ""] : [];
}

function fileTableLines(result) {
  if (!result.files.length) return [];
  const rows = result.files.map((file) => {
    const classes = file.classes.map((entry) => (entry === UNCLASSIFIED ? `**${entry}**` : entry)).join(", ");
    return `| ${tableCell(file.path)} | ${file.status ?? ""} | ${classes || "-"} | ${file.category ?? "-"} |`;
  });
  return ["| File | Status | Classes | Category |", "| --- | --- | --- | --- |", ...rows, ""];
}

function exemptionLines(result) {
  const loosening = result.sql_exemptions ?? [];
  if (!loosening.length) return [];
  const ids = [...new Set(loosening.map((hit) => hit.exemption))].join(", ");
  return [`Gate loosening: ${loosening.length} SQL hit(s) exempted by ${ids}`, ""];
}

function hitEffect(hit) {
  if (hit.gate_loosening) return `exempt (gate_loosening: ${hit.exemption})`;
  return hit.informational ? "informational" : "sensitive";
}

function sqlHitLines(result) {
  const hits = result.files.flatMap((file) => file.sql_hits ?? []);
  if (!hits.length) return [];
  const rows = hits.map((hit) => {
    const location = tableCell(`${hit.path}:${hit.line}`);
    return `| ${hit.id} | ${location} | ${hit.class} | ${hitEffect(hit)} |`;
  });
  return ["| SQL rule | Location | Class | Effect |", "| --- | --- | --- | --- |", ...rows, ""];
}

function jsonLines(result) {
  const json = JSON.stringify(result, null, 2);
  const fence = "`".repeat(Math.max(3, ...(json.match(/`+/g) ?? []).map((run) => run.length + 1)));
  return ["<details><summary>JSON</summary>", "", `${fence}json`, json, fence, "", "</details>", ""];
}

export function formatSummary(result) {
  const lines = [
    ...summaryHeader(result),
    ...gateLooseningLines(result),
    ...fileTableLines(result),
    ...exemptionLines(result),
    ...sqlHitLines(result),
    ...jsonLines(result),
  ];
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {};
  const known = ["--repo", "--pr", "--json", "--config", "--head-sha", "--base-sha"];
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

const usage = "Usage: node scripts/sensitive-class-detect.mjs --repo owner/name --pr <number> [--json out.json] [--head-sha <sha>] [--base-sha <sha>] [--config file]\n"
  + "Reads GITHUB_TOKEN or GH_TOKEN. Path classes come from docs/sensitive-paths.json in this checkout.\n"
  + "--base-sha is the commit this checkout is at; a PR whose base has moved past it is status error.\n"
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
      const pull = await fetchPullRequest(client, options.repo, options.pr, { expectedHeadSha: options["head-sha"], expectedBaseSha: options["base-sha"] });
      result = await detect({ ...pull, config, allowEmpty: pull.changedFiles === 0 });
      const incomplete = pull.errors.length ? "the changed-file list is incomplete or stale" : null;
      const loosening = await gateLooseningForPull({ ...pull, baseRaw, sensitivePathsText, incomplete });
      result.gate_loosening = loosening.gateLoosening;
      if (loosening.gateLoosening.detected) {
        result.door = "one-way";
        result.door_reasons.push({ code: "O-GATE" });
      }
      if (loosening.errors.length) {
        result.errors.push(...loosening.errors);
        result.status = "error";
        result.door = "one-way";
        result.door_reasons.push({ code: "classifier_error" });
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
