import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { safeInline } from "./proof-check.mjs";

/**
 * Sensitive-class detector (OVD-844, report mode). Classifies every file a PR
 * changes into the sensitive classes and auto-merge safe categories of
 * scripts/sensitive-classes.json, the shared encoding of the AGENTS.md
 * sensitive paths table.
 *
 * The CLI runs from the base checkout. It reads the changed files and their
 * status from the GitHub API and reads changed .sql files at the PR head as
 * data only; nothing from the PR is executed. Sensitive classes win over safe
 * categories, a file matching neither is "unclassified", and any config, API
 * or truncation problem sets status "error" so a consumer fails closed.
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
 * .github/workflows/sensitive-class.yml and its head sha is the PR head.
 */

export const CONFIG_PATH = fileURLToPath(new URL("./sensitive-classes.json", import.meta.url));
export const CONFIG_VERSION = 1;
export const MAX_FILES = 3000;
const PER_PAGE = 100;

const TOP_KEYS = new Set(["version", "description", "syntax", "sql_content", "classes", "safe_categories"]);
const CLASS_KEYS = new Set(["description", "areas", "signals", "paths", "path_keywords", "exclude", "exclude_keywords"]);
const CATEGORY_KEYS = new Set(["description", "paths", "path_keywords", "exclude", "exclude_keywords"]);
const SQL_KEYS = new Set(["paths", "rules", "exemptions"]);
const SQL_RULE_KEYS = new Set(["id", "class", "tokens", "reason", "within", "after", "inside", "until", "informational"]);
const SQL_EXEMPTION_KEYS = new Set(["id", "reason", "paths", "rules", "targets", "gate_loosening"]);
// A whole lower-cased word as sqlWords emits it, or one punctuation character.
const SQL_TOKEN_PATTERN = /^(?:[a-z_][a-z0-9_$]*|[^\sA-Za-z0-9_$])$/;
// An exemption target is an unquoted lower-case role name, safe to splice into a RegExp.
const SQL_TARGET_PATTERN = /^[a-z_][a-z0-9_]*$/;
// The only rules an exemption can clear: its statement shape is SET [LOCAL] ROLE <target>.
const SQL_EXEMPTABLE_RULES = new Set(["auth_set_role", "auth_set_local_role"]);
// Postgres SQL whitespace; a comment counts as one space.
const SQL_SPACE = "[ \\t\\n\\r\\f]";
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const KEYWORD_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------- globs

function expandBraces(pattern) {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  let depth = 0;
  for (let index = open; index < pattern.length; index += 1) {
    if (pattern[index] === "{") depth += 1;
    else if (pattern[index] === "}" && --depth === 0) {
      const parts = [];
      let start = open + 1;
      let level = 0;
      for (let cursor = open + 1; cursor < index; cursor += 1) {
        if (pattern[cursor] === "{") level += 1;
        else if (pattern[cursor] === "}") level -= 1;
        else if (pattern[cursor] === "," && level === 0) {
          parts.push(pattern.slice(start, cursor));
          start = cursor + 1;
        }
      }
      parts.push(pattern.slice(start, index));
      const prefix = pattern.slice(0, open);
      const rest = expandBraces(pattern.slice(index + 1));
      return parts.flatMap((part) => expandBraces(prefix + part).flatMap((head) => rest.map((tail) => head + tail)));
    }
  }
  throw new Error(`unbalanced brace in glob "${pattern}"`);
}

function segmentSource(segment) {
  let source = "";
  for (const char of segment) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return source;
}

