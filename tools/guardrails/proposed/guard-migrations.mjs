#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for Bash, file edit and MCP calls. Best effort only.
 *
 * The real gates are elsewhere: the permission deny rules in
 * .claude/settings.json (Edit on supabase/migrations/** and on the guard
 * files themselves, and the hosted Supabase write tools), the rule that
 * workers never merge, and Blaine's explicit yes for anything under
 * supabase/migrations/. A determined agent can get past this hook.
 *
 * It blocks:
 * - Edit, Write, MultiEdit and NotebookEdit on any path under
 *   supabase/migrations/ (worktrees included), .claude/hooks/ or
 *   .claude/settings*.json;
 * - obvious Bash writes to those paths (redirects, tee, cp and mv
 *   destinations, sed -i, git checkout/restore with a pathspec that could
 *   cover them, git apply of a patch that names them, and so on), any pipe
 *   into a shell, decoded or generated text run by an interpreter, and shell
 *   scripts whose text does any of that;
 * - supabase CLI commands that create migration files or change a hosted
 *   project, also when reached through npm, yarn or pnpm run <script>;
 * - psql and other Postgres clients against a host that is not local,
 *   unless they run read only SQL, and HTTP writes to Supabase APIs;
 * - hosted Supabase write tools under any MCP server name, and execute_sql
 *   unless it is a single read only statement;
 * - merges and auto merges of a PR whose changed files (renames included)
 *   touch supabase/migrations/, failing closed when the files cannot be
 *   listed.
 * Reads pass. Commit messages, gh --body/--title text and gh api comment
 * fields are never scanned. Residuals are listed in
 * guard-migrations.node-test.mjs.
 *
 * Exit 2 with a reason on stderr blocks the call. Missing tool_input
 * fails closed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUB = "\u0001";
const SCRIPT_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);
const SHELLS = new Set([...SCRIPT_SHELLS, "tcsh", "csh", "fish", "busybox", "eval", "source", "."]);
const INTERPRETERS = new Set([...SHELLS, "perl", "python", "python3", "node", "ruby", "php", "deno", "bun"]);
const READERS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "less", "more", "stat", "file", "diff", "find", "sort", "uniq", "nl",
  "md5sum", "sha256sum", "shasum", "cmp", "echo", "printf", "realpath", "dirname", "basename", "test", "[", "true",
]);
// Commands for which a bare "supabase" or ".claude" word (or a glob that could expand to it) means the directory.
const FILE_WRITERS = new Set(["cp", "mv", "rm", "rmdir", "rsync", "ln", "install", "tar", "unzip", "touch", "mkdir", "chmod", "chown", "truncate", "dd", "tee", "shred", "git"]);
const COPY_COMMANDS = new Set(["cp", "rsync", "install"]);
const GIT_READERS = new Set(["log", "show", "status", "blame", "diff", "grep", "ls-files", "add", "fetch", "rev-parse", "branch", "remote", "config", "describe", "shortlog", "cat-file", "ls-tree", "merge-base"]);
const WRAPPERS = new Set(["env", "sudo", "command", "exec", "nohup", "time", "nice", "timeout", "xargs", "stdbuf"]);
const VALUE_FLAGS = new Set(["-I", "-n", "-P", "-L", "-d", "-s", "-u", "-g"]);
const GH_TEXT_FLAGS = new Set(["--body", "-b", "--title", "-t", "--notes", "--message", "-m"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Hosted Supabase write tools. The first set has no namesake on the GitHub or Vercel servers.
const SUPABASE_ONLY_TOOLS = new Set(["apply_migration", "merge_branch", "reset_branch", "rebase_branch", "deploy_edge_function", "create_edge_function_secret", "restore_project"]);
const SHARED_NAME_TOOLS = new Set(["create_branch", "delete_branch", "pause_project", "create_project"]);
const KNOWN_SUPABASE_SERVERS = new Set(["fb51b900-5d04-4884-9f50-844879db0029"]);
const MERGE_TOOLS = new Set(["merge_pull_request", "enable_pr_auto_merge", "merge_diff"]);
// MCP tools that write repository or file content; only their path fields are checked.
const FILE_WRITE_TOOLS = /^(push_files|create_or_update_file|delete_file|create_file|update_file|write_file|edit_file|move_file|copy_file|upload_file|create_tree|create_blob)$/;
const SQL_FIRST_WORDS = new Set(["select", "with", "show", "explain", "table"]);
const SQL_WRITE_WORDS =
  /\b(insert|update|delete|merge|alter|create|drop|grant|revoke|truncate|copy|call|do|set|refresh|vacuum|lock|into|analy[sz]e|execute)\b|\bcomment\s+on\b|\bsecurity\s+label\b/i;
const SQL_SIDE_EFFECTS =
  /\b(nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_promote|pg_notify|pg_advisory\w*|pg_create_\w+|pg_drop_\w+|pg_replication_\w+|lo_\w+|dblink\w*|http_\w+|resolve|create_secret|update_secret|schedule|unschedule)\s*\(/i;
const PROTECTED_TEXT = /supabase\W+migrations|\.claude\W+(hooks|settings)/i;
const PG_CLIENTS = /^(psql|pgcli|pg_restore|createdb|dropdb|createuser|dropuser|vacuumdb|reindexdb|clusterdb)$/;
const SUPABASE_HTTP = /supabase\.(co|in|com)\b|\$\{?SUPABASE_\w*URL|\/(rest|auth|storage|graphql|pg)\/v1\b/i;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|\[::1\]|host\.docker\.internal|\/.*)$/i;
const GH_TIMEOUT_MS = 6000;
// gh is run from a fixed install location rather than looked up on PATH.
const GH_CANDIDATES = ["/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/usr/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"];

function indexOrEnd(src, text, from) {
  const at = src.indexOf(text, from);
  return at === -1 ? src.length : at;
}

/** Index of the close that matches src[i], skipping quotes, escapes and heredoc bodies. */
function matchClose(src, i, open, close) {
  const docs = [];
  for (let depth = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'") i = indexOrEnd(src, "'", i + 1);
    else if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      const m = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(src.slice(i));
      if (m) docs.push(m[2]);
      i += m ? m[0].length - 1 : 1;
    } else if (c === "\n" && docs.length > 0) {
      for (const delim of docs.splice(0)) {
        while (i < src.length) {
          const eol = indexOrEnd(src, "\n", i + 1);
          const line = src.slice(i + 1, eol);
          i = eol;
          if (line.replace(/^\t+/, "") === delim) break;
        }
      }
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return src.length;
}

const ANSI_ESCAPES = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** Decodes the body of a $'...' word starting after the opening quote; returns [text, index after the closing quote]. */
function ansiC(src, i) {
  let out = "";
  while (i < src.length && src[i] !== "'") {
    if (src[i] !== "\\") {
      out += src[i++];
      continue;
    }
    const esc = src[i + 1] ?? "";
    const hex = /^(?:x([\da-fA-F]{1,2})|u([\da-fA-F]{1,4})|U([\da-fA-F]{1,8})|([0-7]{1,3}))/.exec(src.slice(i + 1));
    if (hex) {
      const code = hex[4] === undefined ? parseInt(hex[1] ?? hex[2] ?? hex[3], 16) : parseInt(hex[4], 8);
      out += String.fromCodePoint(code);
      i += 1 + hex[0].length;
    } else {
      out += ANSI_ESCAPES[esc] ?? `\\${esc}`;
      i += 2;
    }
  }
  return [out, i + 1];
}

/** Shell lexer: returns segments ({ words, outs, ins, heredocs, op }) and the bodies of $( ), backticks and <( ). */
function parse(src) {
  const newSegment = (op) => ({ words: [], outs: [], ins: [], heredocs: [], op });
  const segments = [newSegment(null)];
  const substs = [];
  const pendingDocs = [];
  let word = null;
  let redirect = null;
  const seg = () => segments.at(-1);
  const add = (text) => (word = (word ?? "") + text);
  const flush = () => {
    if (word === null) return;
    if (redirect === ">") seg().outs.push(word);
    else if (redirect === "<") seg().ins.push(word);
    else if (redirect === "<<<") seg().heredocs.push(word);
    else seg().words.push(word);
    word = null;
    redirect = null;
  };
  const subst = (start, end, skip) => {
    substs.push(src.slice(start + skip, end));
    add(SUB);
    return end + 1;
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "'") {
      const end = indexOrEnd(src, "'", i + 1);
      add(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === "$" && next === "'") {
      const [text, end] = ansiC(src, i + 2);
      add(text);
      i = end;
    } else if (c === "\\") {
      if (next !== "\n") add(next ?? "");
      i += 2;
    } else if (c === '"') {
      add("");
      for (i++; i < src.length && src[i] !== '"'; ) {
        if (src[i] === "\\") {
          add('$`"\\'.includes(src[i + 1]) ? src[i + 1] : src.slice(i, i + 2));
          i += 2;
        } else if (src[i] === "$" && src[i + 1] === "(") i = subst(i, matchClose(src, i + 1, "(", ")"), 2);
        else if (src[i] === "`") i = subst(i, indexOrEnd(src, "`", i + 1), 1);
        else add(src[i++]);
      }
      i++;
    } else if (c === "$" && next === "(") {
      i = subst(i, matchClose(src, i + 1, "(", ")"), 2);
    } else if (c === "`") {
      i = subst(i, indexOrEnd(src, "`", i + 1), 1);
    } else if ((c === "<" || c === ">") && next === "(") {
      i = subst(i, matchClose(src, i + 1, "(", ")"), 2);
    } else if (c === "<" && next === "<" && src[i + 2] !== "<") {
      flush();
      const m = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(src.slice(i));
      if (m) pendingDocs.push({ delim: m[2], quoted: m[1] !== "", segment: seg() });
      i += m ? m[0].length : 2;
    } else if (c === ">" || c === "<" || (c === "&" && next === ">")) {
      if (word !== null && /^\d+$/.test(word)) word = null;
      flush();
      const m = /^(&>>?|>>|>\||>&|<>|<&|<<<|>|<)/.exec(src.slice(i));
      if (m[0] === "<<<") redirect = "<<<";
      else redirect = m[0].includes(">") && m[0] !== ">&" ? ">" : "<";
      i += m[0].length;
    } else if (c === "\n" && pendingDocs.length > 0) {
      flush();
      i++;
      for (const doc of pendingDocs.splice(0)) {
        const lines = [];
        while (i < src.length) {
          const eol = indexOrEnd(src, "\n", i);
          const line = src.slice(i, eol);
          i = eol + 1;
          if (line.replace(/^\t+/, "") === doc.delim) break;
          lines.push(line);
        }
        const body = lines.join("\n");
        doc.segment.heredocs.push(body);
        if (!doc.quoted) for (const m of body.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) substs.push(m[1] ?? m[2]);
      }
      segments.push(newSegment("\n"));
    } else if (/[;&|()\n]/.test(c)) {
      flush();
      const op = /^(&&|\|\||\|&|[;&|()\n])/.exec(src.slice(i))[0];
      segments.push(newSegment(op));
      i += op.length;
    } else if (/\s/.test(c)) {
      flush();
      i++;
    } else {
      add(c);
      i++;
    }
  }
  flush();
  return { segments: segments.filter((s) => s.words.length > 0 || s.outs.length > 0 || s.ins.length > 0), substs };
}

/** Expands $VAR and ${VAR} with the value assigned most recently before the reference. */
function expandVars(src) {
  const vars = {};
  const assignOrRef = /(^|[\s;&|(])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]*)|\$\{?([A-Za-z_]\w*)\}?/g;
  return src.replace(assignOrRef, (all, lead, name, value, ref) => {
    if (name !== undefined) {
      vars[name] = value.replace(/^["']|["']$/g, "").replace(/\$\{?([A-Za-z_]\w*)\}?/g, (ref2, n) => vars[n] ?? ref2);
      return all;
    }
    return ref in vars ? vars[ref] : all;
  });
}

const base = (word = "") => word.split("/").pop();
const isAssignment = (w) => /^[A-Za-z_]\w*=/.test(w);

/** Strips leading assignments and wrapper commands; returns the argv, the wrappers seen and the assignments. */
function unwrap(words) {
  const env = {};
  let argv = [...words];
  const wrappers = new Set();
  const takeAssignments = () => {
    while (argv.length > 0 && isAssignment(argv[0])) {
      const at = argv[0].indexOf("=");
      env[argv[0].slice(0, at)] = argv[0].slice(at + 1);
      argv = argv.slice(1);
    }
  };
  takeAssignments();
  while (WRAPPERS.has(base(argv[0]))) {
    const wrapper = base(argv[0]);
    wrappers.add(wrapper);
    const isOption = (w) => w.startsWith("-") || isAssignment(w) || (wrapper === "timeout" && /^\d/.test(w));
    let i = 1;
    for (; i < argv.length && isOption(argv[i]); i += VALUE_FLAGS.has(argv[i]) ? 2 : 1) {
      if (isAssignment(argv[i])) {
        const at = argv[i].indexOf("=");
        env[argv[i].slice(0, at)] = argv[i].slice(at + 1);
      }
    }
    argv = argv.slice(i);
    takeAssignments();
  }
  return { argv, wrappers, env };
}

function globEq(pattern, name) {
  if (!/[*?[{]/.test(pattern)) return pattern.toLowerCase() === name;
  let re = "";
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const close = c === "[" ? pattern.indexOf("]", i + 2) : -1;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (close > 0) {
      re += `[${pattern.slice(i + 1, close).replace(/^!/, "^").replaceAll("\\", "\\\\")}]`;
      i = close;
    } else if (c === "{") {
      re += "(?:";
      depth++;
    } else if (c === "}" && depth > 0) {
      re += ")";
      depth--;
    } else if (c === "," && depth > 0) re += "|";
    else re += c.replace(/[.+^$()|\\[\]]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`, "i").test(name);
  } catch {
    return true;
  }
}

const pairAt = (segs, first, seconds) => segs.some((s, i) => globEq(s, first) && segs[i + 1] !== undefined && seconds.some((n) => globEq(segs[i + 1], n)));
const inMigrations = (segs) => pairAt(segs, "supabase", ["migrations"]);
const inGuardFiles = (segs) => pairAt(segs, ".claude", ["hooks", "settings.json", "settings.local.json"]);

function changeDir(dir, target) {
  if (!target || target === "-" || target.startsWith("~")) return dir;
  const next = target.startsWith("/") ? [] : [...dir];
  for (const part of target.split("/")) {
    if (part === "..") next.pop();
    else if (part && part !== ".") next.push(part);
  }
  return next;
}

const pathOf = (dir, word) => `/${changeDir(dir, word).join("/")}`;

/**
 * Names the protected area a word points at from dir, or null. Paths are
 * normalized first, so supabase/migrations/../../docs/x.md is not a hit.
 * With wholeDir a word naming the supabase or .claude directory itself
 * also counts, which matters only for commands that write files.
 */
function protectedName(word, dir, wholeDir = false) {
  if (word.includes(SUB)) return null;
  const home = /^(~|\$\{?HOME\}?)\//.exec(word);
  const segs = home ? ["~", ...changeDir([], word.slice(home[0].length))] : changeDir(dir, word);
  const joined = segs.join("/");
  const last = segs.at(-1) ?? "";
  const named = word.split("/").some(Boolean);
  if (/supabase\/+migrations(\/|$)/i.test(joined) || inMigrations(segs) || (wholeDir && named && globEq(last, "supabase"))) return "supabase/migrations";
  if (/\.claude\/(hooks\b|settings[\w.-]*\.json)/i.test(joined) || inGuardFiles(segs) || (wholeDir && named && globEq(last, ".claude"))) {
    return "the .claude guard files";
  }
  return null;
}

function readerWrites(cmd, args) {
  if (cmd === "find") return args.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(w));
  if (cmd === "sort" || cmd === "diff") return args.some((w) => /^--output|^-[a-zA-Z]*o/.test(w));
  if (cmd === "uniq") return args.filter((w) => w === "-" || !w.startsWith("-")).length >= 2;
  if (cmd === "file") return args.some((w) => w === "-C" || w === "--compile");
  if (cmd === "less" || cmd === "more") return args.some((w) => w.startsWith("+"));
  if (cmd === "rg") return args.some((w) => w.startsWith("--pre"));
  return false;
}

/** git commit arguments with message text and pathspecs after -- removed. */
function commitArgs(argv) {
  const out = [];
  for (let i = 2; i < argv.length && argv[i] !== "--"; i++) {
    const w = argv[i];
    if (w === "--message" || /^-[a-zA-Z]*m$/.test(w)) i++;
    else if (!w.startsWith("--message=") && !/^-[a-zA-Z]*m./.test(w)) out.push(w);
  }
  return out;
}

/** gh arguments with the values of text flags (--body, --title, -m and so on) removed. */
function ghArgs(argv) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i];
    if (GH_TEXT_FLAGS.has(w)) i++;
    else if (![...GH_TEXT_FLAGS].some((flag) => flag.startsWith("--") && w.startsWith(`${flag}=`))) out.push(w);
  }
  return out;
}

/** Reads a file named in a command, resolved from dir; null when it cannot be read. */
function readNamed(word, dir) {
  if (!word || word.includes(SUB) || word === "-") return null;
  try {
    return readFileSync(word.startsWith("/") ? word : pathOf(dir, word), "utf8");
  } catch {
    return null;
  }
}

/** Arguments after the supabase CLI name, or null when the command is not the supabase CLI. */
function supabaseCli(argv) {
  const cmd = base(argv[0]);
  if (cmd === "supabase") return argv.slice(1);
  if (!/^(npx|bunx|pnpx|npm|yarn|pnpm|bun)$/.test(cmd)) return null;
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i];
    if (/^(-p|--package)$/.test(w) && /^supabase(@.*)?$/.test(argv[i + 1] ?? "")) {
      const rest = argv.slice(i + 2).filter((a) => a !== "--" && !a.startsWith("-"));
      return rest[0] === "supabase" ? argv.slice(argv.indexOf("supabase", i + 2) + 1) : argv.slice(i + 2);
    }
    if (w.startsWith("-") || ["run", "run-script", "exec", "dlx", "x"].includes(w)) continue;
    return /^supabase(@.*)?$/.test(base(w)) ? argv.slice(i + 1).filter((a) => a !== "--") : null;
  }
  return null;
}

const SUPABASE_WRITES = {
  migration: ["new", "squash", "fetch", "repair"],
  db: ["push", "pull"],
  functions: ["deploy", "delete"],
  secrets: ["set", "unset"],
  branches: ["create", "delete", "update", "disable"],
  projects: ["create", "delete"],
  config: ["push"],
};
const SUPABASE_HOSTED_READS = { db: ["dump", "diff", "lint", "inspect"], migration: ["list"] };

/** Block reason for supabase CLI calls that write migration files or change a hosted project. */
function supabaseReason(args) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (/^(--workdir|--profile|--output|-o|--dns-resolver|--network-id|--db-url|--project-ref|-p|--password)$/.test(args[i])) i++;
    else if (!args[i].startsWith("-")) positional.push(args[i]);
  }
  const [group, action] = positional;
  const hosted = args.some((w) => /^--(linked|db-url|project-ref)(=|$)/.test(w));
  if (SUPABASE_WRITES[group]?.includes(action)) return `supabase ${group} ${action} would create a migration or change a hosted project`;
  if (group === "db" && action === "diff" && args.some((w) => /^(-f|--file)/.test(w))) return "supabase db diff -f would write a migration file";
  if (hosted && (group === "db" || group === "migration") && !SUPABASE_HOSTED_READS[group].includes(action)) {
    return `${["supabase", group, action].filter(Boolean).join(" ")} would change a hosted database`;
  }
  return null;
}

function nearestPackage(dir) {
  for (let segs = [...dir]; ; segs.pop()) {
    const file = `/${[...segs, "package.json"].join("/")}`;
    if (existsSync(file)) {
      try {
        return { scripts: JSON.parse(readFileSync(file, "utf8")).scripts ?? {}, segs };
      } catch {
        return null;
      }
    }
    if (segs.length === 0) return null;
  }
}

const NPM_SCRIPT_ALIASES = { t: "test", tst: "test", test: "test", start: "start", stop: "stop", restart: "restart" };
const YARN_PNPM_BUILTINS = new Set([
  "add", "install", "i", "remove", "rm", "upgrade", "update", "up", "why", "info", "init", "dlx", "exec", "workspace", "workspaces",
  "config", "cache", "bin", "create", "global", "link", "unlink", "pack", "publish", "version", "node", "set", "constraints", "plugin",
  "outdated", "list", "ls", "audit", "store", "import", "patch", "prune", "rebuild", "env", "setup", "licenses", "fetch", "deploy",
]);
const DIR_FLAGS = /^(--prefix|-C|--dir|--cwd|-w|--workspace)$/;

/** The script, its package directory and extra arguments for npm, yarn or pnpm running a package.json script, or null. */
function scriptCall(argv, dir) {
  const cmd = base(argv[0]);
  if (!/^(npm|yarn|pnpm)$/.test(cmd)) return null;
  let pkgDir = dir;
  let i = 1;
  const nextPositional = () => {
    while (i < argv.length && argv[i].startsWith("-")) {
      const flag = /^(--[\w-]+)=(.*)$/.exec(argv[i]);
      if (flag && DIR_FLAGS.test(flag[1])) pkgDir = changeDir(dir, flag[2]);
      if (DIR_FLAGS.test(argv[i])) pkgDir = changeDir(dir, argv[++i] ?? "");
      else if (argv[i] === "--filter") i++;
      i++;
    }
    return argv[i++];
  };
  const sub = nextPositional();
  if (sub === undefined) return null;
  let name;
  if (["run", "run-script", "rum", "urn"].includes(sub)) name = nextPositional();
  else if (cmd === "npm") name = NPM_SCRIPT_ALIASES[sub];
  else if (!YARN_PNPM_BUILTINS.has(sub)) name = sub;
  if (!name) return null;
  return { name, dir: pkgDir, extra: argv.slice(i).filter((w) => w !== "--") };
}

function scriptBodies(call) {
  const pkg = nearestPackage(call.dir);
  const main = pkg?.scripts[call.name];
  if (typeof main !== "string") return { bodies: [], segs: call.dir };
  const quoted = call.extra.map((w) => `'${w.replaceAll("'", "'\\''")}'`).join(" ");
  const bodies = [pkg.scripts[`pre${call.name}`], `${main} ${quoted}`.trim(), pkg.scripts[`post${call.name}`]].filter((s) => typeof s === "string");
  return { bodies, segs: pkg.segs };
}

const MERGE_ROUTE = /(?:^|\/)repos\/([^/\s]+)\/([^/\s]+)\/pulls\/(\d+)\/(?:ccr\/)?(merge|auto[_-]?merge)\/?(?:[?#].*)?$/;

/** Route, method, field words and --input file of a gh api call. */
function ghApiCall(argv) {
  const call = { route: undefined, method: undefined, fields: [], input: undefined };
  for (let i = 2; i < argv.length; i++) {
    const w = argv[i];
    if (w === "-X" || w === "--method") call.method = argv[++i];
    else if (/^-X./.test(w)) call.method = w.slice(2);
    else if (w.startsWith("--method=")) call.method = w.slice(9);
    else if (w === "--input") call.input = argv[++i] ?? "-";
    else if (/^(-f|-F|--field|--raw-field)$/.test(w)) call.fields.push(argv[++i] ?? "");
    else if (/^(-H|--header|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)$/.test(w)) i++;
    else if (!w.startsWith("-") && call.route === undefined) call.route = w.replace(/^\//, "");
  }
  const hasBody = call.fields.length > 0 || call.input !== undefined;
  call.method = (call.method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  return call;
}

const fillRepo = (owner, repo, env) => {
  const [envOwner, envRepo] = (env.GH_REPO ?? "").split("/").slice(-2);
  return { owner: owner === "{owner}" && envOwner ? envOwner : owner, repo: repo === "{repo}" && envRepo ? envRepo : repo };
};

/** A merge or auto merge request in a Bash command, or null. */
function mergeTarget(argv, env, dir) {
  const cmd = base(argv[0]);
  if (cmd === "gh" && argv[1] === "pr" && argv[2] === "merge") {
    if (argv.includes("--disable-auto")) return null;
    const target = { selector: undefined, repoFlag: env.GH_REPO, sha: undefined };
    for (let i = 3; i < argv.length; i++) {
      const w = argv[i];
      if (w === "-R" || w === "--repo") target.repoFlag = argv[++i];
      else if (w.startsWith("--repo=")) target.repoFlag = w.slice(7);
      else if (w === "--match-head-commit") target.sha = argv[++i];
      else if (w.startsWith("--match-head-commit=")) target.sha = w.slice(20);
      else if (/^(-b|--body|-F|--body-file|-t|--subject|-A|--author-email)$/.test(w)) i++;
      else if (!w.startsWith("-") && target.selector === undefined) target.selector = w;
    }
    return target;
  }
  if (cmd === "gh" && argv[1] === "api") {
    const call = ghApiCall(argv);
    if (call.route === "graphql") {
      const text = [...call.fields, call.input === undefined ? "" : (readNamed(call.input, dir) ?? "\0unreadable")].join("\n");
      if (text.includes("\0unreadable")) return { graphql: "a GraphQL --input file that cannot be read" };
      return /enablePullRequestAutoMerge|mergePullRequest/i.test(text) ? { graphql: "a GraphQL merge mutation" } : null;
    }
    const m = MERGE_ROUTE.exec(call.route ?? "");
    // DELETE on an auto merge route turns auto merge off.
    if (!m || call.method === "GET" || call.method === "DELETE") return null;
    return { ...fillRepo(m[1], m[2], env), number: m[3] };
  }
  if (/^(curl|wget|http|https)$/.test(cmd)) {
    if (argv.some((w, i) => /^(-X|--request)$/.test(w) && /^(get|delete)$/i.test(argv[i + 1] ?? ""))) return null;
    for (const w of argv) {
      const m = MERGE_ROUTE.exec(w.replace(/^https?:\/\/[^/]+/, ""));
      if (m) return { owner: m[1], repo: m[2], number: m[3] };
    }
  }
  return null;
}

/** Block reason for gh api calls that write repository content under a protected path. Comment and review routes pass. */
function ghApiReason(argv, dir) {
  const call = ghApiCall(argv);
  if (call.method === "GET" || call.route === undefined) return null;
  const contents = /^repos\/[^/]+\/[^/]+\/contents\/(.+?)(?:[?#].*)?$/.exec(call.route);
  if (contents && protectedName(decodeURIComponent(contents[1]), [], true)) return `gh api would write ${protectedName(decodeURIComponent(contents[1]), [], true)} through the contents API`;
  if (/^repos\/[^/]+\/[^/]+\/git\/(trees|blobs|commits)/.test(call.route)) {
    const text = [...call.fields, call.input === undefined ? "" : (readNamed(call.input, dir) ?? "\0unreadable")].join("\n");
    if (text.includes("\0unreadable")) return "gh api git data call reads an --input file that cannot be read; failing closed";
    if (PROTECTED_TEXT.test(text)) return "gh api git data call names a protected path";
  }
  return null;
}

function runGh(args, cwd) {
  const gh = GH_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!gh) throw new Error(`gh not found in ${GH_CANDIDATES.join(", ")}`);
  const result = spawnSync(gh, args, { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS });
  if (result.error) throw new Error(result.error.code === "ETIMEDOUT" ? "gh timed out" : `gh failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh exited ${String(result.status)}: ${(result.stderr || "").trim().split("\n")[0]}`);
  return result.stdout;
}

const PR_URL = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/** Default lookup of a PR's changed files (renamed from paths included) and head SHA with the gh CLI. Throws when they cannot be listed. */
export function ghPrFiles(target, cwd) {
  let { owner, repo, number } = target;
  let host;
  const url = PR_URL.exec(target.selector ?? "");
  if (number === undefined && url) [, host, owner, repo, number] = url;
  if (number === undefined && /^#?\d+$/.test(target.selector ?? "")) {
    // A bare number resolves over REST; gh pr view needs GraphQL, which some sessions cannot reach.
    const parts = (target.repoFlag ?? "{owner}/{repo}").split("/");
    [owner, repo] = parts.slice(-2);
    if (parts.length === 3) host = parts[0];
    number = target.selector.replace("#", "");
  }
  if (number === undefined) {
    const args = ["pr", "view", ...(target.selector ? [target.selector] : []), ...(target.repoFlag ? ["-R", target.repoFlag] : []), "--json", "url", "--jq", ".url"];
    const viewed = runGh(args, cwd).trim();
    const m = PR_URL.exec(viewed);
    if (!m) throw new Error(`gh pr view returned no PR URL (${viewed || "empty"})`);
    [, host, owner, repo, number] = m;
  }
  const hostArgs = host && host !== "github.com" ? ["--hostname", host] : [];
  const route = `repos/${owner}/${repo}/pulls/${number}`;
  const headSha = runGh(["api", ...hostArgs, route, "--jq", ".head.sha"], cwd).trim();
  const out = runGh(["api", ...hostArgs, "--paginate", `${route}/files`, "--jq", ".[] | .filename, (.previous_filename // empty)"], cwd);
  return { files: out.split("\n").filter(Boolean), headSha };
}

function mergeReason(target, ctx) {
  if (target.graphql) return `${target.graphql} hides which PR it merges, so its changed files cannot be checked; use gh pr merge`;
  let result;
  try {
    result = ctx.prFiles(target, ctx.cwd);
  } catch (error) {
    return `could not list the PR's changed files to check for supabase/migrations/ (${error.message}); failing closed`;
  }
  const files = Array.isArray(result) ? result : result?.files;
  if (!Array.isArray(files)) return "PR file lookup returned no list; failing closed";
  if (target.sha && result?.headSha && !result.headSha.startsWith(target.sha)) return `the PR head is ${result.headSha}, not the ${target.sha} this merge names; failing closed`;
  return files.some((f) => protectedName(f, [], false) === "supabase/migrations") ? "this PR changes files under supabase/migrations/, so merging it needs Blaine's explicit yes" : null;
}

/** True when a git pathspec could cover a protected path from dir. */
function broadPathspec(spec, dir) {
  if (protectedName(spec, dir, true)) return true;
  if (spec.startsWith(":") || /^[*?[]/.test(spec) || spec === "." || spec === "./") return true;
  const segs = changeDir(dir, spec);
  return segs.length <= dir.length && segs.every((s, i) => s === dir[i]);
}

function patchReason(files, dir, what) {
  if (files.length === 0) return `${what} reads a patch from stdin, which cannot be checked; failing closed`;
  for (const file of files) {
    const text = readNamed(file, dir);
    if (text === null) return `${what} patch ${file} cannot be read to check it; failing closed`;
    if (PROTECTED_TEXT.test(text)) return `${what} patch ${file} changes a protected path`;
  }
  return null;
}

function gitReason(argv, segment, dir) {
  const sub = argv[1];
  const args = argv.slice(2);
  if (sub === "commit") return commitArgs(argv).some((w) => protectedName(w, dir, true)) ? "git commit reads or writes a protected file" : null;
  const output = args.find((w) => w.startsWith("--output"));
  if (output) return protectedName(output.replace(/^--output=?/, "") || args[args.indexOf(output) + 1] || "", dir, true) ? "git writes output to a protected path" : null;
  if (GIT_READERS.has(sub)) return null;
  if (sub === "apply" || sub === "am") {
    if (args.some((w) => /^--(abort|skip|quit|continue|show-current-patch)$/.test(w))) return null;
    if (sub === "apply" && args.some((w) => /^--(check|stat|numstat|summary)$/.test(w)) && !args.includes("--apply")) return null;
    return patchReason([...args.filter((w) => !w.startsWith("-")), ...segment.ins], dir, `git ${sub}`);
  }
  if (sub === "checkout" || sub === "restore") {
    const dash = args.indexOf("--");
    let specs;
    if (dash >= 0) specs = args.slice(dash + 1);
    else {
      const positional = args.filter((w, i) => !w.startsWith("-") && !/^(-s|--source)$/.test(args[i - 1] ?? ""));
      specs = sub === "restore" ? positional : positional.slice(1);
      // A lone checkout argument is a branch unless it is a path that could cover a protected file.
      if (sub === "checkout" && positional.length === 1 && broadPathspec(positional[0], dir)) specs = positional;
    }
    return specs.some((s) => broadPathspec(s, dir)) ? `git ${sub} pathspec could overwrite a protected path` : null;
  }
  return args.some((w) => protectedName(w, dir, true)) ? `git ${sub} would write ${args.map((w) => protectedName(w, dir, true)).find(Boolean)}` : null;
}

/** The host a Postgres client connects to: a host name, "local", or "unknown". */
function pgHost(argv, env) {
  const hosts = [];
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i];
    if (w === "-h" || w === "--host") hosts.push(argv[++i] ?? "");
    else if (w.startsWith("--host=")) hosts.push(w.slice(7));
    else if (/^postgres(ql)?:\/\//i.test(w) || /\bhost=/.test(w) || /^\$/.test(w)) hosts.push(w);
    else if ((w === "-d" || w === "--dbname") && /[:=/$]/.test(argv[i + 1] ?? "")) hosts.push(argv[++i]);
  }
  const fromEnv = env.PGHOST ?? process.env.PGHOST ?? (env.PGSERVICE ?? process.env.PGSERVICE ? "$PGSERVICE" : undefined);
  if (hosts.length === 0 && fromEnv) hosts.push(fromEnv);
  if (hosts.length === 0) return "local";
  for (const raw of hosts) {
    if (raw.includes("$") || raw.includes(SUB)) return "unknown";
    const host = /^postgres(?:ql)?:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?]+)/i.exec(raw)?.[1] ?? /\bhost=(\S+)/.exec(raw)?.[1] ?? raw;
    if (!LOCAL_HOST.test(host)) return host;
  }
  return "local";
}

function pgReason(argv, env) {
  const cmd = base(argv[0]);
  const host = pgHost(argv, env);
  if (host === "local") return null;
  if (cmd !== "psql" && cmd !== "pgcli") return `${cmd} against ${host} would change a database that is not local`;
  if (argv.some((w) => /^(-f|--file)(=|$)/.test(w))) return `psql -f against ${host} cannot be checked; failing closed`;
  const commands = argv.flatMap((w, i) => (/^(-c|--command)$/.test(w) ? [argv[i + 1] ?? ""] : w.startsWith("--command=") ? [w.slice(10)] : []));
  if (commands.length === 0) return `psql against ${host} without -c reads SQL that cannot be checked; failing closed`;
  for (const sql of commands) {
    const reason = sqlReason(sql);
    if (reason) return `psql against ${host}: ${reason.replace("execute_sql ", "")}`;
  }
  return null;
}

/** Block reason for HTTP writes (anything but GET or HEAD) to a Supabase API that is not local. */
function supabaseHttpReason(argv) {
  const cmd = base(argv[0]);
  const urls = argv.filter((w) => SUPABASE_HTTP.test(w) && !/^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|host\.docker\.internal)\b/i.test(w));
  if (urls.length === 0) return null;
  let method = "GET";
  if (cmd === "curl") {
    const explicit = argv.find((w, i) => /^(-X|--request)$/.test(argv[i - 1] ?? "")) ?? argv.find((w) => /^-X\w/.test(w))?.slice(2);
    if (argv.some((w) => /^(-d|--data.*|-F|--form.*|--json|-T|--upload-file)$/.test(w) || /^-d./.test(w))) method = "POST";
    if (argv.includes("-I") || argv.includes("--head")) method = "HEAD";
    method = (explicit ?? method).toUpperCase();
  } else if (cmd === "wget") {
    if (argv.some((w) => /^--(post-data|post-file|body-data|body-file)/.test(w))) method = "POST";
    method = (argv.find((w) => w.startsWith("--method="))?.slice(9) ?? method).toUpperCase();
  } else {
    method = (argv.slice(1).find((w) => /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/i.test(w)) ?? (argv.some((w) => /^[\w-]+:?=/.test(w)) ? "POST" : "GET")).toUpperCase();
  }
  return method === "GET" || method === "HEAD" ? null : `${cmd} ${method} to a Supabase API would change hosted data`;
}

/** Block reason for a cp, rsync or install whose destination is protected. Sources are reads. */
function copyReason(cmd, args, dir) {
  const targetFlag = args.findIndex((w) => w === "-t" || w === "--target-directory");
  const attached = args.find((w) => w.startsWith("--target-directory="));
  let dest;
  if (targetFlag >= 0) dest = args[targetFlag + 1];
  else if (attached) dest = attached.slice(19);
  else dest = args.filter((w) => !w.startsWith("-")).at(-1);
  const name = dest && protectedName(dest, dir, true);
  return name ? `${cmd} would write to ${name}` : null;
}

function protectedWrite(argv, segment, dir, substs) {
  for (const target of segment.outs) {
    const name = protectedName(target, dir, true);
    if (name) return `redirects output into ${name}`;
    if (target.includes(SUB) && substs.some((s) => PROTECTED_TEXT.test(s))) return "redirects output to a generated path that names a protected path";
  }
  const cmd = base(argv[0]);
  if (cmd === "git") return gitReason(argv, segment, dir);
  if (cmd === "gh") return argv[1] === "api" ? ghApiReason(argv, dir) : argsReason(cmd, ghArgs(argv), segment, dir, substs);
  if (cmd === "patch") {
    const files = argv.flatMap((w, i) => (w === "-i" || w === "--input" ? [argv[i + 1]] : w.startsWith("--input=") ? [w.slice(8)] : []));
    return patchReason([...files, ...segment.ins], dir, "patch") ?? argsReason(cmd, argv.slice(1), segment, dir, substs);
  }
  if (COPY_COMMANDS.has(cmd)) return copyReason(cmd, argv.slice(1), dir);
  let args = argv.slice(1);
  // The file an interpreter runs is read, not written; inline code (-c, -e) stays checked.
  if (INTERPRETERS.has(cmd) && !SHELLS.has(cmd) && !args.some((w) => /^(-[ceEpr]|--eval|--print)$/.test(w))) {
    const script = args.findIndex((w) => !w.startsWith("-"));
    if (script >= 0) args = args.filter((_, i) => i !== script);
  }
  return argsReason(cmd, args, segment, dir, substs);
}

function argsReason(cmd, args, segment, dir, substs) {
  const writesScript = segment.outs.length > 0 && (args.some((w) => PROTECTED_TEXT.test(w)) || segment.heredocs.some((h) => PROTECTED_TEXT.test(h)));
  if (READERS.has(cmd) && writesScript) return `${cmd} writes a file whose text names a protected path`;
  const generated = args.some((w) => w.includes(SUB)) && substs.some((s) => PROTECTED_TEXT.test(s));
  const name = inMigrations(dir) ? "supabase/migrations" : args.map((w) => protectedName(w, dir, FILE_WRITERS.has(cmd))).find(Boolean);
  if (!name && !generated) return null;
  if (READERS.has(cmd) && !readerWrites(cmd, args)) return null;
  return `${cmd} would write to ${name ?? "a generated path that names a protected path"}`;
}

/** Text of a shell script the command runs from a file, or undefined when it runs none. */
function shellScript(cmd, argv, segment, dir) {
  if (!SCRIPT_SHELLS.has(cmd) && cmd !== "source" && cmd !== ".") return undefined;
  if (argv.includes("-c")) return undefined;
  const file = argv.slice(1).find((w) => !w.startsWith("-") && !w.startsWith("+"));
  if (file !== undefined) return readNamed(file, dir) ?? null;
  if (segment.ins.length > 0) return readNamed(segment.ins[0], dir) ?? null;
  return undefined;
}

function checkSegment(segment, state, dir, ctx, depth, substs) {
  const { argv, wrappers, env } = unwrap(segment.words);
  const cmd = base(argv[0]);
  const piped = segment.op === "|" || segment.op === "|&";
  if (piped && SHELLS.has(cmd)) return "pipes into a shell interpreter";
  if (piped && state.decoded && INTERPRETERS.has(cmd)) return "runs decoded text with an interpreter";
  state.decoded = (piped && state.decoded) || (/^(base64|base32|xxd|uudecode|openssl)$/.test(cmd) && argv.some((w) => /^-[a-zA-Z]*[dDr]$|^--decode/.test(w)));
  if (SHELLS.has(cmd) && argv.slice(1).some((w) => w.includes(SUB))) return "runs a shell on generated text";
  if (INTERPRETERS.has(cmd) && argv.some((w) => w.includes(SUB)) && argv.some((w) => /^(-[ceEpr]|--eval)$/.test(w))) return "runs generated code with an interpreter";
  for (const body of segment.heredocs) {
    if (SHELLS.has(cmd)) {
      const reason = checkCommand(body, dir, ctx, depth + 1);
      if (reason) return reason;
    } else if (INTERPRETERS.has(cmd) && PROTECTED_TEXT.test(body)) return "interpreter heredoc names a protected path";
  }
  const script = shellScript(cmd, argv, segment, dir);
  if (script === null) return `${cmd} runs a script file that cannot be read to check it; failing closed`;
  if (script !== undefined) {
    const reason = checkCommand(script, dir, ctx, depth + 1);
    if (reason) return `${cmd} script: ${reason}`;
  }
  const inline = cmd === "eval" ? argv.slice(1).join(" ") : (SHELLS.has(cmd) || /^(npx|npm)$/.test(cmd)) && argv.find((w, i) => /^(-c|--call)$/.test(argv[i - 1] ?? ""));
  if (inline) {
    const reason = checkCommand(inline, dir, ctx, depth + 1);
    if (reason) return reason;
  }
  if (cmd === "gh" && argv[1] === "alias" && /^(set|import)$/.test(argv[2] ?? "")) return "gh alias set/import could hide a merge behind a new name; aliases are set by Blaine";
  const cli = supabaseCli(argv);
  const cliReason = cli && supabaseReason(cli);
  if (cliReason) return cliReason;
  if (PG_CLIENTS.test(cmd)) {
    const reason = pgReason(argv, { ...state.env, ...env });
    if (reason) return reason;
  }
  if (/^(curl|wget|http|https)$/.test(cmd)) {
    const reason = supabaseHttpReason(argv);
    if (reason) return reason;
  }
  const call = scriptCall(argv, dir);
  if (call) {
    const { bodies, segs } = scriptBodies(call);
    const key = `${segs.join("/")}#${call.name}`;
    if (!ctx.visited.has(key)) {
      ctx.visited.add(key);
      for (const body of bodies) {
        const reason = checkCommand(body, segs, ctx, depth);
        if (reason) return `${call.name} script: ${reason}`;
      }
    }
  }
  const target = mergeTarget(argv, { ...state.env, ...env }, dir);
  const merge = target && mergeReason(target, ctx);
  if (merge) return merge;
  const fullArgv = wrappers.has("xargs") && piped ? [...argv, ...state.prevArgs] : argv;
  return protectedWrite(fullArgv, segment, dir, substs);
}

function checkCommand(src, dir, ctx, depth = 0) {
  if (depth > 6) return "command nests too deeply to check";
  const { segments, substs } = parse(expandVars(src));
  for (const inner of substs) {
    const reason = checkCommand(inner, dir, ctx, depth + 1);
    if (reason) return reason;
  }
  const state = { decoded: false, env: {}, prevArgs: [] };
  for (const segment of segments) {
    const { argv, env } = unwrap(segment.words);
    const cmd = base(argv[0]);
    if (argv.length === 0 || cmd === "export") {
      Object.assign(state.env, env);
      for (const w of argv.slice(1)) if (isAssignment(w)) state.env[w.slice(0, w.indexOf("="))] = w.slice(w.indexOf("=") + 1);
    }
    if (cmd === "cd" || cmd === "pushd") {
      dir = changeDir(dir, argv.slice(1).find((w) => !w.startsWith("-")));
      continue;
    }
    const reason = checkSegment(segment, state, dir, ctx, depth, substs);
    if (reason) return reason;
    state.prevArgs = argv.slice(1);
  }
  return null;
}

/** Block reason for an execute_sql query that is not a single read only statement. */
export function sqlReason(sql) {
  if (typeof sql !== "string") return "execute_sql has no query string; failing closed";
  let text = "";
  for (let i = 0; i < sql.length; ) {
    const rest = sql.slice(i);
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(rest);
    if (rest.startsWith("--")) {
      i = indexOrEnd(sql, "\n", i);
      text += " ";
    } else if (rest.startsWith("/*")) {
      let depth = 0;
      for (; i < sql.length; i++) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i++;
        } else if (sql.startsWith("*/", i)) {
          if (--depth === 0) break;
          i++;
        }
      }
      if (i >= sql.length) return "execute_sql has an unterminated comment; failing closed";
      i += 2;
      text += " ";
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      const start = i + 1;
      const backslashes = quote === "'" && /[eE]$/.test(sql.slice(0, i)) && !/\w[eE]$/.test(sql.slice(0, i));
      for (i++; i < sql.length; i++) {
        if (backslashes && sql[i] === "\\") i++;
        else if (sql[i] === quote && sql[i + 1] === quote) i++;
        else if (sql[i] === quote) break;
      }
      if (i >= sql.length) return "execute_sql has an unterminated quote; failing closed";
      const inner = sql.slice(start, i).replaceAll('""', '"');
      i++;
      // A quoted identifier called as a function keeps its name so side effect functions are still caught.
      if (quote === "'") text += " '' ";
      else text += /^\s*\(/.test(sql.slice(i)) ? ` ${inner}` : " q ";
    } else if (dollar && !/\w$/.test(sql.slice(0, i))) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) return "execute_sql has an unterminated dollar quote; failing closed";
      i = end + dollar[0].length;
      text += " '' ";
    } else text += sql[i++];
  }
  const statement = text.trim().replace(/;\s*$/, "").trim();
  if (statement.includes(";")) return "execute_sql allows a single statement only";
  const first = /^[\s(]*([A-Za-z]+)/.exec(statement)?.[1]?.toLowerCase();
  if (!SQL_FIRST_WORDS.has(first)) return "execute_sql allows only read only statements (select, with, show, explain, table)";
  const write = SQL_WRITE_WORDS.exec(statement) ?? SQL_SIDE_EFFECTS.exec(statement);
  return write ? `execute_sql query contains "${write[0].trim()}", which is not read only` : null;
}

