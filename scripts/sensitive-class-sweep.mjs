#!/usr/bin/env node
/**
 * OVD-844 coverage sweep (test helper and CLI): no path that the 0163daf7
 * detector called sensitive may come out non-sensitive here, except in the
 * residual classes below.
 *
 * At 0163daf7 the detector had its own path rules: globs, and path keywords
 * matched against path words (a path splits into words on every character
 * other than an ASCII letter or digit and at camelCase boundaries; a keyword
 * matches a word it starts, and provider-admission matches the word
 * "provider" followed by a word starting "admission"). Its path classes now
 * come from the shared list (docs/sensitive-paths.json), which has globs only.
 * V1_CLASSES, V1_SAFE_CATEGORIES and the v1 matcher below are a frozen copy of
 * those rules (scripts/sensitive-classes.json and the matcher of
 * scripts/sensitive-class-detect.mjs at 0163daf7), so the sweep needs no git
 * history.
 *
 * sweepNames() generates, in DIRECTORIES:
 * - for every v1 path keyword: the keyword in lower case, capitalised (a
 *   camelCase boundary after a letter or digit), upper case and with each
 *   letter replaced by a non-ASCII character whose lower case is that letter;
 *   with every printable ASCII character other than a letter or digit (and
 *   EXTRA_CHARACTERS) immediately before it, immediately after it, on both
 *   sides, and next to the path separator in front of it (ending the parent
 *   directory, and as a one-character parent directory);
 * - for the two-word keywords, also every such character on either side of the
 *   separator between the words (any pair), within one name, and as a
 *   one-character directory between the words;
 * - for every v1 class glob: each brace expansion with every wildcard filled
 *   in turn by every such character, alone and before or after a letter.
 *
 * runSweep() classifies each name with the v1 rules and with this checkout's
 * classifyPath (the shared list through scripts/lib/sensitive-paths.mjs). A
 * name sensitive at v1 and not sensitive here is lost. A lost name is
 * accepted only in a residual class: rls (a v1 keyword) right after a
 * character a glob cannot spell (anything but an ASCII letter or digit,
 * ".", "_", "-", "," or "/"), or at a camelCase boundary. A glob covering
 * such a class needs a wildcard where that character is, and the same glob
 * matches src/lib/urls.ts, which the shared fixture pins as not sensitive;
 * each class carries a witness name that checks this. Any other lost name is
 * unexplained, and the sweep's test fails on it.
 *
 * Usage: node scripts/sensitive-class-sweep.mjs [--json <file>]
 * prints the counts and residual classes (as used in the PR body).
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, classifyPath, loadConfig } from "./sensitive-class-detect.mjs";

export const V1_COMMIT = "0163daf7";
export const FIXTURE_PATH = "scripts/fixtures/sensitive-paths/paths.json";
/** The fixture row that bounds the residual classes. */
export const PINNED_SAFE_NAME = "src/lib/urls.ts";

