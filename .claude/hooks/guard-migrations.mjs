#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: blocks writes to supabase/migrations/** unless
 * Blaine has opened a window for the current work item.
 *
 * Allowed when OVD_BLAINE_WINDOW=1, or when the current branch's PR carries the
 * `blaine-window` label applied by the human GitHub user optomachina. Anything
 * else (no PR, gh missing, bot-applied label, offline) fails closed.
 * Reads are never blocked. Exit 2 + stderr blocks the tool call.
 *
 * Tests inject a fake gh via OVD_GUARD_GH_BIN.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOW_LABEL = "blaine-window";
export const OVERRIDE_ENV = "OVD_BLAINE_WINDOW";
export const GH_BIN_ENV = "OVD_GUARD_GH_BIN";
export const WINDOW_ACTOR_LOGIN = "optomachina";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const MIGRATIONS_RE = /(^|\/)supabase\/migrations(\/|$)/;
const SUPABASE_DIR_RE = /(^|\/)supabase$/;
const MIGRATION_IN_TEXT = /supabase[\\/]+migrations/i;
const WRITE_HINT =
  /\b(writefilesync|writefile|appendfile|createwritestream|write_text|write_bytes|makedirs|mkdir|unlink|remove|rename|rmtree|shutil|writelines|dump|to_csv|to_json)\b|\.write\s*\(|open\s*\([^)]*['"][wax+]/i;

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
  return MIGRATIONS_RE.test(folded(path, cwd) + "/");
}

export function isSupabaseDir(path, cwd = process.cwd()) {
  return SUPABASE_DIR_RE.test(folded(path, cwd));
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
      // A bare fd number (2>) or & (&>) directly before the operator belongs to it.
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
      if ((c === "|" || c === "&") && command[i + 1] === c) i++;
      tokens.push({ type: "op" });
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

const positional = (args) => args.filter((arg) => !arg.startsWith("-"));

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

export function isSupabaseMigrationNew(argv) {
  const unwrapped = unwrapLaunchers(argv);
  if (baseCmd(unwrapped[0]) !== "supabase") return false;
  const words = unwrapped.map((word) => word.toLowerCase());
  const index = words.indexOf("migration");
  return index !== -1 && words[index + 1] === "new";
}

function interpreterKind(name) {
  const cmd = baseCmd(name);
  if (cmd === "node" || cmd === "nodejs") return "node";
  if (cmd.startsWith("python")) return "python";
  return null;
}

function interpreterScript(argv) {
  const kind = interpreterKind(argv[0]);
  if (!kind) return null;
  const flags = kind === "python" ? ["-c", "--command"] : ["-e", "--eval", "-p", "--print"];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    for (const flag of flags) {
      if (arg === flag && argv[i + 1]) return argv[i + 1];
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
  }
  return null;
}

function pathsInScript(script, cwd) {
  const paths = [];
  const quoted = /['"]([^'"]*supabase[\\/]+migrations[^'"]*)['"]/gi;
  let match;
  while ((match = quoted.exec(script))) paths.push(resolve(cwd, match[1]));
  return paths.length > 0 ? paths : [resolve(cwd, "supabase/migrations")];
}

function interpreterWriteTargets(argv, cwd) {
  const script = interpreterScript(argv);
  if (script == null || !MIGRATION_IN_TEXT.test(script) || !WRITE_HINT.test(script)) return [];
  return pathsInScript(script, cwd);
}

function isRecursive(args) {
  return args.some(
    (arg) =>
      arg === "-r" ||
      arg === "-R" ||
      arg === "-a" ||
      arg === "--recursive" ||
      arg === "--archive" ||
      /^-[a-zA-Z]*[rRa]/.test(arg),
  );
}

function lastPositional(args) {
  const rest = positional(args);
  return rest.length > 0 ? rest[rest.length - 1] : null;
}

function withTreeDest(dest, cwd) {
  if (!dest) return [];
  return isSupabaseDir(dest, cwd) ? [dest, `${dest.replace(/\/+$/, "")}/migrations`] : [dest];
}

/** Paths a single command (argv) would write, by command name. */
function commandWriteTargets(argv, cwd) {
  if (isSupabaseMigrationNew(argv)) return [resolve(cwd, "supabase/migrations")];
  const fromInterpreter = interpreterWriteTargets(argv, cwd);
  if (fromInterpreter.length > 0) return fromInterpreter;

  const [name, ...args] = argv;
  const cmd = baseCmd(name);
  switch (cmd) {
    case "tee":
    case "touch":
    case "rm":
    case "truncate":
      return positional(args);
    case "ln":
    case "mv": {
      const dest = lastPositional(args);
      return dest ? withTreeDest(dest, cwd).concat(positional(args)) : positional(args);
    }
    case "cp":
    case "install":
    case "rsync": {
      const dirFlag = args.findIndex((arg) => arg === "-t" || arg === "--target-directory");
      if (dirFlag !== -1 && args[dirFlag + 1]) return withTreeDest(args[dirFlag + 1], cwd);
      const dest = lastPositional(args);
      if (!dest) return [];
      if (cmd === "rsync" || isRecursive(args)) return withTreeDest(dest, cwd);
      return [dest];
    }
    case "sed":
    case "perl":
      return args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place")) ? positional(args) : [];
    case "dd":
      return args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3));
    case "git":
      return ["mv", "rm"].includes(args[0]) ? positional(args.slice(1)) : [];
    default:
      return [];
  }
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

/** Every path a Bash command line would write to (redirect targets plus known writers). */
export function bashWriteTargets(command, cwd = process.cwd()) {
  const targets = [];
  let currentCwd = cwd;
  for (const segment of splitSegments(tokenize(command))) {
    const { argv: rawArgv, redirects } = argvFromSegment(segment);
    for (const target of redirects) targets.push(resolve(currentCwd, target));
    const argv = stripWrappers(rawArgv);
    if (argv[0] === "cd" && argv[1]) {
      currentCwd = resolve(currentCwd, argv[1]);
      continue;
    }
    if (["bash", "sh", "zsh"].includes(baseCmd(argv[0])) && argv[1] === "-c" && argv[2]) {
      targets.push(...bashWriteTargets(argv[2], currentCwd));
      continue;
    }
    for (const target of commandWriteTargets(argv, currentCwd)) targets.push(resolve(currentCwd, target));
  }
  return targets;
}

function labelListIncludesWindow(value) {
  return String(value)
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .includes(WINDOW_LABEL);
}

function addsWindowLabel(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--add-label" || arg === "--add-labels" || arg === "-l") {
      if (labelListIncludesWindow(args[i + 1] ?? "")) return true;
    }
    if (arg.startsWith("--add-label=") || arg.startsWith("--add-labels=")) {
      if (labelListIncludesWindow(arg.slice(arg.indexOf("=") + 1))) return true;
    }
  }
  return false;
}

