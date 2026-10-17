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
 * holds only what this detector adds: SQL content rules (rls, definer, auth) over
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
 * "<class>:sql:<id>: <reason>", "<category>:path:<glob>" or
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

const TOP_KEYS = new Set(["version", "description", "syntax", "sql_content", "safe_categories"]);
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
const SQL_SPACE = "[ \\t\\n\\r\\f]";
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

/**
 * Validate and compile the parsed detector config (SQL content rules and safe
 * categories). Unknown keys (a "classes" section included: path classes live
 * in docs/sensitive-paths.json), bad globs and SQL rules for a class outside
 * SQL_RULE_CLASSES are errors, never silently ignored.
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
  let sqlContent = { paths: [], rules: [], exemptions: [] };
  if (!sql || typeof sql !== "object" || Array.isArray(sql)) {
    errors.push("config: sql_content must be an object");
  } else {
    for (const key of Object.keys(sql)) if (!SQL_KEYS.has(key)) errors.push(`sql_content: unknown rule key "${key}"`);
    const rules = Array.isArray(sql.rules) ? sql.rules : (errors.push("sql_content.rules must be an array"), []);
    const ids = new Set();
    const compiledRules = rules.flatMap((rule, index) => {
      const where = `sql_content.rules[${index}]`;
      if (!rule || typeof rule !== "object") return errors.push(`${where} must be an object`), [];
      for (const key of Object.keys(rule)) if (!SQL_RULE_KEYS.has(key)) errors.push(`${where}: unknown rule key "${key}"`);
      if (typeof rule.id !== "string" || !NAME_PATTERN.test(rule.id)) errors.push(`${where}: invalid id`);
      else if (ids.has(rule.id)) errors.push(`${where}: duplicate id "${rule.id}"`);
      ids.add(rule.id);
      if (typeof rule.reason !== "string" || rule.reason.trim() === "") errors.push(`${where}: reason must be a non-empty string`);
      if (!SQL_RULE_CLASSES.includes(rule.class)) errors.push(`${where}: unknown class "${rule.class}"`);
      const tokens = stringList(rule.tokens, `${where}.tokens`, errors, SQL_TOKEN_PATTERN);
      if (tokens.length === 0) errors.push(`${where}.tokens must not be empty`);
      const compiled = { id: rule.id, class: rule.class, tokens, reason: rule.reason, informational: rule.informational === true };
      if (rule.informational !== undefined && typeof rule.informational !== "boolean") errors.push(`${where}.informational must be a boolean`);
      for (const key of ["within", "after", "inside"]) {
        if (rule[key] === undefined) continue;
        if (!Array.isArray(rule[key]) || rule[key].length === 0) errors.push(`${where}.${key} must be a non-empty array of token lists`);
        else {
          compiled[key] = rule[key].map((sequence, at) => stringList(sequence, `${where}.${key}[${at}]`, errors, SQL_TOKEN_PATTERN));
          if (compiled[key].some((sequence) => sequence.length === 0)) errors.push(`${where}.${key} must not contain an empty token list`);
        }
      }
      if (rule.until !== undefined) {
        if (typeof rule.until !== "string" || !SQL_TOKEN_PATTERN.test(rule.until)) errors.push(`${where}.until must be one token`);
        else compiled.until = rule.until;
      }
      return [compiled];
    });
    const exemptions = Array.isArray(sql.exemptions ?? []) ? (sql.exemptions ?? []) : (errors.push("sql_content.exemptions must be an array"), []);
    const exemptionIds = new Set();
    sqlContent = {
      paths: compileGlobs(stringList(sql.paths, "sql_content.paths", errors), "sql_content.paths", errors),
      rules: compiledRules,
      exemptions: exemptions.flatMap((exemption, index) => {
        const where = `sql_content.exemptions[${index}]`;
        if (!exemption || typeof exemption !== "object") return errors.push(`${where} must be an object`), [];
        for (const key of Object.keys(exemption)) if (!SQL_EXEMPTION_KEYS.has(key)) errors.push(`${where}: unknown key "${key}"`);
        if (typeof exemption.id !== "string" || !NAME_PATTERN.test(exemption.id)) errors.push(`${where}: invalid id`);
        else if (exemptionIds.has(exemption.id) || ids.has(exemption.id)) errors.push(`${where}: duplicate id "${exemption.id}"`);
        exemptionIds.add(exemption.id);
        if (typeof exemption.reason !== "string" || exemption.reason.trim() === "") errors.push(`${where}: reason must be a non-empty string`);
        // Every exemption weakens the gate, so the config must say so in place.
        if (exemption.gate_loosening !== true) errors.push(`${where}: gate_loosening must be true`);
        const paths = stringList(exemption.paths, `${where}.paths`, errors);
        if (paths.length === 0) errors.push(`${where}.paths must not be empty`);
        const ruleIds = stringList(exemption.rules, `${where}.rules`, errors);
        if (ruleIds.length === 0) errors.push(`${where}.rules must not be empty`);
        for (const id of ruleIds) {
          const rule = compiledRules.find((candidate) => candidate.id === id);
          if (!rule) errors.push(`${where}: unknown rule "${id}"`);
          else if (rule.informational) errors.push(`${where}: rule "${id}" is informational`);
          else if (!SQL_EXEMPTABLE_RULES.has(id)) errors.push(`${where}: rule "${id}" is not a SET [LOCAL] ROLE or RESET ROLE rule`);
        }
        // SET [LOCAL] ROLE needs targets; RESET ROLE names no role, so an exemption for it alone takes none.
        const setRole = ruleIds.some((id) => SQL_SET_ROLE_RULES.has(id));
        const targets = exemption.targets === undefined && !setRole ? [] : stringList(exemption.targets, `${where}.targets`, errors, SQL_TARGET_PATTERN);
        if (setRole && targets.length === 0) errors.push(`${where}.targets must not be empty`);
        if (!setRole && exemption.targets !== undefined) errors.push(`${where}.targets is only allowed with a SET [LOCAL] ROLE rule`);
        // Exemption paths match case-sensitively: a looser match would loosen the gate further.
        const compiledPaths = compileGlobs(paths, `${where}.paths`, errors, { caseSensitive: true });
        // The whole comment-stripped top-level statement must be SET [LOCAL] ROLE <unquoted target> [;]
        // for the SET rules, or RESET ROLE [;] for auth_reset_role.
        const names = targets.filter((target) => SQL_TARGET_PATTERN.test(target)).join("|");
        const setStatement = new RegExp(`^set${SQL_SPACE}+(?:local${SQL_SPACE}+)?role${SQL_SPACE}+(?:${names})${SQL_SPACE}*;?$`, "i");
        const resetStatement = new RegExp(`^reset${SQL_SPACE}+role${SQL_SPACE}*;?$`, "i");
        const statements = Object.fromEntries(ruleIds.filter((id) => SQL_EXEMPTABLE_RULES.has(id)).map((id) => [id, SQL_SET_ROLE_RULES.has(id) ? setStatement : resetStatement]));
        return [{ id: exemption.id, reason: exemption.reason, paths: compiledPaths, rules: ruleIds, statements }];
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

// As in the Postgres scanner (scan.l ident_start/ident_cont, dolq_start/dolq_cont), every code point
// at or above U+0080 is an identifier and dollar-tag character: aé$$ and a—$$ are one identifier,
// $—$...$—$ is one dollar-quoted string. A word starts with [A-Za-z_] or a non-ASCII code point
// and continues with [A-Za-z0-9_$] or a non-ASCII code point; a tag takes the same without '$'.
const IDENT_START = "(?:[A-Za-z_]|[^\\x00-\\x7f])";
const IDENT_CONT = "(?:[A-Za-z0-9_$]|[^\\x00-\\x7f])";
const IDENTIFIER = new RegExp(`${IDENT_START}${IDENT_CONT}*`, "uy");
const IDENTIFIERS = new RegExp(`${IDENT_START}${IDENT_CONT}*`, "gu");
const DOLLAR_TAG = new RegExp(`\\$(?:${IDENT_START}(?:[A-Za-z0-9_]|[^\\x00-\\x7f])*)?\\$`, "uy");
const WORD_CHAR_BEFORE = /(?:[A-Za-z0-9_]|[^\x00-\x7f])$/u;
// Everything else the tokenizer classifies: SQL whitespace and printable ASCII. What is left is an
// unexpected ASCII control character (U+0000-U+0008, U+000E-U+001F, U+007F).
const SQL_PLAIN_CHAR = /[ \t\n\r\f\v\x21-\x7e]/;
// Postgres ends a -- comment at LF or CR (non_newline is [^\n\r]).
const LINE_END = /[\n\r]/g;
const MAX_SQL_DEPTH = 8;

/**
 * Tokenize SQL text into lower-case words, dropping line and (nested) block
 * comments. A double-quoted identifier becomes one lower-cased word, because
 * Postgres accepts quoted names (`SET "row_security"`, `"set_config"(…)`).
 * Every single-quoted, E'' and dollar-quoted string is tokenized recursively
 * as SQL, because a string can be code: a DO block
 * (`DO LANGUAGE plpgsql $$…$$`), an old-style function body (`AS '…'`) or
 * dynamic SQL (`EXECUTE '…'`, `EXECUTE $q$…$q$`). This fails closed: a string
 * literal that merely mentions CREATE POLICY also matches.
 * Below MAX_SQL_DEPTH nesting levels the body is split into plain words.
 *
 * Known limits: names spelled with escapes (`E'row\x5fsecurity'`,
 * `U&'row\005fsecurity'`, `U&"row\005fsecurity"`) or built at run time
 * (`'row_' || 'security'`, format(), EXECUTE of a variable) are not decoded,
 * and set_config with the setting name nested deeper than `(('role'))` or
 * passed as a variable does not match the role rules. auth_dynamic_role
 * catches EXECUTE and format() whose argument holds the word role, but not
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
 * a space and the text trimmed; `statement` is the index of the statement each
 * word sits in (a word inside a string gets the statement holding the string).
 * A -- comment ends at LF or CR. `unknown` is the first character (code point
 * and line), at any string depth, that is an unexpected ASCII control character
 * (not SQL whitespace, printable ASCII or a non-ASCII word character), or null.
 * @returns {{words: string[], lines: number[], starts: number[], ends: number[], statement: number[], statements: string[], unknown: {char: number, line: number}|null}}
 */