function mcpMergeTarget(name, input) {
  if (name === "merge_diff") {
    const m = PR_URL.exec(String(input.urlOrId ?? input.url ?? input.id ?? ""));
    return m ? { owner: m[2], repo: m[3], number: m[4] } : null;
  }
  const number = input.pullNumber ?? input.pull_number ?? input.number;
  if (!input.owner || !input.repo || number === undefined) return null;
  return { owner: input.owner, repo: input.repo, number, sha: input.sha ?? input.commit_id };
}

function checkMcp(tool, input, ctx) {
  const parts = tool.split("__");
  const name = parts.at(-1);
  const server = parts.slice(1, -1).join("__");
  const supabaseServer = /supabase/i.test(server) || KNOWN_SUPABASE_SERVERS.has(server);
  if (SUPABASE_ONLY_TOOLS.has(name)) return `${name} is a hosted Supabase write`;
  if (SHARED_NAME_TOOLS.has(name) && (supabaseServer || "project_id" in input || "organization_id" in input)) return `${name} is a hosted Supabase write`;
  if (name === "execute_sql") return sqlReason(input.query ?? input.sql);
  if (MERGE_TOOLS.has(name)) {
    const target = mcpMergeTarget(name, input);
    return target ? mergeReason(target, ctx) : `${name} does not name a GitHub PR (owner, repo and number, or a PR URL); failing closed`;
  }
  if (!FILE_WRITE_TOOLS.test(name)) return null;
  let reason = null;
  JSON.stringify(input, (key, value) => {
    const hit = /^(path|file_?path|filename|new_path|from_path|to_path)$/i.test(key) && typeof value === "string" && protectedName(value, [], true);
    if (hit) reason = `MCP write to ${hit}`;
    return value;
  });
  return reason;
}