function ghApiMethod(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-X" || args[i] === "--method") && args[i + 1]) return args[i + 1].toUpperCase();
    if (args[i].startsWith("--method=")) return args[i].slice("--method=".length).toUpperCase();
  }
  if (args.some((arg) => ["-f", "-F", "--raw-field", "--field", "--input"].includes(arg) || /^-f=|^-F=/.test(arg))) {
    return "POST";
  }
  return "GET";
}

/** True when a Bash line would add the blaine-window label. */
export function isLabelSelfGrant(command) {
  if (typeof command !== "string") return false;
  for (const segment of splitSegments(tokenize(command))) {
    const argv = stripWrappers(argvFromSegment(segment).argv);
    if (baseCmd(argv[0]) !== "gh") continue;
    const rest = argv.slice(1);
    if ((rest[0] === "pr" || rest[0] === "issue") && rest[1] === "edit" && addsWindowLabel(rest)) return true;
    if (rest[0] !== "api") continue;
    const joined = rest.join(" ");
    if (/\bgraphql\b/i.test(joined) && /blaine-window|addlabelstolabelable|addlabels/i.test(joined)) return true;
    if (!/\/labels\b/i.test(joined)) continue;
    const method = ghApiMethod(rest);
    if (method !== "GET" && method !== "HEAD") return true;
    if (/blaine-window/i.test(joined)) return true;
  }
  return false;
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
  if (EDIT_TOOLS.has(toolName)) {
    if (input == null || typeof input !== "object" || Array.isArray(input)) {
      return { malformed: true, reason: "tool_input is missing or malformed; failing closed." };
    }
    const path = input.file_path ?? input.notebook_path;
    if (typeof path !== "string" || path === "") {
      return { malformed: true, reason: "tool_input is missing a file path; failing closed." };
    }
    return { malformed: false };
  }
  if (toolName === "Bash") {
    if (input == null || typeof input !== "object" || Array.isArray(input) || typeof input.command !== "string") {
      return { malformed: true, reason: "tool_input.command is missing or malformed; failing closed." };
    }
    return { malformed: false };
  }
  return { malformed: false };
}

/** Migration paths this tool call would write, or [] when it is not a migration write. */
export function migrationWriteTargets(payload) {
  const { tool_name: toolName, tool_input: input = {}, cwd = process.cwd() } = payload ?? {};
  let candidates = [];
  if (EDIT_TOOLS.has(toolName)) candidates = [input.file_path, input.notebook_path];
  else if (toolName === "Bash" && typeof input.command === "string") candidates = bashWriteTargets(input.command, cwd);
  return candidates.filter((path) => isMigrationPath(path, cwd));
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
  return actor?.login === WINDOW_ACTOR_LOGIN && actor?.type === "User";
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
    return { ok: true, actor: { login: last.actor?.login ?? null, type: last.actor?.type ?? null } };
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

/** Pure decision given injected lookups. Returns { allow: true } or { allow: false, reason }. */
export function decide(payload, { env = process.env, branch = null, viewPr = () => ({ ok: false, error: "gh not called" }) } = {}) {
  const inspected = inspectPayload(payload);
  if (inspected.malformed) {
    return deny(`Blocked: ${inspected.reason}`);
  }

  const input = payload.tool_input ?? {};
  if (payload.tool_name === "Bash" && isLabelSelfGrant(input.command)) {
    return deny(
      [
        `Blocked: this command would add the "${WINDOW_LABEL}" label.`,
        "Agents must not grant themselves a Blaine window.",
        `Ask the human GitHub user ${WINDOW_ACTOR_LOGIN} to apply the label.`,
      ].join("\n"),
    );
  }

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
    status = `PR #${pr.number} has the "${WINDOW_LABEL}" label, but it was not applied by the human user ${WINDOW_ACTOR_LOGIN} (last actor: ${actor}); failing closed`;
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
      "Migration changes require a Blaine window. To proceed, either:",
      `  - have the human GitHub user ${WINDOW_ACTOR_LOGIN} apply the "${WINDOW_LABEL}" label on this PR, or`,
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