// Frozen copy of the path rules in scripts/sensitive-classes.json at 0163daf7
// ("paths" and "path_keywords"; no class there had "exclude" or "exclude_keywords").
export const V1_CLASSES = Object.freeze({
  migration: { paths: ["supabase/migrations/**", "docs/migration-drafts/**", "docs/release/**/*.sql"] },
  rls: { path_keywords: ["rls"] },
  definer: {}, // SQL content only
  auth: { path_keywords: ["auth", "oauth", "permission", "session"] },
  billing: { path_keywords: ["payment", "billing", "stripe", "pricing", "invoice", "checkout"] },
  provider: { paths: ["worker/src/adapters/**"], path_keywords: ["dispatch", "provider-admission", "provider-upload"] },
  secrets: {
    paths: ["**/*.pem", "**/*.key", "**/keys/**", "**/token{,s}.{json,yaml,yml,ts,js}", "**/.env*", "**/.env*/**", "**/env.{ts,js,json}", "**/.envrc"],
    path_keywords: ["secret", "credential", "vault"],
  },
  ci: {
    paths: [
      ".github/workflows/**",
      ".github/actions/**",
      "scripts/sensitive-class*",
      "scripts/proof-check*",
      "scripts/preflight.sh",
      "scripts/symphony-preflight.sh",
      "scripts/validate-pr-body*",
      "scripts/check-sourcing-worker-scope.mjs",
      "scripts/provider-enablement-detect.mjs",
      "scripts/run-supabase-policy-tests*",
      "scripts/migration-timestamp.mjs",
      "scripts/free-quote-*",
      "scripts/fixtures/free-quote-*",
      "scripts/qualification/free-quote-*",
      "scripts/generate-free-quote-fixtures*",
      "scripts/native/**",
      "scripts/native-{companion-inert-ci,first-loop-vitest,result-reader,storage-qualification}*",
      "scripts/{verify-,}ovd420-*",
      "scripts/ovd{462,510,518,520,561,570,576,577,591}-*",
      "scripts/quote-selection-expiry-rehearsal.mjs",
      "scripts/selection-publication-rehearsal.mjs",
      "scripts/window-1/ovd602-*",
      "scripts/lint-security-definer.mjs",
      "scripts/security-definer-baseline.json",
      "scripts/ephemeral-db-apply.mjs",
      "scripts/supabase-target-guard.mjs",
      "scripts/check-rls-deny-coverage.mjs",
      "scripts/rls-deny-baseline.json",
    ],
  },
  infra: {
    paths: [
      "**/infra/**", "**/terraform/**", "**/deploy/**", "**/k8s/**", "**/helm/**", "**/ops/**", "**/*.tf", "**/*.tfvars", "**/Dockerfile", "**/Dockerfile.*",
      "**/*.Dockerfile", "**/docker-compose*", "**/vercel.json", "**/netlify.toml", "**/fly.toml", "scripts/deploy*", "scripts/deploy*/**", "scripts/release*",
      "scripts/release*/**",
    ],
  },
  deps: {
    paths: [
      "**/package.json", "**/package-lock.json", "**/npm-shrinkwrap.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/bun.lock", "**/bun.lockb", "**/requirements*.txt",
      "**/pyproject.toml", "**/poetry.lock", "**/uv.lock", "**/Pipfile", "**/Pipfile.lock", "**/Cargo.toml", "**/Cargo.lock", "**/go.mod", "**/go.sum", "**/Gemfile",
      "**/Gemfile.lock",
    ],
  },
});

// Frozen copy of safe_categories at 0163daf7 (unchanged since in scripts/sensitive-classes.json).
export const V1_SAFE_CATEGORIES = Object.freeze({
  docs: { paths: ["*.md", "docs/**"], exclude: ["docs/migration-drafts/**", "docs/release/**/*.sql", "AGENTS.md", "CLAUDE.md"] },
  tests: { paths: ["**/*.test.{ts,tsx,mjs}", "**/*.node-test.mjs", "e2e/**"], exclude: ["e2e/fixtures/**/*.sql"] },
  frontend_ui: {
    paths: ["src/components/**", "src/pages/**", "src/features/**"],
    exclude_keywords: ["auth", "session", "permission", "login", "logout", "signin", "sign-in", "signout", "sign-out", "signup", "sign-up", "password", "billing", "pricing", "checkout", "stripe", "dispatch"],
  },
  styles_assets: { paths: ["**/*.css", "public/**", "src/assets/**"] },
  repo_scripts: { paths: ["scripts/**"], exclude: ["scripts/deploy*", "scripts/deploy*/**", "scripts/release*", "scripts/release*/**"], exclude_keywords: ["secret", "credential", "token"] },
  agent_skills: { paths: [".codex/skills/**", ".claude/agents/**"] },
});

// ---------------------------------------------------------------- v1 matcher (0163daf7)

function v1ExpandBraces(pattern) {
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
      const rest = v1ExpandBraces(pattern.slice(index + 1));
      return parts.flatMap((part) => v1ExpandBraces(prefix + part).flatMap((head) => rest.map((tail) => head + tail)));
    }
  }
  throw new Error(`unbalanced brace in glob "${pattern}"`);
}

function v1SegmentSource(segment) {
  let source = "";
  for (const char of segment) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return source;
}

function v1GlobToRegExp(glob) {
  const alternatives = v1ExpandBraces(glob).map((pattern) => {
    const segments = pattern.split("/");
    let source = "";
    segments.forEach((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") source += last ? ".*" : "(?:[^/]+/)*";
      else source += v1SegmentSource(segment) + (last ? "" : "/");
    });
    return source;
  });
  return new RegExp(`^(?:${alternatives.join("|")})$`, "i");
}

