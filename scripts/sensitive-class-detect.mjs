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
const SQL_KEYS = new Set(["paths", "rules"]);
const SQL_RULE_KEYS = new Set(["class", "tokens"]);
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

/** Compile one glob of the config syntax into a case-insensitive RegExp. */
export function globToRegExp(glob) {
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
  return new RegExp(`^(?:${alternatives.join("|")})$`, "i");
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

function compileGlobs(list, where, errors) {
  return list.flatMap((glob) => {
    try {
      return [globToRegExp(glob)];
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
        if (!classes.some((entry) => entry.name === rule.class)) errors.push(`${where}: unknown class "${rule.class}"`);
        const tokens = stringList(rule.tokens, `${where}.tokens`, errors, /^[a-z_]+$/);
        if (tokens.length === 0) errors.push(`${where}.tokens must not be empty`);
        return [{ class: rule.class, tokens }];
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
export function sqlWords(text, depth = 0, budget = { left: MAX_SQL_TOKENS }) {
  const sql = String(text);
  const words = [];
  const add = (word) => {
    if ((budget.left -= 1) < 0) throw new SqlTooLargeError(`more than ${MAX_SQL_TOKENS} tokens`);
    words.push(word);
  };
  const addAll = (list) => {
    for (const word of list) add(word);
  };
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
    } else if (char === "/" && next === "*") {
      let level = 1;
      index += 2;
      while (index < sql.length && level > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") (level += 1), (index += 2);
        else if (sql[index] === "*" && sql[index + 1] === "/") (level -= 1), (index += 2);
        else index += 1;
      }
    } else if (char === "'" || char === '"') {
      const backslash = char === "'" && /e/i.test(sql[index - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[index - 2] ?? "");
      if (backslash && words.at(-1) === "e") (words.pop(), (budget.left += 1));
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
      if (char === "'") addAll(sqlBodyWords(body, depth, budget));
    } else if (char === "$" && !/[A-Za-z0-9_]/.test(sql[index - 1] ?? "") && DOLLAR_TAG.test(sql.slice(index, index + 64))) {
      const tag = DOLLAR_TAG.exec(sql.slice(index, index + 64))[0];
      const bodyStart = index + tag.length;
      const close = sql.indexOf(tag, bodyStart);
      addAll(sqlBodyWords(sql.slice(bodyStart, close === -1 ? sql.length : close), depth, budget));
      index = close === -1 ? sql.length : close + tag.length;
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index, index + 256));
      add(match[0].toLowerCase());
      index += match[0].length;
    } else {
      if (!/\s/.test(char)) add(char);
      index += 1;
    }
  }
  return words;
}

function sqlBodyWords(body, depth, budget) {
  if (depth < MAX_SQL_DEPTH) return sqlWords(body, depth + 1, budget);
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
  const notices = [];
  for (const file of files) {
    const paths = [file.filename];
    if (file.previous_filename && file.previous_filename !== file.filename) paths.push(file.previous_filename);
    const classes = [];
    const reasons = [];
    let category = null;
    const categories = [];
    for (const path of paths) {
      const result = classifyPath(path, config);
      const label = path === file.filename ? "" : "previous:";
      for (const name of result.classes) if (!classes.includes(name)) classes.push(name);
      reasons.push(...result.reasons.map((reason) => label + reason));
      categories.push(result.category);
    }
    if (readsHead(file.status) &&config.sqlContent.paths.some((re) => re.test(file.filename))) {
      try {
        if (!readHeadFile) throw new Error("no head reader");
        const body = await readHeadFile(file.filename);
        let sql;
        try {
          sql = classifySql(body, config);
        } catch (error) {
          if (!(error instanceof SqlTooLargeError)) throw error;
        }
        if (!sql) {
          // Too large to scan: treat as every class the SQL scan could have found.
          const message = `SQL body ${file.filename} rejected for size: exceeds the limit of ${MAX_SQL_TOKENS} tokens; manual review is required`;
          for (const rule of config.sqlContent.rules) if (!classes.includes(rule.class)) classes.push(rule.class);
          reasons.push(`sql:oversized:>${MAX_SQL_TOKENS}`);
          notices.push(message);
        } else {
          for (const name of sql.classes) if (!classes.includes(name)) classes.push(name);
          for (const reason of sql.reasons) reasons.push(reason);
        }
      } catch (error) {
        allErrors.push(`could not read ${file.filename} at head: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // A rename keeps its safe category only when both names share it.
    if (!classes.length && categories.every((name) => name && name === categories[0])) category = categories[0];
    classes.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const entry = { path: file.filename, status: file.status, classes, category, reasons };
    if (paths.length > 1) entry.previous_path = file.previous_filename;
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
    errors: allErrors,
    ...(notices.length ? { manual_review: notices } : {}),
  };
}

/** The result for a run that could not classify anything. */
export function errorResult(errors, { sha = null, baseSha = null } = {}) {
  return { version: CONFIG_VERSION, sha, base_sha: baseSha, status: "error", classes: [], sensitive_count: 0, multi_class: false, files: [], unclassified: [], errors };
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
  for (const notice of result.manual_review ?? []) lines.push(`- manual review: ${safeInline(notice)}`);
  if (result.manual_review?.length) lines.push("");
  if (result.files.length) {
    lines.push("| File | Status | Classes | Category |", "| --- | --- | --- | --- |");
    for (const file of result.files) {
      const name = safeInline(file.path).replaceAll("|", "\\|");
      lines.push(`| ${name} | ${file.status ?? ""} | ${file.classes.join(", ") || "-"} | ${file.category ?? (file.classes.length ? "-" : "**unclassified**")} |`);
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