/** Compile one glob of the config syntax into a RegExp, case-insensitive unless `caseSensitive`. */
export function globToRegExp(glob, { caseSensitive = false } = {}) {
  if (typeof glob !== "string" || glob === "" || glob.startsWith("/")) throw new Error(`invalid glob ${JSON.stringify(glob)}`);
  const alternatives = expandBraces(glob).map((pattern) => {
    const segments = pattern.split("/");
    let source = "";
    segments.forEach((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") source += last ? ".*" : "(?:[^/]+/)*";
      else source += segmentSource(segment) + (last ? "" : "/");
    });
    return source;
  });
  return new RegExp(`^(?:${alternatives.join("|")})$`, caseSensitive ? "" : "i");
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

function compileGlobs(list, where, errors, options) {
  return list.flatMap((glob) => {
    try {
      return [globToRegExp(glob, options)];
    } catch (error) {
      errors.push(`${where}: ${error.message}`);
      return [];
    }
  });
}

function compileEntry(name, entry, kind, allowedKeys, errors) {
  const where = `${kind}.${name}`;
  if (!NAME_PATTERN.test(name)) errors.push(`${where}: invalid name`);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  for (const key of Object.keys(entry)) if (!allowedKeys.has(key)) errors.push(`${where}: unknown rule key "${key}"`);
  const paths = stringList(entry.paths, `${where}.paths`, errors);
  const keywords = stringList(entry.path_keywords, `${where}.path_keywords`, errors, KEYWORD_PATTERN);
  return {
    name,
    paths: compileGlobs(paths, `${where}.paths`, errors),
    pathGlobs: paths,
    keywords,
    exclude: compileGlobs(stringList(entry.exclude, `${where}.exclude`, errors), `${where}.exclude`, errors),
    excludeKeywords: stringList(entry.exclude_keywords, `${where}.exclude_keywords`, errors, KEYWORD_PATTERN),
    areas: stringList(entry.areas, `${where}.areas`, errors),
    signals: stringList(entry.signals, `${where}.signals`, errors),
  };
}

/**
 * Validate and compile the parsed config. Unknown keys, bad globs and rules
 * that name an unknown class are errors, never silently ignored.
 * @returns {{config: object|null, errors: string[]}}
 */
export function compileConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config: null, errors: ["config must be a JSON object"] };
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) errors.push(`config: unknown key "${key}"`);
  if (raw.version !== CONFIG_VERSION) errors.push(`config: version must be ${CONFIG_VERSION}`);
  const section = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
      errors.push(`config: ${label} must be a non-empty object`);
      return [];
    }
    return Object.entries(value);
  };
  const classes = section(raw.classes, "classes").map(([name, entry]) => compileEntry(name, entry, "classes", CLASS_KEYS, errors)).filter(Boolean);
  const categories = section(raw.safe_categories, "safe_categories")
    .map(([name, entry]) => compileEntry(name, entry, "safe_categories", CATEGORY_KEYS, errors))
    .filter(Boolean);
  for (const category of categories) {
    if (classes.some((entry) => entry.name === category.name)) errors.push(`safe_categories.${category.name}: name collides with a class`);
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
      if (!classes.some((entry) => entry.name === rule.class)) errors.push(`${where}: unknown class "${rule.class}"`);
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
          else if (!SQL_EXEMPTABLE_RULES.has(id)) errors.push(`${where}: rule "${id}" is not a SET [LOCAL] ROLE rule`);
        }
        const targets = stringList(exemption.targets, `${where}.targets`, errors, SQL_TARGET_PATTERN);
        if (targets.length === 0) errors.push(`${where}.targets must not be empty`);
        // Exemption paths match case-sensitively: a looser match would loosen the gate further.
        const compiledPaths = compileGlobs(paths, `${where}.paths`, errors, { caseSensitive: true });
        // The whole comment-stripped top-level statement must be SET [LOCAL] ROLE <unquoted target> [;].
        const names = targets.filter((target) => SQL_TARGET_PATTERN.test(target)).join("|");
        const statement = new RegExp(`^set${SQL_SPACE}+(?:local${SQL_SPACE}+)?role${SQL_SPACE}+(?:${names})${SQL_SPACE}*;?$`, "i");
        return [{ id: exemption.id, reason: exemption.reason, paths: compiledPaths, rules: ruleIds, statement }];
      }),
    };
  }
  return errors.length ? { config: null, errors } : { config: { classes, categories, sqlContent }, errors: [] };
}

