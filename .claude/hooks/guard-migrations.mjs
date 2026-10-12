#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: best-effort guard against writes to
 * supabase/migrations/** and against self-granting the blaine-window label.
 *
 * This is a best-effort guardrail. An agent holding a user token cannot be
 * told apart from the user, so the real gate stays at Blaine's merge and
 * apply approval.
 *
 * Allowed when OVD_BLAINE_WINDOW=1, or when the current branch's PR carries
 * the blaine-window label applied by the human GitHub user optomachina
 * without performed_via_github_app. Anything else fails closed.
 * Reads are never blocked. Exit 2 + stderr blocks the tool call.
 *
 * Accepted residuals (final hardening): bare git apply/am/patch/tar/unzip
 * whose command does not mention supabase; a script created in one call
 * then run later with no supabase/migration path in the command text;
 * git commit -F of a non-supabase file whose contents mention supabase;
 * substitution that does not appear as $(, backticks, or <( ; >( )
 * process substitution; and reader write/exec options not in the listed
 * set. Those remain Blaine's merge and apply gate.
 *
 * Tests inject a fake gh via OVD_GUARD_GH_BIN.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOW_LABEL = "blaine-window";
export const OVERRIDE_ENV = "OVD_BLAINE_WINDOW";
export const GH_BIN_ENV = "OVD_GUARD_GH_BIN";
export const WINDOW_ACTOR_LOGIN = "optomachina";
export const SAFE_LABELS = new Set([
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
  "codex",
  "qa-ready",
]);

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const MIGRATIONS_RE = /(^|\/)supabase\/migrations(\/|$)/;
const SUPABASE_TREE_RE = /(^|\/)supabase(\/|$)/;
const READER_CMDS = new Set(["ls", "cat", "rg", "grep", "egrep", "fgrep", "head", "tail", "wc", "less", "file", "stat", "find", "sort", "uniq", "diff"]);
const GIT_READERS = new Set(["diff", "log", "show", "status", "blame"]);
const TEST_RUNNERS = new Set(["vitest", "jest", "mocha", "ava", "tap"]);
const WRITERS = new Set([
  "touch",
  "cp",
  "mv",
  "tee",
  "install",
  "rsync",
  "rm",
  "truncate",
  "dd",
  "mkdir",
  "ln",
  "chmod",
  "chown",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "tcsh", "csh", "fish", "eval"]);
const MCP_READ = /(?:^|__)(read|get|list|search|grep|glob|stat|fetch|show|query)(?:_|$)/i;
const MCP_APPLY = /(?:^|__)(apply|execute|exec|run_sql|rpc)(?:_|$)/i;

/** Resolve existing prefix via realpath, then append the missing tail. */
export function resolvePath(path, cwd = process.cwd()) {
  if (typeof path !== "string" || path === "") return "";
  const normalized = path.replace(/\\/g, "/");
  const absolute = isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
  let current = absolute;
  const missing = [];
  while (current && current !== dirname(current) && !existsSync(current)) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  if (existsSync(current)) {
    try {
      current = realpathSync(current);
    } catch {
      // Keep the existing prefix when realpath is not available.
    }
  }
  return resolve(current, ...missing).replace(/\\/g, "/");
}

function folded(path, cwd) {
  return resolvePath(path, cwd).toLowerCase().replace(/\/+$/, "");
}

export function isMigrationPath(path, cwd = process.cwd()) {
  return MIGRATIONS_RE.test(`${folded(path, cwd)}/`);
}

export function isSupabaseTreePath(path, cwd = process.cwd()) {
  return SUPABASE_TREE_RE.test(`${folded(path, cwd)}/`);
}

/** Replace $NAME and ${NAME} from simple NAME=value assignments in the line. */
export function expandSimpleVars(command) {
  if (typeof command !== "string") return "";
  const assigns = new Map();
  const assignRe = /(?:^|[;\s])([A-Za-z_][A-Za-z0-9_]*)=([^\s;]+)/g;
  let match;
  while ((match = assignRe.exec(command))) {
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    assigns.set(match[1], value);
  }
  let expanded = command;
  for (const [name, value] of assigns) {
    expanded = expanded.split(`\${${name}}`).join(value).split(`$${name}`).join(value);
  }
  return expanded;
}

/** Remove shell quoting so supa"base" becomes supabase. */
export function stripQuotes(command) {
  if (typeof command !== "string") return "";
  let out = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      out += command.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) i++;
        out += command[i++];
      }
    } else if (c === "\\" && i + 1 < command.length) {
      out += command[++i];
    } else {
      out += c;
    }
  }
  return out;
}