export function sqlTokens(text, depth = 0, firstLine = 1) {
  const sql = String(text);
  const words = [];
  const lines = [];
  const starts = [];
  const ends = [];
  const statement = [];
  const statements = [];
  // The first character no branch below classifies, with its line; classifySql then applies no exemption.
  let unknown = null;
  let current = "";
  const breaks = [];
  for (let at = sql.indexOf("\n"); at !== -1; at = sql.indexOf("\n", at + 1)) breaks.push(at);
  const lineAt = (offset) => {
    let low = 0;
    let high = breaks.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (breaks[mid] < offset) low = mid + 1;
      else high = mid;
    }
    return firstLine + low;
  };
  const push = (word, line) => (words.push(word), lines.push(line), starts.push(0), ends.push(0), statement.push(statements.length));
  const pushBody = (body, offset) => {
    const inner = sqlBodyTokens(body, depth, lineAt(offset));
    unknown ??= inner.unknown;
    if (inner.words.length === 0) return;
    inner.starts[0] += 1;
    inner.ends[inner.ends.length - 1] += 1;
    words.push(...inner.words);
    lines.push(...inner.lines);
    starts.push(...inner.starts);
    ends.push(...inner.ends);
    statement.push(...inner.words.map(() => statements.length));
  };
  let index = 0;
  // Where the last identifier ended and what it was, for the E'' prefix.
  let lastWordEnd = -1;
  let lastWord = "";
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    const from = index;
    IDENTIFIER.lastIndex = index;
    DOLLAR_TAG.lastIndex = index;
    if (char === "-" && next === "-") {
      LINE_END.lastIndex = index;
      const end = LINE_END.exec(sql);
      index = end === null ? sql.length : end.index + 1;
      current += " ";
    } else if (char === "/" && next === "*") {
      let level = 1;
      index += 2;
      while (index < sql.length && level > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") (level += 1), (index += 2);
        else if (sql[index] === "*" && sql[index + 1] === "/") (level -= 1), (index += 2);
        else index += 1;
      }
      current += " ";
    } else if (char === "'" || char === '"') {
      // E'' only when the word right before the quote is exactly e (not the tail of aée or xe).
      const backslash = char === "'" && lastWordEnd === index && lastWord === "e";
      if (backslash && words.at(-1) === "e") words.pop(), lines.pop(), starts.pop(), ends.pop(), statement.pop();
      const start = index;
      index += 1;
      let body = "";
      while (index < sql.length) {
        // A letter escape (\n, \t, \x41) separates words; other escapes are the character.
        if (backslash && sql[index] === "\\") (body += /[A-Za-z]/.test(sql[index + 1] ?? "") ? " " : sql.slice(index + 1, index + 2)), (index += 2);
        else if (sql[index] === char && sql[index + 1] === char) (body += char), (index += 2);
        else if (sql[index] === char) {
          index += 1;
          break;
        } else (body += sql[index]), (index += 1);
      }
      if (char === "'") pushBody(body, start);
      else if (body !== "") push(body.toLowerCase(), lineAt(start));
      current += sql.slice(from, index);
    } else if (char === "$" && !WORD_CHAR_BEFORE.test(sql.slice(Math.max(0, index - 2), index)) && DOLLAR_TAG.test(sql)) {
      DOLLAR_TAG.lastIndex = index;
      const tag = DOLLAR_TAG.exec(sql)[0];
      const bodyStart = index + tag.length;
      const close = sql.indexOf(tag, bodyStart);
      pushBody(sql.slice(bodyStart, close === -1 ? sql.length : close), bodyStart);
      index = close === -1 ? sql.length : close + tag.length;
      current += sql.slice(from, index);
    } else if (IDENTIFIER.test(sql)) {
      const word = sql.slice(index, IDENTIFIER.lastIndex);
      push(word.toLowerCase(), lineAt(index));
      index += word.length;
      current += word;
      (lastWordEnd = index), (lastWord = word.toLowerCase());
    } else {
      if (!SQL_PLAIN_CHAR.test(char)) unknown ??= { char: sql.codePointAt(index), line: lineAt(index) };
      if (!/[ \t\n\r\f\v]/.test(char)) push(char, lineAt(index));
      index += 1;
      current += char;
      if (char === ";") statements.push(current.trim()), (current = "");
    }
  }
  statements.push(current.trim());
  return { words, lines, starts, ends, statement, statements, unknown };
}