/** Read, parse and compile a config file; parse failures become errors. */
export function loadConfig(file = CONFIG_PATH) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { config: null, errors: [`config could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return compileConfig(raw);
}

// ---------------------------------------------------------------- paths

function entryReason(entry, path, words) {
  if (entry.exclude.some((re) => re.test(path))) return null;
  if (entry.excludeKeywords.some((keyword) => keywordMatches(words, keyword, true))) return null;
  const glob = entry.paths.findIndex((re) => re.test(path));
  if (glob !== -1) return `path:${entry.pathGlobs[glob]}`;
  const keyword = entry.keywords.find((candidate) => keywordMatches(words, candidate));
  return keyword ? `path_keyword:${keyword}` : null;
}

/**
 * Classify one path. Every matching class is returned; the first matching
 * safe category applies only when no class matched.
 * @returns {{classes: string[], category: string|null, reasons: string[]}}
 */
export function classifyPath(path, config) {
  const words = pathWords(path);
  const classes = [];
  const reasons = [];
  for (const entry of config.classes) {
    const reason = entryReason(entry, path, words);
    if (reason) {
      classes.push(entry.name);
      reasons.push(`${entry.name}:${reason}`);
    }
  }
  if (classes.length) return { classes, category: null, reasons };
  for (const entry of config.categories) {
    const reason = entryReason(entry, path, words);
    if (reason) return { classes, category: entry.name, reasons: [`${entry.name}:${reason}`] };
  }
  return { classes, category: null, reasons: [] };
}

// ---------------------------------------------------------------- SQL

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
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
 * @returns {{words: string[], lines: number[], starts: number[], ends: number[], statement: number[], statements: string[]}}
 */
export function sqlTokens(text, depth = 0, firstLine = 1) {
  const sql = String(text);
  const words = [];
  const lines = [];
  const starts = [];
  const ends = [];
  const statement = [];
  const statements = [];
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
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    const from = index;
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
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
      const backslash = char === "'" && /e/i.test(sql[index - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[index - 2] ?? "");
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
    } else if (char === "$" && !/[A-Za-z0-9_]/.test(sql[index - 1] ?? "") && DOLLAR_TAG.test(sql.slice(index, index + 64))) {
      const tag = DOLLAR_TAG.exec(sql.slice(index, index + 64))[0];
      const bodyStart = index + tag.length;
      const close = sql.indexOf(tag, bodyStart);
      pushBody(sql.slice(bodyStart, close === -1 ? sql.length : close), bodyStart);
      index = close === -1 ? sql.length : close + tag.length;
      current += sql.slice(from, index);
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index, index + 256));
      push(match[0].toLowerCase(), lineAt(index));
      index += match[0].length;
      current += match[0];
    } else {
      if (!/\s/.test(char)) push(char, lineAt(index));
      index += 1;
      current += char;
      if (char === ";") statements.push(current.trim()), (current = "");
    }
  }
  statements.push(current.trim());
  return { words, lines, starts, ends, statement, statements };
}

function sqlBodyTokens(body, depth, firstLine) {
  if (depth < MAX_SQL_DEPTH) return sqlTokens(body, depth + 1, firstLine);
  const words = [];
  const lines = [];
  for (const match of body.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
    words.push(match[0].toLowerCase());
    lines.push(firstLine + (body.slice(0, match.index).match(/\n/g)?.length ?? 0));
  }
  return { words, lines, starts: words.map(() => 0), ends: words.map(() => 0) };
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
 * @returns {{classes: string[], reasons: string[], hits: object[]}}
 */
export function classifySql(text, config, path = null) {
  const tokens = sqlTokens(text);
  const { words, lines, statement, statements } = tokens;
  const levels = nestingLevels(tokens);
  // A '.', '..' or empty segment could walk an exempt prefix out of its directory, so such a path is never exempt.
  const plainPath = path !== null && String(path).split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  const exemptions = plainPath ? config.sqlContent.exemptions.filter((entry) => entry.paths.some((re) => re.test(path))) : [];
  const classes = [];
  const reasons = [];
  const hits = [];
  for (const rule of config.sqlContent.rules) {
    let sensitive = false;
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
        const exemption = exemptions.find((entry) => entry.rules.includes(rule.id) && levels[start] === 0 && entry.statement.test(statements[statement[start]]));
        if (exemption) Object.assign(hit, { sensitive: false, exemption: exemption.id, gate_loosening: true });
      }
      sensitive ||= hit.sensitive;
      hits.push(hit);
    }
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

/**
 * Classify a list of changed files.
 * @param {object} input
 * @param {{filename: string, status: string, previous_filename?: string}[]} input.files
 * @param {(path: string) => Promise<string>} [input.readHeadFile] head content of a .sql file
 * @param {object} input.config compiled config
 */
export async function detect({ files, readHeadFile, config, sha = null, baseSha = null, errors = [] }) {
  const allErrors = [...errors];
  const order = config.classes.map((entry) => entry.name);
  const results = [];
  for (const file of files) {
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
        allErrors.push(`could not read ${file.filename} at head: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // A rename keeps its safe category only when both names share it.
    if (!classes.length && categories.every((name) => name && name === categories[0])) category = categories[0];
    classes.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const entry = { path: file.filename, status: file.status, classes, category, reasons };
    if (paths.length > 1) entry.previous_path = file.previous_filename;
    if (sqlHits) entry.sql_hits = sqlHits;
    results.push(entry);
  }

  const classes = order.filter((name) => results.some((file) => file.classes.includes(name)));
  return {
    version: CONFIG_VERSION,
    sha,
    base_sha: baseSha,
    status: allErrors.length ? "error" : "ok",
    classes,
    sensitive_count: results.filter((file) => file.classes.length).length,
    multi_class: classes.length > 1,
    files: results,
    unclassified: results.filter((file) => !file.classes.length && !file.category).map((file) => file.path),
    // SQL hits an exemption cleared; each one is a place the gate is looser than the plain rule.
    gate_loosening: results.flatMap((file) => (file.sql_hits ?? []).filter((hit) => hit.gate_loosening)),
    errors: allErrors,
  };
}