function normalizeCommand(command) {
  return stripQuotes(expandSimpleVars(command));
}

function stripCommitMessages(command) {
  return command
    .replace(/(?:^|\s)--message(?:=|\s+)'(?:\\'|[^'])*'/g, " ")
    .replace(/(?:^|\s)--message(?:=|\s+)"(?:\\"|[^"])*"/g, " ")
    .replace(/(?:^|\s)-[A-Za-z]*m(?:=|\s+)'(?:\\'|[^'])*'/g, " ")
    .replace(/(?:^|\s)-[A-Za-z]*m(?:=|\s+)"(?:\\"|[^"])*"/g, " ");
}

function skipCommitMessageArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--message" || /^-[A-Za-z]*m$/.test(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("--message=")) continue;
    out.push(arg);
  }
  return out;
}

/** True when the raw command contains $( ), backticks, or <( ). */
export function hasCommandSubstitution(command) {
  return typeof command === "string" && /\$\(|<\(|`/.test(command);
}

function commandMentionsSupabaseOrMigration(command) {
  const text = stripQuotes(expandSimpleVars(command)).toLowerCase();
  return /(?<![a-z0-9])supabase(?![a-z0-9])/.test(text) || /(?<![a-z0-9])migration(?![a-z0-9])/.test(text);
}

/** Substitution or process substitution appearing alongside a supabase/migration path. */
export function substitutionTouchesSupabase(command) {
  if (typeof command !== "string" || command === "") return false;
  const expanded = expandSimpleVars(command);
  if (!hasCommandSubstitution(command) && !hasCommandSubstitution(expanded)) return false;
  return commandMentionsSupabaseOrMigration(command) || commandMentionsSupabaseOrMigration(expanded);
}

function commitFileArgs(argv) {
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-F" || arg === "--file") {
      if (argv[i + 1]) paths.push(argv[++i]);
      continue;
    }
    if (arg.startsWith("--file=")) paths.push(arg.slice("--file=".length));
  }
  return paths;
}

function hasFindWriteOption(argv) {
  return argv.some(
    (arg) =>
      arg === "-exec" ||
      arg === "-execdir" ||
      arg === "-ok" ||
      arg === "-okdir" ||
      arg === "-delete" ||
      arg === "-fls" ||
      arg.startsWith("-fprint"),
  );
}

function hasSortWriteOption(argv) {
  return argv.some(
    (arg) => arg === "-o" || (arg.startsWith("-o") && !arg.startsWith("--")) || arg === "--output" || arg.startsWith("--output="),
  );
}

function hasGitDiffWriteOption(argv) {
  return argv.some((arg) => arg === "--output" || arg.startsWith("--output="));
}

function hasUniqWriteOption(argv) {
  return argv.slice(1).filter((arg) => arg !== "--" && !arg.startsWith("-")).length >= 2;
}

function hasFileWriteOption(argv) {
  return argv.some((arg) => arg === "-C" || arg.startsWith("-C") && !arg.startsWith("--"));
}

function readerHasWriteOption(argv) {
  const cmd = baseCmd(argv[0]);
  if (cmd === "find") return hasFindWriteOption(argv);
  if (cmd === "sort") return hasSortWriteOption(argv);
  if (cmd === "uniq") return hasUniqWriteOption(argv);
  if (cmd === "file") return hasFileWriteOption(argv);
  if (cmd === "git" && argv[1] === "diff") return hasGitDiffWriteOption(argv);
  return false;
}

/** Command text used for supabase/migration mention checks. */
export function mentionHaystack(command) {
  const prepared = stripQuotes(stripCommitMessages(expandSimpleVars(command)));
  const parts = [];
  for (const segment of splitSegments(tokenize(prepared))) {
    const { argv, redirects } = argvFromSegment(segment);
    const words = baseCmd(argv[0]) === "git" && argv[1] === "commit" ? skipCommitMessageArgs(argv) : argv;
    parts.push(...words, ...redirects);
  }
  return parts.join(" ");
}

export function mentionsSupabaseOrMigration(command) {
  const text = mentionHaystack(command).toLowerCase();
  return /(?<![a-z0-9])supabase(?![a-z0-9])/.test(text) || /(?<![a-z0-9])migration(?![a-z0-9])/.test(text);
}

function isSafeLabel(name) {
  return typeof name === "string" && SAFE_LABELS.has(name.trim().toLowerCase());
}

function addLabelValues(command) {
  const values = [];
  const flagRe = /--add-labels?(=|\s+)([^\s;|&]+)/gi;
  let match;
  while ((match = flagRe.exec(command))) {
    values.push(...match[2].split(",").map((value) => value.replace(/^['"]|['"]$/g, "")));
  }
  return values;
}

function labelsInCommandAreAllSafe(command) {
  const fromFlags = addLabelValues(command);
  const fromName = [];
  const nameRe = /(?:^|[\s&])(?:-f|--raw-field|name=)name=([^\s;|&]+)/gi;
  const shortRe = /(?:^|[\s&])-f\s+name=([^\s;|&]+)/gi;
  let match;
  while ((match = nameRe.exec(command))) fromName.push(match[1]);
  while ((match = shortRe.exec(command))) fromName.push(match[1]);
  const jsonNames = [];
  const jsonRe = /"labels"\s*:\s*\[([^\]]*)\]/gi;
  while ((match = jsonRe.exec(command))) {
    jsonNames.push(...[...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]));
  }
  const values = [...fromFlags, ...fromName, ...jsonNames];
  if (values.length === 0) return false;
  return values.every(isSafeLabel);
}

export function isLabelMutation(command) {
  const text = normalizeCommand(command);
  if (new RegExp(WINDOW_LABEL, "i").test(text)) return true;
  if (/--add-labels?\b/i.test(text)) return !labelsInCommandAreAllSafe(text);
  if (/addlabelstolabelable|addlabels\b/i.test(text)) return !labelsInCommandAreAllSafe(text);
  if (/\/(?:issues|pulls)\/[^/\s]+\/labels\b/i.test(text)) return !labelsInCommandAreAllSafe(text);
  if (/\b(curl|wget|httpie|gh)\b/i.test(text) && /\/labels\b/i.test(text)) return !labelsInCommandAreAllSafe(text);
  return false;
}

/** Minimal shell tokenizer: words (quotes resolved), control ops, and redirects. */
export function tokenize(command) {
  const tokens = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ type: "word", value: word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      word += command.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) i++;
        word += command[i++];
      }
      inWord = true;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (c === ">" || c === "<") {
      if (inWord && !/^(\d+|&)$/.test(word)) flush();
      word = "";
      inWord = false;
      let op = c;
      while (command[i + 1] === ">" || command[i + 1] === "|" || command[i + 1] === "&") op += command[++i];
      if (c === "<" && command[i + 1] === "<") op += command[++i];
      tokens.push({ type: "redirect", value: op });
    } else if (c === "&" && command[i + 1] === ">") {
      flush();
      word = "&";
      inWord = true;
    } else if (c === ";" || c === "\n" || c === "|" || c === "&" || c === "(" || c === ")") {
      flush();
      let value = c === "\n" ? ";" : c;
      if ((c === "|" || c === "&") && command[i + 1] === c) value += command[++i];
      tokens.push({ type: "op", value });
    } else if (/\s/.test(c)) {
      flush();
    } else {
      word += c;
      inWord = true;
    }
  }
  flush();
  return tokens;
}

function splitSegments(tokens) {
  const segments = [[]];
  for (const token of tokens) {
    if (token.type === "op") segments.push([]);
    else segments[segments.length - 1].push(token);
  }
  return segments.filter((segment) => segment.length > 0);
}

function splitSegmentsWithOps(tokens) {
  const parts = [{ tokens: [], opBefore: null }];
  for (const token of tokens) {
    if (token.type === "op") parts.push({ tokens: [], opBefore: token.value });
    else parts[parts.length - 1].tokens.push(token);
  }
  return parts.filter((part) => part.tokens.length > 0);
}

function baseCmd(name) {
  return String(name ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function skipValueFlags(args, valueFlags) {
  const out = [...args];
  while (out[0]?.startsWith("-")) {
    const flag = out[0];
    const matched = valueFlags.find((name) => flag === name || flag.startsWith(`${name}=`));
    if (matched) {
      if (flag.includes("=")) out.shift();
      else out.splice(0, 2);
    } else {
      out.shift();
    }
  }
  return out;
}

export function unwrapLaunchers(argv) {
  let current = [...argv];
  for (let i = 0; i < 4 && current.length > 0; i++) {
    const cmd = baseCmd(current[0]);
    if (cmd === "npx" || cmd === "bunx") {
      current = skipValueFlags(current.slice(1), ["-p", "--package", "-c", "--call", "--node-options"]);
      continue;
    }
    if (cmd === "pnpm") {
      current = ["exec", "dlx", "run"].includes(current[1]) ? current.slice(2) : current.slice(1);
      current = skipValueFlags(current, ["-C", "--dir", "--filter"]);
      continue;
    }
    if (cmd === "npm" && ["exec", "x"].includes(current[1])) {
      current = skipValueFlags(current.slice(2), ["-p", "--package", "-c", "--call"]);
      continue;
    }
    if (cmd === "yarn" && ["dlx", "exec"].includes(current[1])) {
      current = current.slice(2);
      continue;
    }
    break;
  }
  return current;
}

function argvFromSegment(segment) {
  const argv = [];
  const redirects = [];
  for (let i = 0; i < segment.length; i++) {
    const token = segment[i];
    if (token.type === "redirect") {
      const next = segment[i + 1];
      if (next?.type === "word") {
        i++;
        if (token.value.startsWith(">") && !token.value.endsWith("&") && !next.value.startsWith("&")) {
          redirects.push(next.value);
        }
      }
    } else {
      argv.push(token.value);
    }
  }
  return { argv, redirects };
}

function stripWrappers(argv) {
  const next = [...argv];
  while (next.length > 0 && (/^\w+=/.test(next[0]) || ["sudo", "command", "env", "xargs"].includes(next[0]))) {
    next.shift();
  }
  return next;
}

function globToRe(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) source += "\\[";
      else {
        source += pattern.slice(i, end + 1);
        i = end;
      }
    } else if ("\\^$+(){}|.".includes(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`${source}$`, "i");
}

function splitBraceOptions(inner) {
  const options = [];
  let current = "";
  let depth = 0;
  for (const char of inner) {
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (char === "," && depth === 0) {
      options.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  options.push(current);
  return options;
}

function firstBraceGroup(pattern) {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\" ) {
      i++;
      continue;
    }
    if (pattern[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (pattern[i] === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        const inner = pattern.slice(start + 1, i);
        if (inner.includes(",")) {
          return { before: pattern.slice(0, start), options: splitBraceOptions(inner), after: pattern.slice(i + 1) };
        }
        start = -1;
      }
    }
  }
  return null;
}

/** Expand shell brace groups, including empty alternatives such as {base,}. */
export function expandBraces(pattern) {
  if (typeof pattern !== "string" || pattern === "") return [""];
  const group = firstBraceGroup(pattern);
  if (!group) return [pattern];
  const out = [];
  for (const option of group.options) {
    out.push(...expandBraces(`${group.before}${option}${group.after}`));
  }
  return out;
}

function isGlobby(pattern) {
  return /[*?\[]/.test(pattern);
}

function pathTail(pattern, count) {
  return pattern
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .slice(-count)
    .join("/");
}

/** True when a glob/brace path would match supabase/migrations/**. */
export function globMatchesMigrations(pattern) {
  const samples = ["supabase/migrations", "supabase/migrations/", "supabase/migrations/x.sql", "supabase/migrations/foo/bar.sql"];
  const candidates = [pattern.replace(/\\/g, "/").replace(/^\.\//, ""), pathTail(pattern, 3), pathTail(pattern, 2)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const matcher = globToRe(candidate.replace(/\/+$/, ""));
    if (samples.some((sample) => matcher.test(sample.replace(/\/+$/, "")) || matcher.test(sample))) return true;
    const prefixMatcher = globToRe(candidate);
    if (samples.some((sample) => prefixMatcher.test(sample))) return true;
  }
  return false;
}

/** Expand a pathname glob against cwd. Final missing segments are kept. */
export function expandGlobs(pattern, cwd = process.cwd()) {
  if (typeof pattern !== "string" || pattern === "") return [];
  const normalized = pattern.replace(/\\/g, "/");
  const absolute = isAbsolute(normalized);
  const parts = normalized.split("/").filter((part, index) => part !== "" || index === 0);
  let currents = [absolute ? "/" : cwd];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      currents = currents.map((current) => dirname(current));
      continue;
    }
    const next = [];
    for (const current of currents) {
      if (isGlobby(part)) {
        let entries = [];
        try {
          entries = readdirSync(current);
        } catch {
          continue;
        }
        const matcher = globToRe(part);
        for (const entry of entries) {
          if (matcher.test(entry)) next.push(resolve(current, entry));
        }
      } else {
        next.push(resolve(current, part));
      }
    }
    currents = next;
    if (currents.length === 0) return [];
  }
  return currents;
}

function isWriteishArgv(argv) {
  if (argv.length === 0) return false;
  const cmd = baseCmd(argv[0]);
  if (cmd === "sed") return argv.some((arg) => arg === "-i" || arg.startsWith("-i"));
  if (WRITERS.has(cmd)) return true;
  if (cmd === "git" && ["mv", "checkout", "restore", "apply", "am", "rm"].includes(argv[1])) return true;
  if (cmd === "git" && argv[1] === "commit" && commitFileArgs(argv).length > 0) return true;
  return readerHasWriteOption(argv);
}

function nextCwd(current, destArg) {
  if (!destArg) return current;
  const dests = expandBraces(destArg).flatMap((braced) => (isGlobby(braced) ? expandGlobs(braced, current) : [resolvePath(braced, current)]));
  if (dests.some((dest) => isSupabaseTreePath(dest, current))) return dests.find((dest) => isSupabaseTreePath(dest, current)) ?? dests[0] ?? current;
  return dests[0] ?? resolvePath(destArg, current);
}

function pathishArgs(argv) {
  return argv.slice(1).filter((arg) => arg !== "--" && !arg.startsWith("-"));
}

function pathsTouchSupabase(paths, cwd) {
  for (const path of paths) {
    if (typeof path !== "string" || path === "") continue;
    for (const braced of expandBraces(path)) {
      if (globMatchesMigrations(braced)) return true;
      const expanded = isGlobby(braced) ? expandGlobs(braced, cwd) : [resolvePath(braced, cwd)];
      if (expanded.some((candidate) => isSupabaseTreePath(candidate, cwd) || isMigrationPath(candidate, cwd))) {
        return true;
      }
      if (isSupabaseTreePath(braced, cwd) || isMigrationPath(braced, cwd)) return true;
    }
  }
  return false;
}

function commandForWriteScan(command) {
  return stripQuotes(stripCommitMessages(expandSimpleVars(command)));
}

export function writeishTouchesSupabase(command, cwd = process.cwd()) {
  let current = cwd;
  for (const segment of splitSegments(tokenize(commandForWriteScan(command)))) {
    const { argv: rawArgv, redirects } = argvFromSegment(segment);
    const argv = stripWrappers(rawArgv);
    const cmd = baseCmd(argv[0]);
    if (cmd === "git" && argv[1] === "commit") {
      if (pathsTouchSupabase([...redirects, ...commitFileArgs(argv)], current)) return true;
      continue;
    }
    if (cmd === "cd" && argv[1]) {
      current = nextCwd(current, argv[1]);
      continue;
    }
    if (pathsTouchSupabase([...redirects, ...pathishArgs(argv)], current)) return true;
    if ((isWriteishArgv(argv) || redirects.length > 0) && isSupabaseTreePath(current, cwd)) return true;
  }
  return false;
}

function isShellArgv(argv) {
  const cmd = baseCmd(argv[0]);
  if (SHELLS.has(cmd)) return true;
  if (cmd === "busybox" && (argv[1] === "sh" || SHELLS.has(baseCmd(argv[1])))) return true;
  return false;
}

export function pipesIntoShell(command) {
  for (const part of splitSegmentsWithOps(tokenize(normalizeCommand(command)))) {
    if (part.opBefore !== "|") continue;
    const { argv } = argvFromSegment(part.tokens);
    if (isShellArgv(stripWrappers(argv))) return true;
  }
  return false;
}

function isNpmTestOrVerify(argv) {
  const unwrapped = unwrapLaunchers(argv);
  const cmd = baseCmd(unwrapped[0]);
  if (!["npm", "yarn", "pnpm", "npx"].includes(cmd)) return false;
  const rest = unwrapped.slice(1);
  let script = null;
  if (rest[0] === "run" && rest[1]) script = rest[1];
  else if (cmd === "npm" && rest[0] === "test") script = "test";
  else if ((cmd === "yarn" || cmd === "pnpm") && rest[0]) script = rest[0];
  return typeof script === "string" && /^(test|verify)(:|$)/i.test(script);
}

function isTestRunner(argv) {
  if (isNpmTestOrVerify(argv)) return true;
  const unwrapped = unwrapLaunchers(argv);
  const cmd = baseCmd(unwrapped[0]);
  if (TEST_RUNNERS.has(cmd)) return true;
  if (cmd === "node" && unwrapped.some((arg) => arg === "--test" || arg.startsWith("--test="))) return true;
  if (cmd === "playwright" && unwrapped[1] === "test") return true;
  return false;
}

function isAllowlistedArgv(argv, cwd = process.cwd()) {
  if (argv.length === 0) return true;
  if (baseCmd(argv[0]) === "cd") return true;
  if (["bash", "sh", "zsh"].includes(baseCmd(argv[0])) && argv[1] === "-c") {
    return isReadOnlyAllowlisted(argv[2] ?? "", cwd);
  }
  const unwrapped = unwrapLaunchers(argv);
  const cmd = baseCmd(unwrapped[0]);
  if (READER_CMDS.has(cmd)) return !readerHasWriteOption(unwrapped);
  if (cmd === "git" && GIT_READERS.has(unwrapped[1])) return !readerHasWriteOption(unwrapped);
  if (cmd === "git" && unwrapped[1] === "commit") return !pathsTouchSupabase(commitFileArgs(unwrapped), cwd);
  if (cmd === "supabase" && ["--version", "-v", "version"].includes(unwrapped[1])) return true;
  if (isTestRunner(argv)) return true;
  return false;
}

export function isReadOnlyAllowlisted(command, cwd = process.cwd()) {
  if (typeof command !== "string" || command === "") return false;
  if (isLabelMutation(command)) return false;
  if (pipesIntoShell(command)) return false;
  if (substitutionTouchesSupabase(command)) return false;
  const expanded = normalizeCommand(command);
  let current = cwd;
  for (const segment of splitSegments(tokenize(expanded))) {
    const { argv: rawArgv, redirects } = argvFromSegment(segment);
    const argv = stripWrappers(rawArgv);
    if (redirects.some((target) => mentionsSupabaseOrMigration(target) || isMigrationPath(target, current))) {
      return false;
    }
    if (baseCmd(argv[0]) === "cd") {
      if (argv[1]) current = nextCwd(current, argv[1]);
      continue;
    }
    if (!isAllowlistedArgv(argv, current)) return false;
  }
  return true;
}

function tokensTouchMigrationPath(command, cwd) {
  const expanded = commandForWriteScan(command);
  let current = cwd;
  for (const segment of splitSegments(tokenize(expanded))) {
    const { argv, redirects } = argvFromSegment(segment);
    const cmd = baseCmd(stripWrappers(argv)[0]);
    if (cmd === "cd" && argv[1]) {
      current = nextCwd(current, argv[1]);
      continue;
    }
    if (cmd === "git" && stripWrappers(argv)[1] === "commit") {
      if (pathsTouchSupabase([...redirects, ...commitFileArgs(argv)], current)) return true;
      continue;
    }
    if (pathsTouchSupabase([...redirects, ...argv], current) && argv.some((arg) => isMigrationPath(arg, current) || /[*?]/.test(arg))) {
      return true;
    }
    if (redirects.some((target) => isMigrationPath(target, current))) return true;
    if (argv.some((arg) => isMigrationPath(arg, current))) return true;
  }
  return false;
}

export function bashNeedsWindow(command, cwd = process.cwd()) {
  if (typeof command !== "string") return false;
  if (isLabelMutation(command)) return false;
  if (pipesIntoShell(command)) return true;
  if (substitutionTouchesSupabase(command)) return true;
  if (isReadOnlyAllowlisted(command, cwd)) return false;
  return mentionsSupabaseOrMigration(command) || writeishTouchesSupabase(command, cwd) || tokensTouchMigrationPath(command, cwd);
}

function collectStringPaths(value, depth = 0, found = []) {
  if (depth > 6 || value == null) return found;
  if (typeof value === "string") {
    found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringPaths(entry, depth + 1, found);
    return found;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value)) collectStringPaths(entry, depth + 1, found);
  }
  return found;
}

function collectLabelValues(value, key = "", found = []) {
  if (value == null) return found;
  if (typeof value === "string") {
    if (/label/i.test(key)) found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    if (/label/i.test(key)) {
      for (const entry of value) {
        if (typeof entry === "string") found.push(entry);
        else collectLabelValues(entry, key, found);
      }
    } else {
      for (const entry of value) collectLabelValues(entry, key, found);
    }
    return found;
  }
  if (typeof value === "object") {
    for (const [nextKey, entry] of Object.entries(value)) collectLabelValues(entry, nextKey, found);
  }
  return found;
}

export function isMcpLabelSelfGrant(toolName, input) {
  if (typeof toolName !== "string" || !toolName.startsWith("mcp__")) return false;
  const text = JSON.stringify(input ?? {});
  if (text.toLowerCase().includes(WINDOW_LABEL)) return true;
  const labels = collectLabelValues(input);
  if (labels.length === 0) return /labels/i.test(text);
  return labels.some((label) => !isSafeLabel(label));
}

function isMcpApplyOrExecute(toolName) {
  return MCP_APPLY.test(toolName) || /apply_migration|execute_sql/i.test(toolName);
}

export function mcpWriteTargets(payload) {
  const { tool_name: toolName, tool_input: input, cwd = process.cwd() } = payload ?? {};
  if (typeof toolName !== "string" || !toolName.startsWith("mcp__")) return [];
  if (isMcpApplyOrExecute(toolName)) return [resolve(cwd, "supabase/migrations")];
  if (MCP_READ.test(toolName)) return [];
  return collectStringPaths(input).filter((path) => isMigrationPath(path, cwd));
}

export function inspectPayload(payload) {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return { malformed: true, reason: "hook input is not an object; failing closed." };
  }
  const { tool_name: toolName, tool_input: input } = payload;
  if (typeof toolName !== "string" || toolName === "") {
    return { malformed: true, reason: "tool_name is missing; failing closed." };
  }
  if (READ_TOOLS.has(toolName)) return { malformed: false };
  if (EDIT_TOOLS.has(toolName) || toolName === "Bash" || toolName.startsWith("mcp__")) {
    if (input == null || typeof input !== "object" || Array.isArray(input)) {
      return { malformed: true, reason: "tool_input is missing or malformed; failing closed." };
    }
    if (EDIT_TOOLS.has(toolName)) {
      const path = input.file_path ?? input.notebook_path;
      if (typeof path !== "string" || path === "") {
        return { malformed: true, reason: "tool_input is missing a file path; failing closed." };
      }
    }
    if (toolName === "Bash" && typeof input.command !== "string") {
      return { malformed: true, reason: "tool_input.command is missing or malformed; failing closed." };
    }
    return { malformed: false };
  }
  return { malformed: false };
}

/** Migration paths this tool call would write, or [] when it is not a migration write. */
export function migrationWriteTargets(payload) {
  const { tool_name: toolName, tool_input: input = {}, cwd = process.cwd() } = payload ?? {};
  if (EDIT_TOOLS.has(toolName)) {
    return [input.file_path, input.notebook_path].filter((path) => isMigrationPath(path, cwd));
  }
  if (toolName === "Bash" && typeof input.command === "string") {
    if (bashNeedsWindow(input.command, cwd)) return [resolve(cwd, "supabase/migrations")];
    return [];
  }
  if (typeof toolName === "string" && toolName.startsWith("mcp__")) return mcpWriteTargets(payload);
  return [];
}

export function linearKeyFromBranch(branch) {
  const match = /\b([a-z]+-\d+)\b/i.exec(branch ?? "");
  return match ? match[1].toUpperCase() : null;
}

export function currentBranch(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function isHumanOptomachina(actor) {
  if (!actor) return false;
  if (actor.performed_via_github_app) return false;
  return actor.login === WINDOW_ACTOR_LOGIN && actor.type === "User";
}

function parseGhJson(out) {
  try {
    return JSON.parse(out);
  } catch {
    return JSON.parse(out.replace(/\]\s*\[/g, ","));
  }
}

function fetchWindowLabelActor(bin, env, cwd, number) {
  try {
    const out = execFileSync(bin, ["api", "--paginate", `repos/:owner/:repo/issues/${number}/timeline`], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const events = parseGhJson(out);
    if (!Array.isArray(events)) return { ok: false, error: "timeline was not an array" };
    const labeled = events.filter((event) => event?.event === "labeled" && event.label?.name === WINDOW_LABEL);
    const last = labeled[labeled.length - 1];
    if (!last) return { ok: false, error: "no timeline event for blaine-window" };
    return {
      ok: true,
      actor: {
        login: last.actor?.login ?? null,
        type: last.actor?.type ?? null,
        performed_via_github_app: last.performed_via_github_app ?? null,
      },
    };
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim().split("\n")[0];
    return { ok: false, error: detail };
  }
}

/** Returns { ok, number, labels, windowActor } or { ok: false, error }. Never throws. */
export function viewPullRequest(cwd, env = process.env) {
  const bin = env[GH_BIN_ENV] || "gh";
  try {
    const out = execFileSync(bin, ["pr", "view", "--json", "labels,number"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out);
    const labels = (parsed.labels ?? []).map((label) => label.name);
    if (!labels.includes(WINDOW_LABEL)) {
      return { ok: true, number: parsed.number, labels, windowActor: null };
    }
    const actor = fetchWindowLabelActor(bin, env, cwd, parsed.number);
    if (!actor.ok) return { ok: false, error: actor.error };
    return { ok: true, number: parsed.number, labels, windowActor: actor.actor };
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim().split("\n")[0];
    return { ok: false, error: detail };
  }
}

function deny(reason) {
  return { allow: false, reason };
}

function labelSelfGrantReason() {
  return [
    `Blocked: this command would add the "${WINDOW_LABEL}" label.`,
    "Agents must not grant themselves a Blaine window.",
    `Ask the human GitHub user ${WINDOW_ACTOR_LOGIN} to apply the label.`,
    "This hook is a best-effort guardrail. An agent holding a user token cannot be told apart from the user, so the real gate stays at Blaine's merge and apply approval.",
  ].join("\n");
}

/** Pure decision given injected lookups. Returns { allow: true } or { allow: false, reason }. */
export function decide(payload, { env = process.env, branch = null, viewPr = () => ({ ok: false, error: "gh not called" }) } = {}) {
  const inspected = inspectPayload(payload);
  if (inspected.malformed) return deny(`Blocked: ${inspected.reason}`);

  const input = payload.tool_input ?? {};
  if (payload.tool_name === "Bash" && isLabelMutation(input.command)) return deny(labelSelfGrantReason());
  if (isMcpLabelSelfGrant(payload.tool_name, input)) return deny(labelSelfGrantReason());

  const targets = migrationWriteTargets(payload);
  if (targets.length === 0) return { allow: true };
  if (env[OVERRIDE_ENV] === "1") return { allow: true };

  const pr = viewPr();
  if (pr.ok && pr.labels.includes(WINDOW_LABEL) && isHumanOptomachina(pr.windowActor)) return { allow: true };

  const key = linearKeyFromBranch(branch);
  const item = key ? `work item ${key}` : `branch ${branch ?? "(unknown)"} (no Linear key found in branch name)`;
  let status;
  if (pr.ok && pr.labels.includes(WINDOW_LABEL)) {
    const actor = pr.windowActor ? `${pr.windowActor.login} (${pr.windowActor.type})` : "unknown actor";
    const viaApp = pr.windowActor?.performed_via_github_app ? ", performed_via_github_app is set" : "";
    status = `PR #${pr.number} has the "${WINDOW_LABEL}" label, but it was not a direct human ${WINDOW_ACTOR_LOGIN} action (last actor: ${actor}${viaApp}); failing closed`;
  } else if (pr.ok) {
    status = `PR #${pr.number} does not have the "${WINDOW_LABEL}" label`;
  } else {
    status = `could not confirm a PR with a human-applied "${WINDOW_LABEL}" label (${pr.error || "gh failed"}); failing closed`;
  }
  return deny(
    [
      `Blocked: write to supabase/migrations/ for ${item}.`,
      `Targets: ${targets.join(", ")}`,
      `Reason: ${status}.`,
      "This hook is a best-effort guardrail. An agent holding a user token cannot be told apart from the user, so the real gate stays at Blaine's merge and apply approval.",
      "To proceed, either:",
      `  - have the human GitHub user ${WINDOW_ACTOR_LOGIN} apply the "${WINDOW_LABEL}" label on this PR without an app, or`,
      `  - have Blaine start the session with ${OVERRIDE_ENV}=1.`,
      "Do not apply the label yourself and do not work around this guard.",
    ].join("\n"),
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main({ env = process.env } = {}) {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch (error) {
    process.stderr.write(`guard-migrations: could not parse hook input (${error.message}); failing closed.\n`);
    return 2;
  }
  const cwd = payload && typeof payload === "object" ? payload.cwd || process.cwd() : process.cwd();
  const result = decide(payload, {
    env,
    branch: currentBranch(cwd),
    viewPr: () => viewPullRequest(cwd, env),
  });
  if (result.allow) return 0;
  process.stderr.write(`${result.reason}\n`);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
