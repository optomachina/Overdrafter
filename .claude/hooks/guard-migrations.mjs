#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: blocks writes to supabase/migrations/** unless
 * Blaine has opened a window for the current work item.
 *
 * Allowed when OVD_BLAINE_WINDOW=1, or when the current branch's PR carries the
 * `blaine-window` label. Anything else (no PR, gh missing, offline) fails closed.
 * Reads are never blocked. Exit 2 + stderr blocks the tool call.
 *
 * Tests inject a fake gh via OVD_GUARD_GH_BIN.
 */
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOW_LABEL = "blaine-window";
export const OVERRIDE_ENV = "OVD_BLAINE_WINDOW";
export const GH_BIN_ENV = "OVD_GUARD_GH_BIN";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MIGRATIONS_RE = /(^|\/)supabase\/migrations(\/|$)/;

export function isMigrationPath(path, cwd = process.cwd()) {
  if (typeof path !== "string" || path === "") return false;
  const normalized = path.replace(/\\/g, "/");
  const absolute = isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
  return MIGRATIONS_RE.test(absolute.replace(/\\/g, "/"));
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

/** Paths a single command (argv) would write, by command name. */
function commandWriteTargets(argv) {
  const [name, ...args] = argv;
  switch (name) {
    case "tee":
    case "touch":
    case "rm":
    case "truncate":
    case "mv":
      return positional(args);
    case "cp":
    case "install":
    case "rsync": {
      const dirFlag = args.findIndex((arg) => arg === "-t" || arg === "--target-directory");
      if (dirFlag !== -1 && args[dirFlag + 1]) return [args[dirFlag + 1]];
      const rest = positional(args);
      return rest.length > 0 ? [rest[rest.length - 1]] : [];
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

/** Every path a Bash command line would write to (redirect targets plus known writers). */
export function bashWriteTargets(command, cwd = process.cwd()) {
  const targets = [];
  let currentCwd = cwd;
  for (const segment of splitSegments(tokenize(command))) {
    const argv = [];
    for (let i = 0; i < segment.length; i++) {
      const token = segment[i];
      if (token.type === "redirect") {
        const next = segment[i + 1];
        if (next?.type === "word") {
          i++;
          if (token.value.startsWith(">") && !token.value.endsWith("&") && !next.value.startsWith("&")) {
            targets.push(resolve(currentCwd, next.value));
          }
        }
      } else {
        argv.push(token.value);
      }
    }
    while (argv.length > 0 && (/^\w+=/.test(argv[0]) || ["sudo", "command", "env", "xargs"].includes(argv[0]))) {
      argv.shift();
    }
    if (argv[0] === "cd" && argv[1]) {
      currentCwd = resolve(currentCwd, argv[1]);
      continue;
    }
    if (["bash", "sh", "zsh"].includes(argv[0]) && argv[1] === "-c" && argv[2]) {
      targets.push(...bashWriteTargets(argv[2], currentCwd));
      continue;
    }
    for (const target of commandWriteTargets(argv)) targets.push(resolve(currentCwd, target));
  }
  return targets;
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

/** Returns { ok: true, number, labels } or { ok: false, error }. Never throws. */
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
    return { ok: true, number: parsed.number, labels: (parsed.labels ?? []).map((label) => label.name) };
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim().split("\n")[0];
    return { ok: false, error: detail };
  }
}

/** Pure decision given injected lookups. Returns { allow: true } or { allow: false, reason }. */
export function decide(payload, { env = process.env, branch = null, viewPr = () => ({ ok: false, error: "gh not called" }) } = {}) {
  const targets = migrationWriteTargets(payload);
  if (targets.length === 0) return { allow: true };
  if (env[OVERRIDE_ENV] === "1") return { allow: true };

  const pr = viewPr();
  if (pr.ok && pr.labels.includes(WINDOW_LABEL)) return { allow: true };

  const key = linearKeyFromBranch(branch);
  const item = key ? `work item ${key}` : `branch ${branch ?? "(unknown)"} (no Linear key found in branch name)`;
  const status = pr.ok
    ? `PR #${pr.number} does not have the "${WINDOW_LABEL}" label`
    : `could not confirm a PR with the "${WINDOW_LABEL}" label (${pr.error || "gh failed"}); failing closed`;
  const reason = [
    `Blocked: write to supabase/migrations/ for ${item}.`,
    `Targets: ${targets.join(", ")}`,
    `Reason: ${status}.`,
    "Migration changes require a Blaine window. To proceed, either:",
    `  - open a PR for this branch and have Blaine apply the "${WINDOW_LABEL}" label, or`,
    `  - have Blaine start the session with ${OVERRIDE_ENV}=1.`,
    "Do not work around this guard; stop and report the blocked migration write instead.",
  ].join("\n");
  return { allow: false, reason };
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
  if (migrationWriteTargets(payload).length === 0) return 0;
  const cwd = payload.cwd || process.cwd();
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