/** The result for a run that could not classify anything. */
export function errorResult(errors, { sha = null, baseSha = null } = {}) {
  return { version: CONFIG_VERSION, sha, base_sha: baseSha, status: "error", classes: [], sensitive_count: 0, multi_class: false, files: [], unclassified: [], gate_loosening: [], errors };
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
 * disagrees with the PR, or a head that moved) is an error.
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
  return { sha, baseSha, files, readHeadFile, errors };
}

// ---------------------------------------------------------------- CLI

export function formatSummary(result) {
  const label = result.status === "ok" ? "OK" : "ERROR";
  const lines = [`### Sensitive classes: ${label}`, "", "Mode: `report` (this check never fails the PR)", ""];
  lines.push(`Head: ${safeInline(result.sha ?? "unknown")} · base: ${safeInline(result.base_sha ?? "unknown")}`, "");
  lines.push(`Classes: ${result.classes.length ? result.classes.map(safeInline).join(", ") : "none"}`);
  lines.push(`Sensitive files: ${result.sensitive_count} of ${result.files.length}${result.multi_class ? " (multi-class)" : ""}`);
  lines.push(`Unclassified: ${result.unclassified.length ? result.unclassified.map(safeInline).join(", ") : "none"}`, "");
  for (const error of result.errors) lines.push(`- error: ${safeInline(error)}`);
  if (result.errors.length) lines.push("");
  if (result.files.length) {
    lines.push("| File | Status | Classes | Category |", "| --- | --- | --- | --- |");
    for (const file of result.files) {
      const name = safeInline(file.path).replaceAll("|", "\\|");
      lines.push(`| ${name} | ${file.status ?? ""} | ${file.classes.join(", ") || "-"} | ${file.category ?? (file.classes.length ? "-" : "**unclassified**")} |`);
    }
    lines.push("");
  }
  const loosening = result.gate_loosening ?? [];
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
  + "Reads GITHUB_TOKEN or GH_TOKEN. Report mode: exits 0 whenever it writes a result, including status error.";

/**
 * @returns {Promise<number>} 0 when a result was written, 2 on bad arguments
 */
export async function main(argv = process.argv.slice(2), env = process.env, { fetchImpl, stdout = process.stdout } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(usage);
    return 2;
  }

  const { config, errors: configErrors } = loadConfig(options.config ?? CONFIG_PATH);
  let result;
  if (!config) {
    result = errorResult(configErrors, { sha: options["head-sha"] ?? null });
  } else {
    try {
      const client = githubClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl: env.GITHUB_API_URL, fetchImpl });
      const pull = await fetchPullRequest(client, options.repo, options.pr, { expectedHeadSha: options["head-sha"] });
      result = await detect({ ...pull, config });
    } catch (error) {
      result = errorResult([`GitHub API error: ${error instanceof Error ? error.message : String(error)}`], { sha: options["head-sha"] ?? null });
    }
  }

  if (options.json) writeFileSync(options.json, `${JSON.stringify(result, null, 2)}\n`);
  const summary = formatSummary(result);
  stdout.write(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