function sqlBodyTokens(body, depth, firstLine) {
  if (depth < MAX_SQL_DEPTH) return sqlTokens(body, depth + 1, firstLine);
  const words = [];
  const lines = [];
  for (const match of body.matchAll(IDENTIFIERS)) {
    words.push(match[0].toLowerCase());
    lines.push(firstLine + (body.slice(0, match.index).match(/\n/g)?.length ?? 0));
  }
  // Too deep to tokenize: an unexpected ASCII control character still counts as unknown.
  const odd = /[\x00-\x08\x0e-\x1f\x7f]/.exec(body);
  const unknown = odd ? { char: odd[0].codePointAt(0), line: firstLine + (body.slice(0, odd.index).match(/\n/g)?.length ?? 0) } : null;
  return { words, lines, starts: words.map(() => 0), ends: words.map(() => 0), unknown };
}

/**
 * Fallback for a file the tokenizer could not fully classify: every word and
 * punctuation character of the raw text, comments and string contents
 * included, with quote characters dropped so a quoted name is a plain word.
 * Everything sits at nesting level 0 and statements split at every ';'.
 */
function rawSqlTokens(text) {
  const sql = String(text);
  const words = [];
  const lines = [];
  const statement = [];
  let line = 1;
  let statementIndex = 0;
  let last = 0;
  for (const match of sql.matchAll(new RegExp(`${IDENT_START}${IDENT_CONT}*|[^ \\t\\n\\r\\f\\v'"$]`, "gu"))) {
    line += sql.slice(last, match.index).split("\n").length - 1;
    last = match.index;
    words.push(match[0].toLowerCase());
    lines.push(line);
    statement.push(statementIndex);
    if (match[0] === ";") statementIndex += 1;
  }
  return { words, lines, starts: words.map(() => 0), ends: words.map(() => 0), statement, statements: [] };
}