/** 0163daf7's pathWords. */
export function v1PathWords(file) {
  return String(file)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function v1KeywordMatches(words, keyword, anywhere = false) {
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

const compileV1 = (entries) =>
  Object.entries(entries).map(([name, entry]) => ({
    name,
    paths: (entry.paths ?? []).map(v1GlobToRegExp),
    pathGlobs: entry.paths ?? [],
    keywords: entry.path_keywords ?? [],
    exclude: (entry.exclude ?? []).map(v1GlobToRegExp),
    excludeKeywords: entry.exclude_keywords ?? [],
  }));
const V1_COMPILED = { classes: compileV1(V1_CLASSES), categories: compileV1(V1_SAFE_CATEGORIES) };

function v1EntryReason(entry, file, words) {
  if (entry.exclude.some((re) => re.test(file))) return null;
  if (entry.excludeKeywords.some((keyword) => v1KeywordMatches(words, keyword, true))) return null;
  const glob = entry.paths.findIndex((re) => re.test(file));
  if (glob !== -1) return `path:${entry.pathGlobs[glob]}`;
  const keyword = entry.keywords.find((candidate) => v1KeywordMatches(words, candidate));
  return keyword ? `path_keyword:${keyword}` : null;
}

/** 0163daf7's classifyPath over its frozen path rules. */
export function v1ClassifyPath(file) {
  const words = v1PathWords(file);
  const classes = [];
  const reasons = [];
  for (const entry of V1_COMPILED.classes) {
    const reason = v1EntryReason(entry, file, words);
    if (reason) {
      classes.push(entry.name);
      reasons.push(`${entry.name}:${reason}`);
    }
  }
  if (classes.length) return { classes, category: null, reasons };
  for (const entry of V1_COMPILED.categories) {
    const reason = v1EntryReason(entry, file, words);
    if (reason) return { classes, category: entry.name, reasons: [`${entry.name}:${reason}`] };
  }
  return { classes, category: null, reasons: [] };
}

// ---------------------------------------------------------------- generated names

/** Every printable ASCII character other than a letter or digit (space and the 32 punctuation characters). */
export const ASCII_NON_ALNUM = Object.freeze(Array.from({ length: 95 }, (_, k) => String.fromCodePoint(32 + k)).filter((char) => !/[A-Za-z0-9]/.test(char)));
/** A tab, a no-break space, a non-ASCII letter, a CJK character and the dotted capital I (lower case "i" plus a combining dot). */
export const EXTRA_CHARACTERS = Object.freeze(["\t", "\u00A0", "\u00E9", "\u4E2D", "\u0130"]);
export const CHARACTERS = Object.freeze([...ASCII_NON_ALNUM, ...EXTRA_CHARACTERS]);
export const DIRECTORIES = Object.freeze(["src/features", "src/pages", "src/components", "worker/src", "scripts", "docs", "e2e", ".codex/skills"]);
export const TAILS = Object.freeze([".tsx", ".md", "/index.ts"]);
const LEFTS = ["", "a", "x", "quote", "a1"];
const RIGHTS = ["", "s", "Form"];
const BRACKETS = [["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"]];

let caseFolds = null;
/** Non-ASCII characters whose lower case is one ASCII letter (v1 lower-cased before splitting words), by letter. */
export function nonAsciiCaseFolds() {
  if (caseFolds) return caseFolds;
  caseFolds = new Map();
  for (let point = 0x80; point <= 0x10ffff; point += 1) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    const char = String.fromCodePoint(point);
    const lower = char.toLowerCase();
    if (/^[a-z]$/.test(lower)) caseFolds.set(lower, [...(caseFolds.get(lower) ?? []), char]);
  }
  return caseFolds;
}

const capitalise = (word) => word[0].toUpperCase() + word.slice(1);

/** A word in lower case, capitalised, upper case and with each letter replaced by each of its non-ASCII case folds. */
function wordForms(word, { folds = true } = {}) {
  const forms = [word, capitalise(word), word.toUpperCase()];
  if (folds) {
    [...word].forEach((letter, index) => {
      for (const fold of nonAsciiCaseFolds().get(letter) ?? []) forms.push(word.slice(0, index) + fold + word.slice(index + 1));
    });
  }
  return forms;
}

/** [before, after] pairs: nothing, each character before, after and on both sides, and bracket pairs. */
function aroundPairs() {
  return [["", ""], ...CHARACTERS.map((char) => [char, ""]), ...CHARACTERS.map((char) => ["", char]), ...CHARACTERS.map((char) => [char, char]), ...BRACKETS];
}

/** Words of v1's path keywords: one-word keywords, and the two-word ones as [first, second]. */
export function v1Keywords() {
  const keywords = Object.values(V1_CLASSES).flatMap((entry) => entry.path_keywords ?? []);
  return { single: keywords.filter((keyword) => !keyword.includes("-")), pairs: keywords.filter((keyword) => keyword.includes("-")).map((keyword) => keyword.split("-")) };
}

function* inDirectories(cores, { directories, tails }) {
  for (const directory of directories) {
    for (const core of cores) {
      for (const tail of tails) {
        const name = `${directory}/${core}${tail}`;
        if (!name.includes("//")) yield name;
      }
    }
  }
}

/**
 * Cores for one keyword form: every [before, after] pair after each left
 * context, each left and right context alone, and each separator parent
 * alone and with its character repeated in front of the keyword.
 */
function formCores(form, cores) {
  for (const left of LEFTS) {
    for (const [before, after] of aroundPairs()) cores.add(`${left}${before}${form}${after}`);
    for (const right of RIGHTS) cores.add(`${left}${form}${right}`);
  }
  for (const char of CHARACTERS) {
    if (char === "/") continue;
    for (const parent of [`x${char}/`, `${char}/`]) {
      cores.add(`${parent}${form}`);
      cores.add(`${parent}${char}${form}`);
    }
  }
}

function singleKeywordCores(keyword) {
  const cores = new Set();
  for (const form of wordForms(keyword)) formCores(form, cores);
  return cores;
}

function pairKeywordCores([first, second]) {
  const cores = new Set();
  const firstForms = wordForms(first);
  const secondForms = wordForms(second);
  // Every character, and every pair of characters around a separator, between the words.
  const between = [
    "",
    ...CHARACTERS.flatMap((char) => [char, `${char}${char}`, `/${char}/`]),
    ...["", ...CHARACTERS].flatMap((left) => ["", ...CHARACTERS].map((right) => `${left}/${right}`)),
  ];
  for (const middle of between) {
    for (const firstForm of firstForms.slice(0, 2)) {
      for (const secondForm of secondForms.slice(0, 2)) cores.add(`${firstForm}${middle}${secondForm}`);
    }
  }
  // Every [before, after] pair around either word, in one name or across a separator.
  for (const [firstForm, secondForm] of [[first, second], [capitalise(first), capitalise(second)]]) {
    for (const middle of ["", "/"]) {
      for (const [before, after] of aroundPairs()) {
        cores.add(`${before}${firstForm}${after}${middle}${secondForm}`);
        cores.add(`${firstForm}${middle}${before}${secondForm}${after}`);
      }
    }
  }
  // Every character before, after and around the pair, and next to the separator in front of it.
  for (const index of [0, 1, 2]) {
    for (const middle of ["", "-", "/", "_/", "/_"]) formCores(`${firstForms[index]}${middle}${secondForms[index]}`, cores);
  }
  return cores;
}

/** Each brace expansion of a v1 glob with every wildcard filled in turn by every character (alone, and before or after a letter). */
function globInstances(glob, { directories }) {
  const out = new Set();
  for (const expansion of v1ExpandBraces(glob)) {
    const tokens = expansion.split(/(\*\*|\*|\?)/).filter((token) => token !== "");
    const wildcards = tokens.map((token, index) => (["**", "*", "?"].includes(token) ? index : -1)).filter((index) => index !== -1);
    const base = (token, index) => {
      if (token === "**") return index === 0 ? directories[0] : "x";
      if (token === "*" || token === "?") return "x";
      return token;
    };
    const baseTokens = tokens.map(base);
    out.add(baseTokens.join(""));
    for (const directory of directories) if (tokens[0] === "**") out.add([directory, ...baseTokens.slice(1)].join(""));
    for (const index of wildcards) {
      const token = tokens[index];
      const fillers = CHARACTERS.flatMap((char) => (token === "?" ? [char] : [char, `x${char}`, `${char}x`]));
      for (const filler of fillers) {
        const filled = [...baseTokens];
        filled[index] = filler;
        out.add(filled.join(""));
        filled[index] = filler.toUpperCase();
        out.add(filled.join(""));
      }
    }
    out.add(baseTokens.join("").toUpperCase());
  }
  return out;
}

/**
 * Every generated name, once. Options narrow the directories and tails (the
 * test runs every character and position in fewer directories).
 */
export function* sweepNames({ directories = DIRECTORIES, tails = TAILS } = {}) {
  const seen = new Set();
  const fresh = function* (names) {
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      yield name;
    }
  };
  const { single, pairs } = v1Keywords();
  for (const keyword of single) yield* fresh(inDirectories(singleKeywordCores(keyword), { directories, tails }));
  for (const pair of pairs) yield* fresh(inDirectories(pairKeywordCores(pair), { directories, tails }));
  for (const entry of Object.values(V1_CLASSES)) for (const glob of entry.paths ?? []) yield* fresh(globInstances(glob, { directories }));
}