function checkEdit(input, cwd) {
  for (const key of ["file_path", "notebook_path", "path"]) {
    const name = typeof input[key] === "string" && protectedName(input[key], cwd);
    if (name) return `file edits under ${name} need Blaine's explicit yes`;
  }
  return null;
}

/**
 * Returns a block reason, or null to allow. options.prFiles(target, cwd)
 * returns a PR's changed files (or { files, headSha }) and throws when it
 * cannot; it defaults to gh.
 */
export function decide(payload, options = {}) {
  const input = payload?.tool_input;
  if (input == null || typeof input !== "object") return "tool_input is missing; failing closed";
  const tool = String(payload.tool_name ?? "");
  const cwdPath = resolve(payload.cwd || process.cwd());
  const ctx = { prFiles: options.prFiles ?? ghPrFiles, cwd: cwdPath, visited: new Set() };
  const cwd = changeDir([], cwdPath);
  if (tool.startsWith("mcp__")) return checkMcp(tool, input, ctx);
  if (EDIT_TOOLS.has(tool)) return checkEdit(input, cwd);
  if (tool !== "Bash") return null;
  if (typeof input.command !== "string") return "tool_input.command is missing; failing closed";
  return checkCommand(input.command, cwd, ctx);
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let reason;
  try {
    reason = decide(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
  } catch (error) {
    reason = `could not check this call (${error.message}); failing closed`;
  }
  if (!reason) return 0;
  process.stderr.write(
    `guard-migrations blocked this call: ${reason}.\n` +
      "This hook is best effort. The real gates are the deny rules in .claude/settings.json, workers never merging, and Blaine's explicit yes for anything under supabase/migrations/. Stop and report; do not route around it.\n",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