const sequenceAt = (words, start, tokens) => tokens.every((token, offset) => words[start + offset] === token);

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
 * Whether the match at `start` lies in the argument of one of the `inside`
 * sequences in the same top-level statement. A sequence ending in '(' is a
 * call whose argument runs to its matching ')' (format(…)); any other
 * sequence takes everything after it up to the end of its own statement
 * (EXECUTE …). Parentheses and ';' count only at the sequence's string
 * nesting level, so those inside literals do not close the argument, and the
 * match may sit deeper (in a literal or dollar-quoted body) but not shallower.
 */
function insideArgument({ words, statement, ends }, levels, start, inside) {
  for (let at = start - 1; at >= 0 && statement[at] === statement[start]; at -= 1) {
    for (const tokens of inside) {
      const last = at + tokens.length - 1;
      if (last >= start || !sequenceAt(words, at, tokens) || levels[at] > levels[start]) continue;
      const level = levels[at];
      const call = tokens.at(-1) === "(";
      let depth = 0;
      let open = true;
      // The scan starts at the sequence's last word, so a call's own '(' opens depth 1.
      for (let cursor = last; cursor < start && open; cursor += 1) {
        if (boundary(words, levels, cursor, level)) open = false;
        else if (call && levels[cursor] === level && words[cursor] === "(") depth += 1;
        else if (call && levels[cursor] === level && words[cursor] === ")") open = --depth > 0;
        // A sequence inside a string ends with that string ('EXECUTE' does not reach the next literal).
        if (levels[cursor] - ends[cursor] < level) open = false;
      }
      if (open) return true;
    }
  }
  return false;
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
 * gate_loosening; the rule adds its class only for a hit that is not exempt.
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
  const parsed = sqlTokens(text);
  // A character the tokenizer cannot classify may mean it is out of step with Postgres, so the file gets
  // no exemption at all: the rules also run over the raw text with comments and quotes read as code
  // (rawSqlTokens), whose structure is coarser, and every hit of either reading is reported.
  const { unknown } = parsed;
  const readings = (unknown ? [parsed, rawSqlTokens(text)] : [parsed]).map((tokens) => ({ tokens, levels: nestingLevels(tokens) }));
  // A '.', '..' or empty segment could walk an exempt prefix out of its directory, so such a path is never exempt.
  const plainPath = path !== null && String(path).split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  const exemptions = plainPath && !unknown ? config.sqlContent.exemptions.filter((entry) => entry.paths.some((re) => re.test(path))) : [];
  const classes = [];
  const reasons = [];
  const hits = [];
  if (unknown) {
    const code = `U+${unknown.char.toString(16).toUpperCase().padStart(4, "0")}`;
    reasons.push(`sql:tokenizer_unknown_char: ${code} on line ${unknown.line} is not a character the SQL tokenizer classifies, so no comment, string or statement exemption applies to this file and it fails closed`);
    // Fail closed: the tokenizer may be out of step with Postgres, so any SQL class could be hidden.
    for (const rule of config.sqlContent.rules) if (!rule.informational && !classes.includes(rule.class)) classes.push(rule.class);
  }
  for (const rule of config.sqlContent.rules) {
    // Per reading, this rule's hits; with two readings, keep per line the larger count.
    const ruleHits = readings.map(({ tokens, levels }) => {
      const { words, lines, statement, statements } = tokens;
      const found = [];
      for (let start = 0; start < words.length; start += 1) {
        if (!sequenceAt(words, start, rule.tokens)) continue;
        const end = start + rule.tokens.length;
        if (rule.within && !withinStatement(words, levels, start, rule.within)) continue;
        if (rule.after && !withinStatement(words, levels, start, rule.after)) continue;
        if (rule.inside && !insideArgument(tokens, levels, start, rule.inside)) continue;
        if (rule.until && !followedBy(words, levels, start, end, rule.until)) continue;
        const hit = { id: rule.id, class: rule.class, path, line: lines[start], sensitive: !rule.informational };
        if (rule.informational) hit.informational = true;
        else {
          const exemption = exemptions.find((entry) => entry.statements[rule.id]?.test(statements[statement[start]]) && levels[start] === 0);
          if (exemption) Object.assign(hit, { sensitive: false, exemption: exemption.id, gate_loosening: true });
        }
        found.push(hit);
      }
      return found;
    });
    const merged = ruleHits[0];
    for (const extra of ruleHits.slice(1)) {
      const count = (list, line) => list.filter((hit) => hit.line === line).length;
      for (const line of new Set(extra.map((hit) => hit.line))) {
        const missing = count(extra, line) - count(merged, line);
        merged.push(...extra.filter((hit) => hit.line === line).slice(0, Math.max(0, missing)));
      }
    }
    hits.push(...merged);
    const sensitive = merged.some((hit) => hit.sensitive);
    if (!sensitive) continue;
    if (!classes.includes(rule.class)) classes.push(rule.class);
    reasons.push(`${rule.class}:sql:${rule.id}: ${rule.reason}`);
  }
  hits.sort((a, b) => a.line - b.line);
  return { classes, reasons, hits };
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
  const results = [];
  for (const [index, file] of list.entries()) {
    const problem = fileProblem(file);
    if (problem) {
      allErrors.push(`changed file ${index + 1}: ${problem}`);
      continue;
    }
    const paths = [file.filename];
    if (file.previous_filename && file.previous_filename !== file.filename) paths.push(file.previous_filename);
    const classes = [];
    const reasons = [];
    let category = null;
    const categories = [];
    let sqlHits = null;
    for (const path of paths) {
      const result = classifyPath(path, config);
      const label = path === file.filename ? "" : "previous:";
      for (const name of result.classes) if (!classes.includes(name)) classes.push(name);
      reasons.push(...result.reasons.map((reason) => label + reason));
      categories.push(result.category);
    }
    if (readsHead(file.status) && config.sqlContent.paths.some((re) => re.test(file.filename))) {
      try {
        if (!readHeadFile) throw new Error("no head reader");
        const sql = classifySql(await readHeadFile(file.filename), config, file.filename);
        for (const name of sql.classes) if (!classes.includes(name)) classes.push(name);
        reasons.push(...sql.reasons);
        sqlHits = sql.hits;
      } catch (error) {
        allErrors.push(`could not read ${file.filename} at head: ${messageOf(error)}`);
      }
    }
    // A rename keeps its safe category only when both names share it.
    if (!classes.length && categories.every((name) => name && name === categories[0])) category = categories[0];
    // Fail closed: only a safe category makes a file with no class non-sensitive.
    if (!classes.length && !category) {
      classes.push(UNCLASSIFIED);
      reasons.push(`${UNCLASSIFIED}:no-safe-category`);
    }
    classes.sort((a, b) => OUTPUT_CLASSES.indexOf(a) - OUTPUT_CLASSES.indexOf(b));
    const entry = { path: file.filename, status: file.status, classes, category, reasons };
    if (paths.length > 1) entry.previous_path = file.previous_filename;
    if (sqlHits) entry.sql_hits = sqlHits;
    results.push(entry);
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
    // SQL hits an exemption cleared; each one is a place the gate is looser than the plain rule.
    sql_exemptions: results.flatMap((file) => (file.sql_hits ?? []).filter((hit) => hit.gate_loosening)),
    errors: allErrors,
  };
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
  // Keep the base rule identity above; structural restrictions and informational
  // status also affect matching, so conservatively flag any edit to them.
  const constraints = (rule) => JSON.stringify([rule?.within, rule?.after, rule?.inside, rule?.until, rule?.informational]);
  for (const rule of listOf(baseSql, "rules")) {
    const kept = listOf(headSql, "rules").find((candidate) => sqlRuleKey(candidate) === sqlRuleKey(rule));
    if (kept && constraints(kept) !== constraints(rule)) reasons.push({ kind: "sql_rule_changed", path: at, entry: "sql_content", value: rule.id, message: `${at} changes SQL rule constraints for ${rule.id}.` });
  }
  // Added or edited SQL exemptions can clear hits that were sensitive on base.
  const exemptions = new Set(listOf(baseSql, "exemptions").map((entry) => JSON.stringify(entry)));
  for (const exemption of listOf(headSql, "exemptions")) {
    if (!exemptions.has(JSON.stringify(exemption))) reasons.push({ kind: "exemption_added", path: at, entry: "sql_content.exemptions", value: exemption.id, message: `${at} adds or edits SQL exemption ${exemption.id}.` });
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
  const loosening = result.sql_exemptions ?? [];
  if (loosening.length) {
    const ids = [...new Set(loosening.map((hit) => hit.exemption))].join(", ");
    lines.push(`Gate loosening: ${loosening.length} SQL hit(s) exempted by ${ids}`, "");
  }
  const hits = result.files.flatMap((file) => file.sql_hits ?? []);
  if (hits.length) {
    lines.push("| SQL rule | Location | Class | Effect |", "| --- | --- | --- | --- |");
    for (const hit of hits) {
      const where = safeInline(`${hit.path}:${hit.line}`).replaceAll("|", "\\|");
      const effect = hit.gate_loosening ? `exempt (gate_loosening: ${hit.exemption})` : hit.informational ? "informational" : "sensitive";
      lines.push(`| ${hit.id} | ${where} | ${hit.class} | ${effect} |`);
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