// ---------------------------------------------------------------- residual classes

/** Code-unit order, so keys and tables do not depend on the ICU locale. */
function byCodeUnit(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Characters a glob can spell literally (outside braces, "," is literal). */
const GLOB_LITERAL = /^[A-Za-z0-9._\-/,]$/;

/**
 * Why v1 matched rls in a name: for each occurrence of "rls" that v1's match
 * depends on, the character in front of it ("" at a segment start).
 */
function rlsOccurrences(name) {
  const out = [];
  // Searched in the name as given: lower-casing can change its length ("\u0130" becomes two characters).
  for (const { index } of name.matchAll(/rls/gi)) {
    const without = `${name.slice(0, index)}zzz${name.slice(index + 3)}`;
    if (v1KeywordMatches(v1PathWords(without), "rls")) continue;
    out.push(index === 0 || name[index - 1] === "/" ? "" : name[index - 1]);
  }
  return out;
}

/** A character as the residual keys and the PR body show it: printable ASCII as is, anything else as U+XXXX. */
export function describeCharacter(char) {
  return /^[\x21-\x7e]$/.test(char) ? char : `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * The residual class of a lost name, or null when the loss is unexplained.
 * Keys: "rls after <character>" (describeCharacter) or "rls at a camelCase boundary".
 */
export function residualClass(name, v1Result) {
  if (!v1Result.reasons.every((reason) => reason === "rls:path_keyword:rls")) return null;
  const before = rlsOccurrences(name);
  if (before.length === 0) return null;
  const keys = new Set();
  for (const char of before) {
    if (char === "") return null;
    if (/^[A-Za-z0-9]$/.test(char)) keys.add("rls at a camelCase boundary");
    else if (GLOB_LITERAL.test(char)) return null;
    else keys.add(`rls after ${describeCharacter(char)}`);
  }
  return [...keys].sort(byCodeUnit)[0];
}

/**
 * The witness of a residual class: a name in the class whose every covering
 * glob also matches PINNED_SAFE_NAME. A glob cannot spell the character, so a
 * wildcard stands there and also matches "u"; a camelCase "uRls" differs from
 * "urls" only in case, and globs ignore case.
 */
export function residualWitness(key) {
  if (key === "rls at a camelCase boundary") return { name: "src/lib/uRls.ts", same: PINNED_SAFE_NAME };
  const shown = key.replace(/^rls after /, "");
  const char = shown.startsWith("U+") ? String.fromCodePoint(Number.parseInt(shown.slice(2), 16)) : shown;
  return { name: `src/lib/${char}rls.ts`, same: PINNED_SAFE_NAME };
}

// ---------------------------------------------------------------- sweep

const isSafe = (result) => result.classes.length === 0 && result.category !== null;

/**
 * Classify every name with v1 and with this checkout.
 * @returns {{total, v1Sensitive, kept, lost, lostToSafe, lostToUnclassified, newlySafe, residual: Map, unexplained: string[]}}
 */
export function runSweep({ config, names = sweepNames() } = {}) {
  const stats = { total: 0, v1Sensitive: 0, kept: 0, lost: 0, lostToSafe: 0, lostToUnclassified: 0, newlySafe: 0, residual: new Map(), unexplained: [], newlySafeNames: [] };
  for (const name of names) {
    stats.total += 1;
    const before = v1ClassifyPath(name);
    const after = classifyPath(name, config);
    if (before.classes.length === 0) {
      if (!isSafe(before) && isSafe(after)) {
        stats.newlySafe += 1;
        if (stats.newlySafeNames.length < 20) stats.newlySafeNames.push(name);
      }
      continue;
    }
    stats.v1Sensitive += 1;
    if (after.classes.length) stats.kept += 1;
    else recordLost(stats, name, before, isSafe(after));
  }
  return stats;
}

/** Count a name sensitive at v1 and not sensitive here, under its residual class or as unexplained. */
function recordLost(stats, name, before, safe) {
  stats.lost += 1;
  if (safe) stats.lostToSafe += 1;
  else stats.lostToUnclassified += 1;
  const key = residualClass(name, before);
  if (key === null) {
    stats.unexplained.push(name);
    return;
  }
  const entry = stats.residual.get(key) ?? { count: 0, toSafe: 0, example: name };
  entry.count += 1;
  if (safe) entry.toSafe += 1;
  stats.residual.set(key, entry);
}

/** Check a residual class's witness against v1, this checkout and the shared fixture. Returns problems. */
export function witnessProblems(key, config, fixture) {
  const { name, same } = residualWitness(key);
  const problems = [];
  if (!v1ClassifyPath(name).classes.includes("rls")) problems.push(`${key}: witness ${JSON.stringify(name)} is not rls at v1`);
  if (classifyPath(name, config).classes.length) problems.push(`${key}: witness ${JSON.stringify(name)} is sensitive here, so the class is not residual`);
  const sameUnderWildcard = name.length === same.length && [...name].every((char, index) => char.toLowerCase() === same[index] || (!GLOB_LITERAL.test(char) && same[index] === "u"));
  if (!sameUnderWildcard) problems.push(`${key}: witness ${JSON.stringify(name)} differs from ${same} in more than the unspellable character or case`);
  const row = fixture.paths.find((entry) => entry.path === same);
  if (row?.classes.length !== 0) problems.push(`${key}: ${same} is not pinned as not sensitive in ${FIXTURE_PATH}`);
  return problems;
}

/** A Markdown code span that survives a table cell (backticks and pipes in the text). */
const codeSpan = (text) => {
  const body = text.replaceAll("|", "\\|");
  return body.includes("`") ? `\`\` ${body} \`\`` : `\`${body}\``;
};

/** The PR-body summary, generated from a sweep. Examples are shown as JSON strings. */
export function formatSweep(stats) {
  const lines = [
    `Names generated: ${stats.total}. Sensitive at ${V1_COMMIT}: ${stats.v1Sensitive}. Still sensitive: ${stats.kept}. Lost: ${stats.lost} (${stats.lostToSafe} to a safe category, ${stats.lostToUnclassified} to unclassified). Unexplained: ${stats.unexplained.length}. Not safe at ${V1_COMMIT} and safe here: ${stats.newlySafe}.`,
    "",
    "| Residual class | Lost names | Of which safe here | Example |",
    "| --- | --- | --- | --- |",
  ];
  const label = (key) => {
    const shown = key.replace(/^rls after /, "");
    if (shown === key) return key;
    return `rls after ${/^U\+[0-9A-F]{4,}$/.test(shown) ? shown : codeSpan(shown)}`;
  };
  for (const [key, entry] of [...stats.residual].sort(([a], [b]) => byCodeUnit(a, b))) {
    lines.push(`| ${label(key)} | ${entry.count} | ${entry.toSafe} | ${codeSpan(JSON.stringify(entry.example))} |`);
  }
  return `${lines.join("\n")}\n`;
}

function invokedAsScript(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  const { config, errors } = loadConfig();
  if (!config) {
    console.error(errors.join("\n"));
    process.exit(2);
  }
  const fixture = JSON.parse(readFileSync(path.join(REPO_ROOT, FIXTURE_PATH), "utf8"));
  const stats = runSweep({ config });
  const problems = [...stats.residual.keys()].flatMap((key) => witnessProblems(key, config, fixture));
  process.stdout.write(formatSweep(stats));
  for (const name of stats.unexplained.slice(0, 50)) console.error(`unexplained: ${JSON.stringify(name)}`);
  for (const problem of problems) console.error(`witness: ${problem}`);
  const jsonAt = process.argv.indexOf("--json");
  if (jsonAt !== -1) writeFileSync(process.argv[jsonAt + 1], `${JSON.stringify({ ...stats, residual: Object.fromEntries(stats.residual) }, null, 2)}\n`);
  process.exitCode = stats.unexplained.length || problems.length ? 1 : 0;
}
