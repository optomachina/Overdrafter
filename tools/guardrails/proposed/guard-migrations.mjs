#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for Bash, file edit and MCP calls. Best effort only.
 *
 * The real gates are elsewhere: the permission deny rules in
 * .claude/settings.json (Edit on supabase/migrations/** and on the guard
 * files themselves, the Bash db push rules, and the hosted Supabase write
 * tools), the rule that workers never merge, and Blaine's explicit yes for
 * anything under supabase/migrations/. A determined agent can get past this
 * hook.
 *
 * It blocks:
 * - Edit, Write, MultiEdit and NotebookEdit on any path under
 *   supabase/migrations/ (worktrees included), .claude/hooks/,
 *   .claude/settings*.json or tools/guardrails/ (apply.mjs and proposed/);
 * - Bash writes to those paths: a redirect, tee, sed -i, cp, mv, rsync or
 *   install whose target is protected or cannot be resolved, a copy whose
 *   source would land on a protected path, git checkout/restore with a
 *   pathspec that could cover them (git global options such as -C are
 *   normalized first), git apply of a patch that names them, any pipe into a
 *   shell, decoded or generated text run by an interpreter, and shell scripts
 *   (run by a shell or by path, with -c text attached or not) whose text does
 *   any of that. A generated file name inside a protected directory is still
 *   a write there. Readers (cat, sed -n, awk, jq, grep, head, sort, eslint and
 *   prettier without their writing flags, psql -f and so on) pass, also with a
 *   redirect to a path that is not protected;
 * - running tools/guardrails/apply.mjs by path (generated or ~ paths
 *   included), through an interpreter or through a package.json script;
 * - supabase CLI commands that create migration files, or that target a
 *   hosted project (--linked, --project-ref, a --db-url that is not loopback,
 *   or a remote only command) unless they are on a read allow list, also when
 *   reached through a package.json script (npm, yarn, pnpm, bun, node --run,
 *   npx and npm exec forms, workspaces);
 * - psql, pgbench and other Postgres clients (docker run and exec included)
 *   whose target is not provably loopback, unless psql runs read only SQL,
 *   and HTTP writes to Supabase APIs (each curl --next transfer on its own);
 * - hosted Supabase write tools under any MCP server name, and execute_sql
 *   unless it is a single read only statement that calls no function in an
 *   app schema;
 * - git push to main: a destination that is or can match main (heads/main,
 *   an empty destination, a wildcard), and a push of the current branch (no
 *   refspec, HEAD, or a generated refspec) while that branch is main. The
 *   branch is the one checked out, followed through git checkout, switch and
 *   branch -m earlier in the same command, failing closed when it cannot be
 *   resolved. Aliases from -c, git config and the repository config (include
 *   files too) are expanded. Also the merges API and writes to the main ref;
 * - merges and auto merges of a PR whose changed files (renames included)
 *   touch supabase/migrations/, failing closed when the files cannot be
 *   listed or the PR cannot be resolved.
 * Text that only names a protected path is not a write. Commit messages,
 * gh --body/--title text and gh api comment fields are never scanned.
 * Residuals are listed in guard-migrations.node-test.mjs.
 *
 * Exit 2 with a reason on stderr blocks the call. Missing tool_input
 * fails closed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUB = "\u0001";
const SCRIPT_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);
const SHELLS = new Set([...SCRIPT_SHELLS, "tcsh", "csh", "fish", "busybox", "eval", "source", "."]);
const INTERPRETERS = new Set([...SHELLS, "perl", "python", "python3", "node", "ruby", "php", "deno", "bun"]);
const READERS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "less", "more", "stat", "file", "diff", "find", "sort", "uniq", "nl",
  "md5sum", "cksum", "cmp", "echo", "printf", "realpath", "readlink", "dirname", "basename", "test", "[", "true",
  "sed", "awk", "gawk", "mawk", "nawk", "jq", "cut", "xxd", "od", "hexdump", "tac", "rev", "comm", "column", "strings", "tr", "fold", "paste",
  "eslint", "prettier",
]);
const isReader = (cmd) => READERS.has(cmd) || /^(sha\d*sum|shasum|b2sum)$/.test(cmd);
// Commands for which a bare "supabase", ".claude" or "tools" word (or a glob that could expand to it) means the directory.
const FILE_WRITERS = new Set(["cp", "mv", "rm", "rmdir", "rsync", "ln", "install", "tar", "unzip", "touch", "mkdir", "chmod", "chown", "truncate", "dd", "tee", "shred", "git"]);
const COPY_COMMANDS = new Set(["cp", "rsync", "install"]);
const GIT_READERS = new Set([
  "log", "show", "status", "blame", "diff", "grep", "ls-files", "add", "fetch", "rev-parse", "branch", "remote", "config", "describe", "shortlog", "cat-file", "ls-tree",
  "merge-base", "rev-list", "diff-tree", "diff-index", "diff-files", "whatchanged", "check-ignore", "check-attr", "show-ref", "for-each-ref", "name-rev", "range-diff", "reflog",
]);
// git commands an alias cannot replace, so their names are never looked up as aliases.
const GIT_BUILTINS = new Set([
  ...GIT_READERS, "am", "annotate", "apply", "archive", "backfill", "bisect", "bundle", "check-mailmap", "check-ref-format", "checkout", "checkout-index", "cherry",
  "cherry-pick", "citool", "clean", "clone", "column", "commit", "commit-graph", "commit-tree", "count-objects", "credential", "difftool", "fetch-pack",
  "filter-branch", "fmt-merge-msg", "for-each-repo", "format-patch", "fsck", "gc", "get-tar-commit-id", "gui", "hash-object", "help", "index-pack", "init",
  "instaweb", "interpret-trailers", "ls-remote", "maintenance", "merge", "merge-file", "merge-index", "merge-tree", "mergetool", "mktag", "mktree",
  "multi-pack-index", "mv", "notes", "pack-objects", "pack-refs", "prune", "prune-packed", "pull", "push", "read-tree", "rebase", "receive-pack", "refs", "repack",
  "replace", "replay", "request-pull", "rerere", "reset", "restore", "revert", "rm", "send-email", "show-branch", "show-index", "sparse-checkout", "stash",
  "stripspace", "submodule", "switch", "symbolic-ref", "tag", "unpack-file", "unpack-objects", "update-index", "update-ref", "update-server-info", "upload-archive",
  "upload-pack", "var", "verify-commit", "verify-pack", "verify-tag", "version", "worktree", "write-tree",
]);
// On macOS /usr/bin/git is a shim that fails without the developer tools, so Homebrew's git is tried first there.
const GIT_CANDIDATES =
  process.platform === "darwin"
    ? ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]
    : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/home/linuxbrew/.linuxbrew/bin/git"];
// git config keys that pull another config file in, so an alias can come from it.
const GIT_INCLUDE_KEY = /^(include\.path|includeif\..+\.path)$/i;
const GIT_ALIAS_DEPTH = 5;
const WRAPPERS = new Set(["env", "sudo", "command", "exec", "nohup", "time", "nice", "timeout", "xargs", "stdbuf"]);
// Shell keywords that start a command, and words that never write a file (keywords and assignment builtins).
const PREFIX_KEYWORDS = new Set(["!", "{", "do", "then", "else", "elif", "if", "while", "until"]);
const NO_WRITE_WORDS = new Set(["for", "select", "case", "in", "done", "fi", "esac", "}", "[[", "]]", "readonly", "local", "declare", "typeset", "export", "return", "exit", "shift", "set", "unset", "trap"]);
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
// Built in and extension functions that write or change server state. User defined functions are a documented residual.
const SQL_SIDE_EFFECTS =
  /\b(nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_signal_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_promote|pg_notify|pg_advisory\w*|pg_try_advisory\w*|pg_create_\w+|pg_drop_\w+|pg_replication_\w+|pg_stat_reset\w*|pg_stat_statements_reset|pg_file_\w+|pg_logical_\w+|pg_import_system_collations|pg_backup_\w+|pg_start_backup|pg_stop_backup|pg_wal_replay_\w+|pg_log_backend_memory_contexts|lo_\w+|dblink\w*|http_\w+|resolve|create_secret|update_secret|schedule|unschedule|alter_job)\s*\(/i;
const SQL_SYSTEM_SCHEMAS = new Set(["pg_catalog", "information_schema", "extensions"]);
const SQL_AUTH_READS = new Set(["uid", "role", "jwt", "email"]);
const PROTECTED_TEXT = /supabase\W+migrations|\.claude\W+(hooks|settings)|tools\W+guardrails/i;
const SCRIPT_FILE = /\.(sh|bash|zsh|ksh|js|mjs|cjs|ts|py|rb|pl|php)$/i;
const PG_CLIENTS = /^(psql|pgcli|pgbench|pg_restore|createdb|dropdb|createuser|dropuser|vacuumdb|reindexdb|clusterdb)$/;
const SUPABASE_HTTP = /supabase\.(co|in|com|net)\b|\/(rest|auth|storage|graphql|pg)\/v1\b|\$\{?\w*SUPABASE\w*/i;
const LOOPBACK = /^(localhost|[\w-]+\.localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|\[::1\]|host\.docker\.internal)$/i;
const MAIN_REF = /^(refs\/)?(heads\/)?(main|master)$/;
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
    } else if (c === "#" && /\s/.test(src[i - 1] ?? "")) {
      i = indexOrEnd(src, "\n", i) - 1;
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
    // >&word writes both streams to the file word, unless word is a descriptor number or - (2>&1, >&2, >&-).
    if (redirect === ">&") {
      if (!/^(\d+-?|-)$/.test(word)) seg().outs.push(word);
    } else if (redirect === ">") seg().outs.push(word);
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
      else if (m[0] === ">&") redirect = ">&";
      else redirect = m[0].includes(">") ? ">" : "<";
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
    } else if (c === "#" && word === null) {
      i = indexOrEnd(src, "\n", i);
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

/**
 * Expands $VAR and ${VAR} with the value assigned most recently before the
 * reference. Arrays, substitutions and quoted or escaped values are not
 * recorded, so references to them stay unresolved.
 */
function expandVars(src) {
  const vars = Object.create(null);
  const ref = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
  const assignOrRef = /(^|[\s;&|(])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]*)|\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
  return src.replace(assignOrRef, (all, lead, name, value, braced, bare) => {
    if (name !== undefined) {
      const raw = value.replace(/(^["'])|(["']$)/g, "");
      if (/(^\()|\$\(|[`"'\\]/.test(raw)) delete vars[name];
      else vars[name] = raw.replace(ref, (seen, a, b) => vars[a ?? b] ?? seen);
      return all;
    }
    return vars[braced ?? bare] ?? all;
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
  while (PREFIX_KEYWORDS.has(argv[0])) argv = argv.slice(1);
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
const inGuardrails = (segs) => pairAt(segs, "tools", ["guardrails"]);

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
const within = (segs, dir) => segs.length >= dir.length && dir.every((s, i) => segs[i] === s);

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Path segments a word names from dir, with ~ and $HOME kept as a ~ root. A
 * substitution inside a word stands for one unknown name, so a fixed
 * directory with a generated name still resolves; a word that is only
 * substitutions is a generated path (see writeTargetReason) and gives null.
 */
function wordSegs(word, dir) {
  if (word.includes(SUB)) {
    if (word.split("/").every((part) => part.replaceAll(SUB, "") === "")) return null;
    word = word.replaceAll(SUB, "_");
  }
  const home = /^(~|\$\{?HOME\}?)\//.exec(word);
  return home ? ["~", ...changeDir([], word.slice(home[0].length))] : changeDir(dir, word);
}

/**
 * Names the protected area a word points at from dir, or null. Paths are
 * normalized first, so supabase/migrations/../../docs/x.md is not a hit.
 * With wholeDir a word naming the supabase, .claude or tools/guardrails
 * directory itself (or a tools directory that holds guardrails) also counts,
 * which matters only for commands that write files.
 */
function protectedName(word, dir, wholeDir = false) {
  const segs = wordSegs(word, dir);
  if (segs === null) return null;
  const joined = segs.join("/");
  const last = segs.at(-1) ?? "";
  const named = word.split("/").some(Boolean);
  if (/supabase\/+migrations(\/|$)/i.test(joined) || inMigrations(segs) || (wholeDir && named && globEq(last, "supabase"))) return "supabase/migrations";
  if (/\.claude\/(hooks\b|settings[\w.-]*\.json)/i.test(joined) || inGuardFiles(segs) || (wholeDir && named && globEq(last, ".claude"))) {
    return "the .claude guard files";
  }
  const toolsDir = wholeDir && named && globEq(last, "tools") && (/[*?[{]/.test(last) || existsSync(`/${joined}/guardrails`));
  if (/(^|\/)tools\/guardrails(\/|$)/i.test(joined) || inGuardrails(segs) || toolsDir || (wholeDir && named && globEq(last, "guardrails") && globEq(segs.at(-2) ?? "", "tools"))) {
    return "the guardrail files";
  }
  return null;
}

/** The file sort -o (or --output) writes, or undefined. */
function sortOutput(args) {
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "--output" || /^-[a-zA-Z]*o$/.test(w)) return args[i + 1] ?? "";
    if (w.startsWith("--output=")) return w.slice(9);
    const m = /^-[a-zA-Z]*o(.+)$/.exec(w);
    if (m && !w.startsWith("--")) return m[1];
  }
  return undefined;
}

/** True when sed would write a file or run a command: -i, a script file, or a w, W or e command in its script. */
function sedWrites(args) {
  const scripts = [];
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "-e" || w === "--expression") scripts.push(args[++i] ?? "");
    else if (w.startsWith("--expression=")) scripts.push(w.slice(13));
    else if (/^--in-place|^-[nErsuz]*i/.test(w) || /^(-[nErsuz]*f|--file)/.test(w)) return true;
    else if (/^-[nErsuz]*e./.test(w)) scripts.push(w.slice(w.indexOf("e") + 1));
    else if (w === "-l" || w === "--line-length") i++;
    else if (!w.startsWith("-")) positional.push(w);
  }
  if (scripts.length === 0) scripts.push(positional[0] ?? "");
  return scripts.some((s) => /(^|[;{}\n/\d$!\s])[wWe](\s|$)/.test(s));
}

/** True when awk would write a file or run a command: in place editing, a program file, or output redirection, pipes or system() in its program. */
function awkWrites(args) {
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (/^(-f|--file|-i|--include|--inplace|-E|--exec)/.test(w)) return true;
    if (/^(-v|-F|--assign|--field-separator)$/.test(w)) i++;
    else if (!w.startsWith("-")) return /\bsystem\s*\(|\bprintf?\b[^;}]*[>|]|\|\s*getline|\bclose\s*\(/.test(w);
  }
  return false;
}

function readerWrites(cmd, args) {
  if (cmd === "sed") return sedWrites(args);
  if (/^[gmn]?awk$/.test(cmd)) return awkWrites(args);
  if (cmd === "xxd") return args.filter((w, i) => !w.startsWith("-") && !/^-(c|g|l|o|s|n|cols|groupsize|len|seek|name)$/.test(args[i - 1] ?? "")).length >= 2;
  if (cmd === "find") return args.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(w));
  if (cmd === "diff") return args.some((w) => /^--output|^-[a-zA-Z]*o/.test(w));
  if (cmd === "sort") return sortOutput(args) !== undefined;
  if (cmd === "eslint") return args.some((w) => /^(--fix|--fix-type|--output-file|-o|--cache-location|--cache-file)(=|$)|^-o./.test(w));
  if (cmd === "prettier") return args.some((w) => /^(--write|-w|--cache-location)(=|$)/.test(w));
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

/** gh argv with -R/--repo removed wherever it appears, and the repository it named. */
function ghCall(argv) {
  const out = [argv[0]];
  let repo;
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i];
    if (w === "-R" || w === "--repo") repo = argv[++i];
    else if (w.startsWith("--repo=")) repo = w.slice(7);
    else if (/^-R./.test(w)) repo = w.slice(2);
    else out.push(w);
  }
  return { argv: out, repo };
}

/**
 * git argv with global options (-C, -c, --git-dir, --work-tree, --no-pager,
 * pathspec switches and so on) removed, the directory -C or --work-tree
 * names, and any -c value that names a protected path.
 */
function gitCall(argv, dir, ctx, known = {}, knownIncludes = []) {
  let cwd = dir;
  let gitDir;
  let config = null;
  const aliases = { ...known };
  const includes = [...knownIncludes];
  let i = 1;
  for (; i < argv.length && argv[i].startsWith("-"); i++) {
    const w = argv[i];
    const eq = /^(--[\w-]+)=(.*)$/s.exec(w);
    let flag = eq ? eq[1] : w;
    let value = eq ? eq[2] : undefined;
    if (/^-[Cc]./.test(w)) [flag, value] = [w.slice(0, 2), w.slice(2)];
    if (value === undefined && /^(-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix|--attr-source|--list-cmds)$/.test(flag)) value = argv[++i] ?? "";
    if (flag === "-C" || flag === "--work-tree") cwd = changeDir(cwd, value);
    if (flag === "--git-dir") gitDir = pathOf(cwd, value);
    const alias = flag === "-c" && /^alias\.([^=]+)=([\s\S]*)$/i.exec(value);
    if (alias) aliases[alias[1].toLowerCase()] = alias[2];
    else if ((flag === "-c" || flag === "--config-env") && PROTECTED_TEXT.test(value)) config = value;
    if (flag === "-c" && GIT_INCLUDE_KEY.test(value.split("=")[0])) includes.push(value);
  }
  let rest = argv.slice(i);
  const call = { dir: cwd, gitDir, config, includes };
  // An alias is expanded, a few levels deep: a ! alias is returned as shell text to check, any other becomes git
  // arguments. Aliases come from -c, from git config set earlier in the same command, or from the repository config
  // and the files it includes (also an include.path given with -c or set earlier in the command). Past the depth
  // limit, or when an include file cannot be read, an alias is not known, so the call fails closed.
  for (let depth = 0; rest[0] !== undefined && !GIT_BUILTINS.has(rest[0]); depth++) {
    const name = rest[0].toLowerCase();
    let alias = Object.hasOwn(aliases, name) ? aliases[name] : undefined;
    if (alias === undefined && ctx) {
      try {
        alias = configAlias(name, call, ctx);
      } catch (error) {
        return { ...call, argv: [argv[0]], error: `git ${rest[0]} may be an alias, and git config could not be read to check it (${error.message}); failing closed` };
      }
    }
    if (alias === undefined) break;
    if (depth >= GIT_ALIAS_DEPTH) return { ...call, argv: [argv[0]], error: `git ${rest[0]} expands through more than ${String(GIT_ALIAS_DEPTH)} aliases; failing closed` };
    if (alias.startsWith("!")) return { ...call, argv: [argv[0]], shell: alias.slice(1), shellArgs: rest.slice(1) };
    rest = [...parse(alias).segments.flatMap((s) => s.words), ...rest.slice(1)];
  }
  return { ...call, argv: [argv[0], ...rest] };
}

function runGit(args, call) {
  const git = GIT_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!git) throw new Error(`git not found in ${GIT_CANDIDATES.join(", ")}`);
  const where = call.dir.some((part) => part.includes(SUB) || part.includes("$")) ? null : pathOf(call.dir, ".");
  if (where === null) throw new Error("the directory cannot be resolved");
  const full = ["-C", where, ...(call.gitDir ? ["--git-dir", call.gitDir] : []), ...(call.includes ?? []).flatMap((c) => ["-c", c]), ...args];
  const result = spawnSync(git, full, { encoding: "utf8", timeout: GH_TIMEOUT_MS });
  if (result.error) throw new Error(result.error.code === "ETIMEDOUT" ? "git timed out" : `git failed: ${result.error.message}`);
  return result;
}

/**
 * The value of alias.<name> in the git config seen from the call's directory, include files followed, or undefined.
 * Throws when it cannot be read: git fails (a shim that is not git exits 1 with an error), or an include file
 * given in the command does not exist yet (git skips a missing include, and the command may write it first).
 */
function configAlias(name, call, ctx) {
  const key = `${call.dir.join("/")}#${call.gitDir ?? ""}#${(call.includes ?? []).join("\n")}#${name}`;
  if (!ctx.gitAliases.has(key)) {
    for (const include of call.includes ?? []) {
      const file = include.slice(include.indexOf("=") + 1).replace(/^~(?=\/)/, process.env.HOME ?? "~");
      if (!file.startsWith("/") || readNamed(file, []) === null) throw new Error(`include file ${file} cannot be read`);
    }
    const result = runGit(["config", "--includes", "--get", `alias.${name}`], call);
    if (result.status !== 0 && (result.status !== 1 || result.stderr.trim() !== "")) {
      throw new Error(`git config exited ${String(result.status)}${result.stderr.trim() ? `: ${result.stderr.trim().split("\n")[0]}` : ""}`);
    }
    ctx.gitAliases.set(key, result.status === 0 ? result.stdout.replace(/\n$/, "") : undefined);
  }
  return ctx.gitAliases.get(key);
}

/** The branch checked out in the call's directory. Throws when it cannot be resolved (detached HEAD included). */
function currentBranch(call) {
  const result = runGit(["symbolic-ref", "--short", "HEAD"], call);
  const branch = result.stdout.trim();
  if (result.status !== 0 || !branch) throw new Error(`git symbolic-ref exited ${String(result.status)}`);
  return branch;
}

/** Reads a file named in a command, resolved from dir; null when it cannot be read or is a device such as /dev/stdin. */
function readNamed(word, dir) {
  if (!word || word.includes(SUB) || word === "-" || /^\/(dev|proc)\//.test(word)) return null;
  try {
    return readFileSync(word.startsWith("/") ? word : pathOf(dir, word), "utf8");
  } catch {
    return null;
  }
}

/** Host names in a libpq connection string or URI; "$" marks one that cannot be resolved. */
function connHosts(value) {
  if (value.includes("$") || value.includes(SUB)) return ["$"];
  const hosts = [];
  const uri = /^postgres(?:ql)?:\/\/([^/?#]*)[^?#]*(?:\?([^#]*))?/i.exec(value);
  if (uri) {
    const authority = uri[1].slice(uri[1].lastIndexOf("@") + 1);
    for (const part of authority.split(",")) hosts.push(decodeURIComponent(/^(\[[^\]]*\]|[^:]*)/.exec(part)[1]));
    for (const pair of (uri[2] ?? "").split("&")) {
      const [key, raw = ""] = pair.split("=");
      if (/^(host|hostaddr)$/i.test(key)) hosts.push(...decodeURIComponent(raw).split(","));
      if (/^service$/i.test(key)) hosts.push("$");
    }
    return hosts;
  }
  for (const m of value.matchAll(/\b(host|hostaddr|service)\s*=\s*('[^']*'|\S+)/gi)) {
    if (m[1].toLowerCase() === "service") hosts.push("$");
    else hosts.push(...m[2].replace(/(^')|('$)/g, "").split(","));
  }
  return hosts;
}

/** True when a host is loopback, a Unix socket path, or empty (the default socket). */
const localHost = (host) => host === "" || host.startsWith("/") || LOOPBACK.test(host);

/** Host of an http(s) URL, or null when the URL does not start with a scheme. */
const urlHost = (url) => /^[a-z][\w+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/:?#]*)/i.exec(url)?.[1] ?? null;

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

// Commands that write migration files, whatever database they target.
const SUPABASE_FILE_WRITES = new Set(["migration new", "migration squash", "migration fetch", "db pull"]);
// Commands that change the linked hosted project unless --local (or a loopback --db-url) is given.
const SUPABASE_LINKED_BY_DEFAULT = new Set(["db push", "migration repair", "db query"]);
// Command groups that only ever talk to the hosted platform.
const SUPABASE_REMOTE_GROUPS = new Set([
  "projects", "orgs", "branches", "secrets", "storage", "sso", "domains", "vanity-subdomains", "network-bans", "network-restrictions",
  "ssl-enforcement", "postgres-config", "snippets", "config", "backups",
]);
const SUPABASE_REMOTE_COMMANDS = new Set(["functions deploy", "functions delete", "functions download", "functions list"]);
// Read only commands allowed against a hosted project, from the command list in the Supabase CLI reference
// (https://supabase.com/docs/reference/cli): list, get, show, dump, diff, lint, inspect and status forms, plus link.
const SUPABASE_HOSTED_READS = new Set([
  "migration list", "db diff", "db dump", "db lint", "db advisors", "inspect db", "inspect report", "projects list", "projects api-keys",
  "orgs list", "branches list", "branches get", "functions list", "functions download", "secrets list", "status", "gen types", "gen",
  "snippets list", "snippets download", "storage ls", "sso list", "sso info", "sso show", "domains get", "vanity-subdomains get",
  "vanity-subdomains check-availability", "network-bans get", "network-restrictions get", "ssl-enforcement get", "postgres-config get",
  "services", "link", "backups list",
]);
const SUPABASE_VALUE_FLAGS = /^(--workdir|--profile|--output|-o|--dns-resolver|--network-id|--db-url|--project-ref|-p|--password|-f|--file|-s|--schema|--status|--version)$/;

/** Block reason for supabase CLI calls that write migration files or change a hosted project. */
function supabaseReason(args) {
  const positional = [];
  let dbUrl;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db-url") dbUrl = args[i + 1] ?? "";
    else if (args[i].startsWith("--db-url=")) dbUrl = args[i].slice(9);
    if (SUPABASE_VALUE_FLAGS.test(args[i])) i++;
    else if (!args[i].startsWith("-")) positional.push(args[i]);
  }
  const [group, action] = positional;
  const key = `${group} ${action}`;
  const name = ["supabase", group, action].filter(Boolean).join(" ");
  if (SUPABASE_FILE_WRITES.has(key)) return `${name} would create a migration file`;
  if (key === "db diff" && args.some((w) => /^(-f|--file)(=|$)|^-f./.test(w))) return "supabase db diff -f would write a migration file";
  if (key === "db schema" && positional.includes("sync")) return `${name} declarative sync would write a migration file`;
  const loopbackUrl = dbUrl !== undefined && connHosts(dbUrl).every(localHost);
  const hosted =
    args.some((w) => /^--(linked|project-ref)(=|$)/.test(w)) || (dbUrl !== undefined && !loopbackUrl) || SUPABASE_REMOTE_GROUPS.has(group) || SUPABASE_REMOTE_COMMANDS.has(key);
  if (hosted) return SUPABASE_HOSTED_READS.has(key) || SUPABASE_HOSTED_READS.has(group) ? null : `${name} targets a hosted project and is not on the read only allow list`;
  if (SUPABASE_LINKED_BY_DEFAULT.has(key) && !args.includes("--local") && !loopbackUrl) return `${name} targets the linked hosted project unless --local is given`;
  return null;
}

/** package.json contents in segs, or null. */
function readPackage(segs) {
  try {
    return JSON.parse(readFileSync(`/${[...segs, "package.json"].join("/")}`, "utf8"));
  } catch {
    return null;
  }
}

function nearestPackage(dir) {
  for (let segs = [...dir]; ; segs.pop()) {
    if (existsSync(`/${[...segs, "package.json"].join("/")}`)) {
      const pkg = readPackage(segs);
      return pkg ? { pkg, scripts: pkg.scripts ?? {}, segs } : null;
    }
    if (segs.length === 0) return null;
  }
}

/** Directories of the workspaces declared by the nearest package.json (or pnpm-workspace.yaml) above dir. */
function workspaceDirs(dir) {
  const root = nearestPackage(dir);
  if (!root) return [];
  let patterns = root.pkg.workspaces?.packages ?? root.pkg.workspaces ?? [];
  if (!Array.isArray(patterns)) patterns = [];
  const yaml = readNamed("pnpm-workspace.yaml", root.segs);
  if (yaml) patterns = [...patterns, ...[...yaml.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1])];
  const dirs = [];
  for (const pattern of patterns) {
    const parts = pattern.split("/");
    if (!/[*?[{]/.test(parts.at(-1))) dirs.push(changeDir(root.segs, pattern));
    else {
      const parent = changeDir(root.segs, parts.slice(0, -1).join("/"));
      try {
        for (const entry of readdirSync(`/${parent.join("/")}`)) if (globEq(parts.at(-1), entry.toLowerCase())) dirs.push([...parent, entry]);
      } catch {
        // A missing workspace directory has no scripts to check.
      }
    }
  }
  return dirs.filter((d) => readPackage(d));
}

/** The directory of a workspace named by path or package name, or null. */
function workspaceDir(dir, workspace) {
  const byPath = changeDir(dir, workspace);
  if (readPackage(byPath)) return byPath;
  return workspaceDirs(dir).find((d) => readPackage(d)?.name === workspace) ?? null;
}

const NPM_SCRIPT_ALIASES = { t: "test", tst: "test", test: "test", start: "start", stop: "stop", restart: "restart" };
const RUN_WORDS = new Set(["run", "run-script", "rum", "urn"]);
const YARN_PNPM_BUILTINS = new Set([
  "add", "install", "i", "remove", "rm", "upgrade", "update", "up", "why", "info", "init", "dlx", "exec", "workspace", "workspaces",
  "config", "cache", "bin", "create", "global", "link", "unlink", "pack", "publish", "version", "node", "set", "constraints", "plugin",
  "outdated", "list", "ls", "audit", "store", "import", "patch", "prune", "rebuild", "env", "setup", "licenses", "fetch", "deploy",
]);
const BUN_BUILTINS = new Set(["install", "i", "add", "a", "remove", "rm", "update", "upgrade", "x", "exec", "create", "c", "init", "pm", "link", "unlink", "build", "test", "outdated", "patch", "publish", "audit", "info", "why", "repl", "completions", "help"]);
const DIR_FLAGS = /^(--prefix|-C|--dir|--cwd)$/;
const WORKSPACE_FLAGS = /^(-w|--workspace|--filter|-F)$/;
const ALL_WORKSPACES = /^(--workspaces|-ws|-r|--recursive)$/;
// Task runners that take package.json script names as arguments.
const ORCHESTRATORS = /^(turbo|nx|lerna|ultra|wireit|nr|run-s|run-p|npm-run-all2?)$/;
const PACKAGE_MANAGERS = /^(npm|yarn|pnpm|bun|node|npx|bunx|pnpx)$/;

/**
 * Script calls ({ name, dir, extra } or { error }) for npm, yarn, pnpm, bun or
 * node --run. npm reads its directory and workspace flags anywhere before --;
 * for the others, flags after the script name may belong to the script, so
 * both readings are checked.
 */
function scriptCalls(argv, dir) {
  const cmd = base(argv[0]);
  if (cmd === "node") {
    const at = argv.findIndex((w) => w === "--run" || w.startsWith("--run="));
    if (at < 0) return [];
    const name = argv[at] === "--run" ? argv[at + 1] : argv[at].slice(6);
    return name ? [{ name, dir, extra: argv.slice(at + (argv[at] === "--run" ? 2 : 1)) }] : [];
  }
  if (!/^(npm|yarn|pnpm|bun)$/.test(cmd)) return [];
  const dash = argv.indexOf("--");
  const end = dash < 0 ? argv.length : dash;
  const positional = [];
  const flags = [];
  for (let i = 1; i < end; i++) {
    const w = argv[i];
    const eq = /^(--[\w-]+)=(.*)$/s.exec(w);
    let [flag, value] = eq ? [eq[1], eq[2]] : [w, undefined];
    if (/^-[Cw]./.test(w) && !w.startsWith("--") && w !== "-ws") [flag, value] = [w.slice(0, 2), w.slice(2)];
    if (DIR_FLAGS.test(flag) || WORKSPACE_FLAGS.test(flag)) flags.push({ flag, value: value ?? argv[++i] ?? "", at: positional.length });
    else if (ALL_WORKSPACES.test(flag)) flags.push({ flag, at: positional.length });
    else if (!w.startsWith("-")) positional.push({ word: w, index: i });
  }
  const [p0, p1, p2] = positional.map((p) => p.word);
  let nameAt;
  let name;
  if (RUN_WORDS.has(p0)) nameAt = 1;
  else if (cmd === "yarn" && p0 === "workspace") {
    flags.push({ flag: "-w", value: p1 ?? "", at: 0 });
    nameAt = RUN_WORDS.has(p2) ? 3 : 2;
  } else if (cmd === "npm") {
    nameAt = 0;
    name = NPM_SCRIPT_ALIASES[p0];
  } else if (p0 !== undefined && !(cmd === "bun" ? BUN_BUILTINS : YARN_PNPM_BUILTINS).has(p0)) nameAt = 0;
  name ??= nameAt === undefined ? undefined : positional[nameAt]?.word;
  if (!name) return [];
  const extra = argv.slice(positional[nameAt].index + 1).filter((w) => w !== "--");
  const placesFor = (chosen) => {
    let base = dir;
    let workspaces = [];
    let all = false;
    for (const f of chosen) {
      if (DIR_FLAGS.test(f.flag)) base = changeDir(dir, f.value);
      else if (WORKSPACE_FLAGS.test(f.flag)) workspaces.push(f.value);
      else all = true;
    }
    if (all) return [base, ...workspaceDirs(base)].map((d) => ({ dir: d }));
    if (workspaces.length === 0) return [{ dir: base }];
    return workspaces.map((w) => {
      const found = workspaceDir(base, w);
      return found ? { dir: found } : { error: `${cmd} names workspace ${w}, which cannot be resolved to a package.json to check; failing closed` };
    });
  };
  const readings = cmd === "npm" ? [flags] : [flags.filter((f) => f.at <= nameAt), flags];
  return readings.flatMap(placesFor).map((place) => ({ ...place, name, extra }));
}

/** The command a package runner (npx, bunx, npm exec, pnpm dlx, yarn dlx, bun x) runs, or null. */
function runnerInner(argv) {
  const cmd = base(argv[0]);
  let i = 1;
  const skipOptions = () => {
    while (i < argv.length && (argv[i].startsWith("-") || argv[i] === "--")) {
      if (/^(-c|--call)$/.test(argv[i])) return false;
      i += /^(-p|--package)$/.test(argv[i]) ? 2 : 1;
    }
    return true;
  };
  if (/^(npm|pnpm|yarn|bun)$/.test(cmd)) {
    if (!skipOptions() || !/^(exec|x|dlx)$/.test(argv[i] ?? "")) return null;
    i++;
  } else if (!/^(npx|bunx|pnpx)$/.test(cmd)) return null;
  if (!skipOptions() || i >= argv.length) return null;
  return argv.slice(i).map((w, k) => (k === 0 ? w.replace(/(.)@[^/]*$/, "$1") : w));
}

function scriptBodies(call) {
  const pkg = nearestPackage(call.dir);
  const main = pkg?.scripts[call.name];
  if (typeof main !== "string") return { bodies: [], segs: call.dir };
  const quoted = call.extra.map((w) => `'${w.replaceAll("'", "'\\''")}'`).join(" ");
  const bodies = [pkg.scripts[`pre${call.name}`], `${main} ${quoted}`.trim(), pkg.scripts[`post${call.name}`]].filter((s) => typeof s === "string");
  return { bodies, segs: pkg.segs };
}

/** Block reason from the package.json scripts a list of calls would run. */
function scriptsReason(calls, ctx, depth) {
  for (const call of calls) {
    if (call.error) return call.error;
    const { bodies, segs } = scriptBodies(call);
    const key = `${segs.join("/")}#${call.name}`;
    if (ctx.visited.has(key)) continue;
    ctx.visited.add(key);
    for (const body of bodies) {
      const reason = checkCommand(body, segs, ctx, depth);
      if (reason) return `${call.name} script: ${reason}`;
    }
  }
  return null;
}

/** Script calls for every argument that names a package.json script (task runners and unknown package runners). */
function namedScripts(argv, dir) {
  const scripts = nearestPackage(dir)?.scripts ?? {};
  return argv.slice(1).filter((w) => !w.startsWith("-") && Object.hasOwn(scripts, w)).map((name) => ({ name, dir, extra: [] }));
}

const MERGE_ROUTE = /(?:^|\/)repos\/([^/\s]+)\/([^/\s]+)\/pulls\/(\d+)\/(?:ccr\/)?(merge|auto[_-]?merge)\/?(?:[?#].*)?$/;

/** Route, method, field words and body text (null when an --input file cannot be read) of a gh api call. */
function ghApiCall(argv, dir) {
  const call = { route: undefined, method: undefined, fields: [], input: undefined, unread: false };
  // -F key=@file and --field key=@file send the file's text, which is read so a merge mutation in it is seen.
  const typed = (field) => {
    const at = field.indexOf("=");
    if (at < 0 || field[at + 1] !== "@") return field;
    const text = readNamed(field.slice(at + 2), dir);
    if (text === null) call.unread = true;
    return `${field.slice(0, at)}=${text ?? ""}`;
  };
  for (let i = 2; i < argv.length; i++) {
    const w = argv[i];
    if (w === "-X" || w === "--method") call.method = argv[++i];
    else if (/^-X./.test(w)) call.method = w.slice(2);
    else if (w.startsWith("--method=")) call.method = w.slice(9);
    else if (w === "--input") call.input = argv[++i] ?? "-";
    else if (w.startsWith("--input=")) call.input = w.slice(8);
    else if (/^(-f|--raw-field)$/.test(w)) call.fields.push(argv[++i] ?? "");
    else if (/^(-F|--field)$/.test(w)) call.fields.push(typed(argv[++i] ?? ""));
    else if (/^-f./.test(w)) call.fields.push(w.slice(2));
    else if (/^-F./.test(w)) call.fields.push(typed(w.slice(2)));
    else if (w.startsWith("--raw-field=")) call.fields.push(w.slice(12));
    else if (w.startsWith("--field=")) call.fields.push(typed(w.slice(8)));
    else if (/^(-H|--header|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)$/.test(w)) i++;
    else if (!w.startsWith("-") && call.route === undefined) call.route = w.replace(/^\//, "");
  }
  const hasBody = call.fields.length > 0 || call.input !== undefined;
  call.method = (call.method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  const input = call.input === undefined ? "" : readNamed(call.input, dir);
  call.body = input === null || call.unread ? null : [...call.fields, input].join("\n");
  return call;
}

// curl short options that take a value; any other letter in a bundle such as -sX is a switch.
const CURL_SHORT_VALUE = "bcCdDeEFHKmoPQrtTuUwxXyYzA";
const CURL_LONG_VALUE = /^--(?:expand-)?(request|data|data-ascii|data-binary|data-raw|data-urlencode|json|form|form-string|upload-file|url|header|user|output|user-agent|referer|cookie|cookie-jar|config|proxy|write-out|connect-timeout|max-time|retry|range|resolve|cacert|cert|key|dump-header|continue-at|quote|telnet-option|ftp-port|proxy-user|time-cond|speed-limit|speed-time|variable)$/;

/** curl arguments as [option, value] pairs (value undefined for switches and URLs), with bundled short options split. */
function curlOptions(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const eq = /^(--[\w-]+)=(.*)$/s.exec(w);
    // --expand-<option> is <option> with {{variables}} expanded in its value.
    if (eq) out.push([eq[1].replace(/^--expand-/, "--"), eq[2]]);
    else if (w.startsWith("--")) out.push(CURL_LONG_VALUE.test(w) ? [w.replace(/^--expand-/, "--"), args[++i] ?? ""] : [w, undefined]);
    else if (/^-[^-]/.test(w)) {
      for (let k = 1; k < w.length; k++) {
        const flag = `-${w[k]}`;
        if (!CURL_SHORT_VALUE.includes(w[k])) {
          out.push([flag, undefined]);
          continue;
        }
        out.push([flag, w.slice(k + 1) || (args[++i] ?? "")]);
        break;
      }
    } else out.push([null, w]);
  }
  return out;
}

const CURL_BODY = /^(-d|-F|--data|--data-ascii|--data-binary|--data-raw|--data-urlencode|--json|--form|--form-string)$/;

/**
 * Requests ({ method, urls, body }, body null when it cannot be read) a
 * curl, wget or HTTPie command sends. Each curl --next transfer is its own
 * request, since curl resets the method and body there.
 */
function httpRequests(argv, dir) {
  const cmd = base(argv[0]);
  const newRequest = () => ({ method: undefined, urls: [], body: "", hasBody: false, get: false, upload: false });
  const addBody = (req, flag, value = "") => {
    req.hasBody = true;
    if (req.body === null) return;
    if (value.startsWith("@") && !/raw|string/.test(flag)) {
      const text = readNamed(value.slice(1), dir);
      req.body = text === null ? null : `${req.body}\n${text}`;
    } else req.body += `\n${value}`;
  };
  const finish = (req) => ({ method: String(req.method).toUpperCase(), urls: req.urls, body: req.body });
  if (cmd === "curl") {
    const requests = [newRequest()];
    for (const [flag, value] of curlOptions(argv.slice(1))) {
      const req = requests.at(-1);
      if (flag === null || flag === "--url") req.urls.push(value);
      else if (flag === "--next" || flag === "-:") requests.push(newRequest());
      else if (flag === "-X" || flag === "--request") req.method = value;
      else if (CURL_BODY.test(flag)) addBody(req, flag, value);
      else if (flag === "-T" || flag === "--upload-file") req.upload = true;
      else if (flag === "-G" || flag === "--get") req.get = true;
      else if (flag === "-I" || flag === "--head") req.method ??= "HEAD";
    }
    return requests.map((req) => finish({ ...req, method: req.method ?? (req.upload ? "PUT" : req.hasBody && !req.get ? "POST" : "GET") }));
  }
  const req = newRequest();
  if (cmd === "wget") {
    for (const w of argv.slice(1)) {
      const m = /^--(post-data|post-file|body-data|body-file)=(.*)$/s.exec(w);
      if (m) addBody(req, m[1], m[1].endsWith("file") ? `@${m[2]}` : m[2]);
      else if (w.startsWith("--method=")) req.method = w.slice(9);
      else if (!w.startsWith("-")) req.urls.push(w);
    }
    req.method ??= req.hasBody ? "POST" : "GET";
  } else {
    req.method = argv.slice(1).find((w) => /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/i.test(w)) ?? (argv.some((w) => /^[\w-]+:?=/.test(w)) ? "POST" : "GET");
    req.urls = argv.slice(1).filter((w) => /(:\/\/)|(^:\d)|(^\$)/.test(w) || SUPABASE_HTTP.test(w));
    req.body = argv.slice(1).join("\n");
  }
  return [finish(req)];
}

/** A merge target from a GraphQL body holding a merge mutation, or null when it holds none. */
function graphqlTarget(body) {
  if (body === null) return { graphql: "a GraphQL request body that cannot be read" };
  if (!/enablePullRequestAutoMerge|mergePullRequest/i.test(body)) return null;
  // A literal id is used as written; a $variable is looked up among the values sent with it.
  const m = /pullRequestId\s*:\s*(?:\\?"([^"\\]+)|\$\w+)/.exec(body);
  const nodeId = m?.[1] ?? (m ? /\b(PR_[\w-]+)/.exec(body)?.[1] : undefined);
  return nodeId ? { nodeId } : { graphql: "a GraphQL merge mutation whose PR cannot be resolved" };
}

const fillRepo = (owner, repo, env) => {
  const [envOwner, envRepo] = (env.GH_REPO ?? "").split("/").slice(-2);
  return { owner: owner === "{owner}" && envOwner ? envOwner : owner, repo: repo === "{repo}" && envRepo ? envRepo : repo };
};

/** A merge or auto merge request in a Bash command, or null. */
function mergeTarget(argv, env, dir) {
  const cmd = base(argv[0]);
  if (cmd === "gh") {
    const { argv: gh, repo } = ghCall(argv);
    if (gh[1] === "pr" && gh[2] === "merge") {
      if (gh.includes("--disable-auto")) return null;
      const target = { selector: undefined, repoFlag: repo ?? env.GH_REPO, sha: undefined };
      for (let i = 3; i < gh.length; i++) {
        const w = gh[i];
        if (w === "--match-head-commit") target.sha = gh[++i];
        else if (w.startsWith("--match-head-commit=")) target.sha = w.slice(20);
        else if (/^(-b|--body|-F|--body-file|-t|--subject|-A|--author-email)$/.test(w)) i++;
        else if (!w.startsWith("-") && target.selector === undefined) target.selector = w;
      }
      return target;
    }
    if (gh[1] !== "api") return null;
    const call = ghApiCall(gh, dir);
    if (call.route === "graphql") return graphqlTarget(call.body);
    const m = MERGE_ROUTE.exec(call.route ?? "");
    // DELETE on an auto merge route turns auto merge off.
    if (!m || call.method === "GET" || call.method === "DELETE") return null;
    return { ...fillRepo(m[1], m[2], env), number: m[3] };
  }
  if (!/^(curl|wget|http|https)$/.test(cmd)) return null;
  for (const req of httpRequests(argv, dir)) {
    for (const url of req.urls) {
      const path = url.replace(/^\w+:\/\/[^/]+/, "");
      if (/\/graphql\/?(?:[?#].*)?$/.test(path) && req.method !== "GET") {
        const target = graphqlTarget(req.body);
        if (target) return target;
      }
      const m = MERGE_ROUTE.exec(path);
      if (m && req.method !== "GET" && req.method !== "DELETE") return { owner: m[1], repo: m[2], number: m[3] };
    }
  }
  return null;
}

/** Block reason for a REST call that merges branches or writes the main ref. Agents never push to main. */
function branchWriteReason(route, method, body) {
  if (method === "GET" || method === "HEAD") return null;
  const path = route.replace(/^\w+:\/\/[^/]+/, "").replace(/^\/+/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (/^repos\/[^/]+\/[^/]+\/merges$/.test(path)) return "the merges API merges one branch into another; agents never merge";
  const ref = /^repos\/[^/]+\/[^/]+\/git\/refs(?:\/(.*))?$/.exec(path);
  if (!ref) return null;
  if (/^(refs\/)?heads\/(main|master)$/.test(ref[1] ?? "")) return "writes the main branch ref; agents never push to main";
  if (ref[1] === undefined) {
    if (body === null) return "a git refs write whose body cannot be read; failing closed";
    if (/refs\/heads\/(main|master)\b/.test(body)) return "creates the main branch ref; agents never push to main";
  }
  return null;
}

/** Block reason for gh api calls that write repository content under a protected path or write main. Comment and review routes pass. */
function ghApiReason(argv, dir) {
  const call = ghApiCall(argv, dir);
  if (call.method === "GET" || call.route === undefined) return null;
  const branch = branchWriteReason(call.route, call.method, call.body);
  if (branch) return `gh api: ${branch}`;
  const contents = /^repos\/[^/]+\/[^/]+\/contents\/(.+?)(?:[?#].*)?$/.exec(call.route);
  const named = contents && protectedName(decodeURIComponent(contents[1]), [], true);
  if (named) return `gh api would write ${named} through the contents API`;
  if (/^repos\/[^/]+\/[^/]+\/git\/(trees|blobs|commits)/.test(call.route)) {
    if (call.body === null) return "gh api git data call reads an --input file that cannot be read; failing closed";
    if (PROTECTED_TEXT.test(call.body)) return "gh api git data call names a protected path";
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
  let selector = target.selector;
  if (target.nodeId) {
    const query = "query($id: ID!) { node(id: $id) { ... on PullRequest { url } } }";
    selector = runGh(["api", "graphql", "-f", `query=${query}`, "-f", `id=${target.nodeId}`, "--jq", ".data.node.url"], cwd).trim();
    if (!PR_URL.test(selector)) throw new Error(`GraphQL node ${target.nodeId} is not a pull request`);
  }
  const url = PR_URL.exec(selector ?? "");
  if (number === undefined && url) [, host, owner, repo, number] = url;
  if (number === undefined && /^#?\d+$/.test(selector ?? "")) {
    // A bare number resolves over REST; gh pr view needs GraphQL, which some sessions cannot reach.
    const parts = (target.repoFlag ?? "{owner}/{repo}").split("/");
    [owner, repo] = parts.slice(-2);
    if (parts.length === 3) host = parts[0];
    number = selector.replace("#", "");
  }
  if (number === undefined) {
    const args = ["pr", "view", ...(selector ? [selector] : []), ...(target.repoFlag ? ["-R", target.repoFlag] : []), "--json", "url", "--jq", ".url"];
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
  if (target.graphql) return `${target.graphql}, so its changed files cannot be checked; failing closed (use gh pr merge)`;
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

/**
 * The branch a git checkout, switch or branch -m leaves checked out: its name, null when it cannot be resolved
 * (a generated or variable name, -, --detach), or undefined when the command does not change the branch.
 */
function branchChange([sub, ...args], dir) {
  if (sub !== "checkout" && sub !== "switch" && sub !== "branch") return undefined;
  const dash = args.indexOf("--");
  if (dash >= 0 && args.length > dash + 1) return undefined;
  const words = dash >= 0 ? args.slice(0, dash) : args;
  const NEW = { checkout: /^(-b|-B|--orphan)$/, switch: /^(-c|-C|--create|--force-create|--orphan)$/, branch: /^(-m|-M|--move)$/ }[sub];
  const positional = [];
  let created;
  let move = false;
  let track = false;
  let detach = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const eq = /^(--[\w-]+)=(.*)$/s.exec(w);
    if (sub === "branch" && NEW.test(w)) move = true;
    else if (NEW.test(eq ? eq[1] : w)) created = eq ? eq[2] : (words[++i] ?? "");
    else if (sub !== "branch" && /^-[bBcC]./.test(w) && NEW.test(w.slice(0, 2))) created = w.slice(2);
    else if (/^(-t|--track)(=|$)/.test(w)) track = true;
    else if (/^(--detach|-d)$/.test(w) && sub !== "branch") detach = true;
    else if (/^(-p|--patch)$/.test(w) || w.startsWith("--pathspec-from-file")) return undefined;
    else if (w === "-" || !w.startsWith("-")) positional.push(w);
  }
  const named = (name) => (name.includes(SUB) || name.includes("$") || name === "-" || name.startsWith("@{") ? null : name);
  if (sub === "branch") {
    if (!move || positional.length === 0) return undefined;
    // branch -m new renames the current branch; branch -m old new renames old, which may be the current branch.
    if (positional.length === 1) return named(positional[0]);
    return MAIN_REF.test(positional[1]) || named(positional[1]) === null ? null : undefined;
  }
  if (detach) return null;
  if (created !== undefined) return named(created);
  if (positional.length !== 1) return undefined;
  const [target] = positional;
  // --track origin/x creates and checks out x; a lone checkout argument that is an existing path restores that path.
  if (track) return named(target.replace(/^[^/]*\//, ""));
  if (sub === "checkout" && dash < 0 && !target.includes(SUB) && !target.includes("$") && existsSync(pathOf(dir, target))) return undefined;
  return named(target);
}

/** Records the branch an earlier git checkout, switch or branch -m in this command leaves checked out in its repository. */
function recordBranch(argv, dir, state, ctx) {
  if (base(argv[0]) !== "git") return;
  const git = gitCall(argv, dir, ctx, state.gitAliases, state.gitIncludes);
  if (git.error || git.shell !== undefined) return;
  const branch = branchChange(git.argv.slice(1), git.dir);
  if (branch !== undefined) ctx.branches.push({ dir: git.dir, gitDir: git.gitDir, branch });
}

/**
 * The branch a push of the current branch runs on: the last checkout or switch recorded earlier in the command for
 * the same repository (a directory within the other), else the branch checked out now. Throws when it cannot be resolved.
 */
function pushBranch(call, ctx) {
  const related = (a, b) => within(a, b) || within(b, a);
  const recorded = ctx.branches.findLast((r) => r.gitDir === call.gitDir && related(r.dir, call.dir));
  if (recorded === undefined) return currentBranch(call);
  if (recorded.branch === null) throw new Error("an earlier git checkout or switch in this command names a branch that cannot be resolved");
  return recorded.branch;
}

/** Block reason for a git push that would update main. */
function pushReason(args, call, ctx) {
  const positional = [];
  let tags = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (/^(--repo|-o|--push-option|--receive-pack|--exec)$/.test(w)) i++;
    else if (/^--(all|mirror|branches)$/.test(w)) return `git push ${w} would push main; agents never push to main`;
    else if (w === "--tags") tags = true;
    else if (!w.startsWith("-")) positional.push(w);
  }
  // As in git, the first positional argument is the repository (it overrides --repo) and the rest are refspecs.
  const specs = positional.slice(1);
  // With no refspec, a push updates the current branch; --tags alone pushes only tags.
  let current = specs.length === 0 && !tags;
  for (let k = 0; k < specs.length; k++) {
    const spec = specs[k];
    // tag <name> pushes refs/tags/<name>.
    if (spec === "tag") {
      k++;
      continue;
    }
    const plain = spec.replace(/^\+/, "");
    if (plain === ":") return `git push ${spec} pushes every matching branch, main included; agents never push to main`;
    const colon = plain.lastIndexOf(":");
    // An empty destination (HEAD:, main:) names the same ref as the source.
    const dest = (colon < 0 ? plain : plain.slice(colon + 1)) || plain.slice(0, colon);
    // A destination built by substitution or a variable ("$(git branch --show-current)") stands for the current branch
    // when it could spell main; a wildcard destination (refs/heads/*) blocks when it can match main.
    const generated = dest.includes(SUB) || dest.includes("$");
    const filled = dest.replaceAll(SUB, "main").replace(/\$(\{[^}]*\}|[A-Za-z_]\w*|\d|[@*])/g, "main").replaceAll("*", "main");
    if (!generated && MAIN_REF.test(filled)) return `git push ${spec} would update main; agents never push to main`;
    if (/^(HEAD|@)$/.test(dest) || (generated && MAIN_REF.test(filled))) current = true;
  }
  if (!current) return null;
  let branch;
  try {
    branch = pushBranch(call, ctx);
  } catch (error) {
    return `git push of the current branch, which cannot be resolved (${error.message}); failing closed, name the destination branch`;
  }
  return MAIN_REF.test(branch) ? `git push from ${branch} would update ${branch}; agents never push to main` : null;
}

function gitReason(argv, segment, call, ctx) {
  const dir = call.dir;
  const sub = argv[1];
  const args = argv.slice(2);
  if (sub === "commit") return commitArgs(argv).some((w) => protectedName(w, dir, true)) ? "git commit reads or writes a protected file" : null;
  if (sub === "push") return pushReason(args, call, ctx);
  const output = args.find((w) => w.startsWith("--output"));
  if (output) return protectedName(output.replace(/^--output=?/, "") || args[args.indexOf(output) + 1] || "", dir, true) ? "git writes output to a protected path" : null;
  // reflog expire and reflog delete change the reflog; its other forms read it.
  if (GIT_READERS.has(sub) && !(sub === "reflog" && /^(expire|delete|drop)$/.test(args[0] ?? ""))) return null;
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

// Short options that take a value, per Postgres client. pgbench uses -d for debug and -c for its client count.
const PG_VALUE_LETTERS = { pgbench: "hpUcjtTfDsSPRLMbF" };
const PG_DEFAULT_VALUE_LETTERS = "cdfhpUvPoLTFR";

/** Hosts, SQL commands and whether a SQL file is read, for a Postgres client argv. */
function pgTargets(argv, env) {
  const cmd = base(argv[0]);
  const letters = PG_VALUE_LETTERS[cmd] ?? PG_DEFAULT_VALUE_LETTERS;
  const out = { hosts: [], sql: [], file: false };
  let positional = 0;
  const take = (key, value) => {
    if (key === "h" || key === "host") out.hosts.push(value);
    else if ((key === "d" || key === "dbname") && cmd !== "pgbench") out.hosts.push(...connHosts(value));
    else if ((key === "c" || key === "command") && cmd !== "pgbench") out.sql.push(value);
    else if (key === "f" || key === "file") out.file = true;
  };
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i];
    const long = /^--([\w-]+)(?:=(.*))?$/s.exec(w);
    if (long) {
      if (/^(host|dbname|command|file|port|username|set|variable|pset|output|log-file|table-attr|field-separator|record-separator)$/.test(long[1])) take(long[1], long[2] ?? argv[++i] ?? "");
    } else if (/^-[^-]/.test(w)) {
      for (let k = 1; k < w.length; k++) {
        if (!letters.includes(w[k])) continue;
        take(w[k], w.slice(k + 1) || argv[++i] || "");
        break;
      }
    } else if (positional++ === 0) out.hosts.push(...connHosts(w));
  }
  if (out.hosts.length === 0) {
    const fromEnv = [env.PGHOST, env.PGHOSTADDR, process.env.PGHOST, process.env.PGHOSTADDR].find((h) => h !== undefined);
    if (fromEnv !== undefined) out.hosts.push(...(fromEnv.includes("$") ? ["$"] : fromEnv.split(",")));
    if (env.PGSERVICE ?? process.env.PGSERVICE) out.hosts.push("$");
  }
  return out;
}

function pgReason(argv, env) {
  const cmd = base(argv[0]);
  const target = pgTargets(argv, env);
  const remote = target.hosts.find((h) => !localHost(h));
  if (remote === undefined) return null;
  const host = remote === "$" ? "a host that cannot be resolved" : remote;
  if (cmd !== "psql" && cmd !== "pgcli") return `${cmd} against ${host} would change a database that is not provably loopback`;
  if (target.file) return `psql -f against ${host} cannot be checked; failing closed`;
  if (target.sql.length === 0) return `psql against ${host} without -c reads SQL that cannot be checked; failing closed`;
  for (const sql of target.sql) {
    const reason = sqlReason(sql);
    if (reason) return `psql against ${host}: ${reason.replace("execute_sql ", "")}`;
  }
  return null;
}

/** Block reason for HTTP writes (anything but GET or HEAD) to a Supabase API that is not loopback. */
function supabaseHttpReason(argv, dir) {
  for (const req of httpRequests(argv, dir)) {
    if (req.method === "GET" || req.method === "HEAD") continue;
    for (const url of req.urls) {
      const host = urlHost(url);
      if (host !== null && !host.includes("$") && localHost(host)) continue;
      if (SUPABASE_HTTP.test(url)) return `${base(argv[0])} ${req.method} to a Supabase API that is not loopback would change hosted data`;
    }
  }
  return null;
}

/** Block reason when the target of a write is protected, or is generated or unresolved in a command that names a protected path. */
function writeTargetReason(target, dir, segment, substs) {
  const name = protectedName(target, dir, true);
  if (name) return `into ${name}`;
  if (target.includes(SUB) && substs.some((s) => PROTECTED_TEXT.test(s))) return "to a generated path that names a protected path";
  if (target.includes("$") && [...segment.words, ...segment.heredocs].some((w) => PROTECTED_TEXT.test(w))) return "to an unresolved variable path in a command that names a protected path; failing closed";
  return null;
}

// Short options that take a value, and long options that write somewhere, per copy command.
const COPY_VALUE_SHORT = { cp: "tS", install: "tmogS", rsync: "eTfBM" };
const COPY_VALUE_LONG = /^(--target-directory|--suffix|--mode|--owner|--group|--strip-program|-e|--rsh|--rsync-path|--exclude|--include|--filter|--exclude-from|--include-from|--files-from|--chmod|--chown|--usermap|--groupmap|--timeout|--port|--password-file|--bwlimit|--max-size|--min-size|--out-format|--log-file-format|--info|--debug|--partial-dir|--temp-dir|--backup-dir|--compare-dest|--copy-dest|--link-dest|--log-file|--write-batch|--only-write-batch|--read-batch|--iconv|--max-delete|--block-size|--remote-option|--skip-compress|--compress-level|--modify-window)$/;
const RSYNC_WRITE_OPTS = /^(--partial-dir|--temp-dir|--backup-dir|--log-file|--write-batch|--only-write-batch|-T)$/;

/** Block reason for a cp, rsync or install whose destination is protected, or whose sources would land on a protected path. */
function copyReason(cmd, args, dir, segment, substs) {
  const writes = [];
  const positional = [];
  let targetDir;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    const eq = /^(--[\w-]+)=(.*)$/s.exec(w);
    if (eq || COPY_VALUE_LONG.test(w)) {
      const [flag, value] = eq ? [eq[1], eq[2]] : [w, args[++i] ?? ""];
      if (flag === "--target-directory") targetDir = value;
      else if (cmd === "rsync" && RSYNC_WRITE_OPTS.test(flag)) writes.push(value);
    } else if (/^-[^-]/.test(w)) {
      for (let k = 1; k < w.length; k++) {
        if (!COPY_VALUE_SHORT[cmd].includes(w[k])) continue;
        const value = w.slice(k + 1) || args[++i] || "";
        if (w[k] === "t" && cmd !== "rsync") targetDir = value;
        if (w[k] === "T" && cmd === "rsync") writes.push(value);
        break;
      }
    } else if (!w.startsWith("-")) positional.push(w);
  }
  const dest = targetDir ?? positional.at(-1);
  const sources = targetDir === undefined ? positional.slice(0, -1) : positional;
  for (const target of [dest, ...writes]) {
    const reason = target === undefined ? null : writeTargetReason(target, dir, segment, substs);
    if (reason) return `${cmd} would write ${reason}`;
  }
  if (dest === undefined || dest.includes(SUB) || dest.includes("$")) return null;
  const destSegs = changeDir(dir, dest);
  const destPath = `/${destSegs.join("/")}`;
  const destIsDir = targetDir !== undefined || sources.length > 1 || /(^|\/)\.{0,2}\/?$/.test(dest) || isDirectory(destPath);
  for (const source of sources) {
    // rsync copies the contents of a source that ends in a slash, as cp does for src/. and src/*.
    const contents = (cmd === "rsync" && source.endsWith("/")) || /(^|\/)\.\/?$/.test(source);
    if (contents) {
      const holds = ["supabase", ".claude", "tools/guardrails"].some((d) => existsSync(`${destPath}/${d}`));
      if (holds || (destSegs.length <= dir.length && within(dir, destSegs))) return `${cmd} would copy the contents of ${source} over ${dest}, which holds protected paths`;
    } else if (destIsDir) {
      const landing = `${destPath}/${base(source.replace(/\/+$/, ""))}`;
      const name = protectedName(landing, dir, within(changeDir(dir, landing), dir));
      if (name) return `${cmd} would land ${source} on ${name}`;
    }
  }
  return null;
}

function protectedWrite(argv, segment, dir, substs, ctx, state) {
  const cmd = base(argv[0]);
  if (NO_WRITE_WORDS.has(cmd) && segment.outs.length === 0) return null;
  for (const target of segment.outs) {
    const reason = writeTargetReason(target, dir, segment, substs);
    if (reason) return `redirects output ${reason}`;
    // Only echo and printf print their arguments; any other command (git show, cat) prints file contents, so a copy is a read.
    const printsArgs = /^(echo|printf)$/.test(cmd) && argv.slice(1).some((w) => PROTECTED_TEXT.test(w));
    if (SCRIPT_FILE.test(target) && (printsArgs || segment.heredocs.some((h) => PROTECTED_TEXT.test(h)))) {
      return `writes a script file ${target} whose text names a protected path; run those steps directly instead`;
    }
  }
  if (cmd === "git") {
    const git = gitCall(argv, dir, ctx, state.gitAliases, state.gitIncludes);
    if (git.error) return git.error;
    if (git.config) return `git -c ${git.config} names a protected path`;
    // Plain arguments were checked with the alias text (checkSegment); a generated one that names a protected path cannot be.
    if (git.shell !== undefined) return git.shellArgs.some((w) => w.includes(SUB) && protectedName(w, git.dir, true)) ? "git shell alias gets a generated protected path as an argument" : null;
    return gitReason(git.argv, segment, git, ctx);
  }
  if (cmd === "gh") {
    const gh = ghCall(argv).argv;
    return gh[1] === "api" ? ghApiReason(gh, dir) : argsReason(cmd, ghArgs(gh), segment, dir, substs);
  }
  if (/^(curl|wget|http|https)$/.test(cmd)) {
    for (const req of httpRequests(argv, dir)) {
      for (const url of req.urls) {
        const reason = /api\.github\.com|\/api\/v3\//.test(url) && branchWriteReason(url.replace(/^.*?\/api\/v3/, ""), req.method, req.body);
        if (reason) return `${cmd}: ${reason}`;
      }
    }
  }
  if (cmd === "patch") {
    const files = argv.flatMap((w, i) => (w === "-i" || w === "--input" ? [argv[i + 1]] : w.startsWith("--input=") ? [w.slice(8)] : []));
    return patchReason([...files, ...segment.ins], dir, "patch") ?? argsReason(cmd, argv.slice(1), segment, dir, substs);
  }
  if (COPY_COMMANDS.has(cmd)) return copyReason(cmd, argv.slice(1), dir, segment, substs);
  // A package runner's command and a shell's -c text are checked on their own (checkSegment); only what is left is checked here.
  if (runnerInner(argv)) return null;
  let args = argv.slice(1);
  // A shell's -c text was checked with its positional values put in (checkSegment); options and the values are not writes here.
  if (SCRIPT_SHELLS.has(cmd)) args = shellInline(argv) ? [] : args.filter((w) => !/^[-+][^-]/.test(w));
  // psql reads the file it runs; its target host was checked by pgReason.
  if (cmd === "psql") args = args.filter((w, i) => !/^(-f|--file)$/.test(args[i - 1] ?? "") && !/^(-f.|--file=)/.test(w));
  // The file an interpreter runs is read, not written; inline code (-c, -e) stays checked. node --test runs every file it names.
  if (INTERPRETERS.has(cmd) && !SHELLS.has(cmd) && !args.some((w) => /^(-[ceEpr]|--eval|--print)$/.test(w))) {
    if (cmd === "node" && args.includes("--test")) args = args.filter((w) => w.startsWith("-"));
    const script = args.findIndex((w) => !w.startsWith("-"));
    if (script >= 0) args = args.filter((_, i) => i !== script);
  }
  return argsReason(cmd, args, segment, dir, substs);
}

/**
 * Reads pass. A command that writes files (or a reader in a writing mode)
 * blocks when an argument names a protected path, or when an argument it
 * writes is generated from a substitution that names one. Any other command
 * blocks when an argument names a protected path, since what it does with
 * the path is unknown.
 */
function argsReason(cmd, args, segment, dir, substs) {
  if (isReader(cmd) && !readerWrites(cmd, args)) return null;
  // sort reads its inputs; only the -o file is written.
  if (cmd === "sort") {
    const reason = writeTargetReason(sortOutput(args), dir, segment, substs);
    return reason ? `sort would write ${reason}` : null;
  }
  const writesArgs = FILE_WRITERS.has(cmd) || isReader(cmd);
  const generated = writesArgs && args.some((w) => w.includes(SUB)) && substs.some((s) => PROTECTED_TEXT.test(s));
  const name = inMigrations(dir) ? "supabase/migrations" : args.map((w) => protectedName(w, dir, FILE_WRITERS.has(cmd))).find(Boolean);
  if (!name && !generated) return null;
  if (name && INTERPRETERS.has(cmd) && !SHELLS.has(cmd)) {
    return `${cmd} gets a ${name} path as an argument and what it does with it cannot be checked; read it with cat, sed -n, head, grep or jq instead`;
  }
  return `${cmd} would write to ${name ?? "a generated path that names a protected path"}`;
}

/**
 * Inline command texts a shell runs with -c, or null when it runs none. A
 * word such as -ce is a cluster of options and the text is the next
 * argument; -cTEXT is also read as the text itself, so both readings are checked.
 * Long options such as --login or --noprofile are skipped, and a -- that
 * ends the options is not the text.
 */
function shellInline(argv) {
  const texts = [];
  let inline = false;
  let i = 1;
  for (; i < argv.length && /^([-+][^-]|--.)/.test(argv[i]); i++) {
    const w = argv[i];
    if (w.startsWith("--")) {
      if (/^--(rcfile|init-file)$/.test(w)) i++;
      continue;
    }
    const at = w.indexOf("c");
    if (at > 0) {
      inline = true;
      if (w.length > at + 1) texts.push(w.slice(at + 1));
    }
    if (/^[-+][a-zA-Z]*[oO]$/.test(w)) i++;
  }
  if (!inline) return null;
  // A lone - ends the options like --.
  if (argv[i] === "--" || argv[i] === "-") i++;
  if (i < argv.length) texts.push(argv[i]);
  // The words after the text are $0, $1 and so on; they are values the text uses, so they are put into it.
  return texts.flatMap((text) => positionalReadings(text, argv.slice(i + 1)));
}

/**
 * Readings of shell text with its positional values put in. When the text moves the values (shift, set --) or reads
 * them with a default (\${1:-x}, \${1-x}), each value is also tried in every earlier position, and the text is also
 * read with the references left as variables, which stand for an unresolved value.
 */
function positionalReadings(text, values) {
  if (!/\bshift\b|\bset\s+--|\$\{\d+:?[-=+?]/.test(text)) return [withPositional(text, values)];
  const plain = text.replace(/\$\{(\d+):?[-=+?][^}]*\}/g, "${$1}");
  const readings = [text];
  for (let k = 0; k < Math.max(values.length - 1, 1); k++) readings.push(withPositional(plain, [values[0], ...values.slice(1 + k)].filter((v) => v !== undefined)));
  return readings;
}

/** Shell text with $0, $1..$9, ${N}, "$@", $@ and $* replaced by the values a shell gives them. */
function withPositional(text, values) {
  if (values.length === 0) return text;
  const quote = (w) => `'${w.replaceAll("'", "'\\''")}'`;
  const escape = (w) => w.replace(/[\\"$`]/g, "\\$&");
  const args = values.slice(1);
  return text
    .replace(/"\$(?:@|\{@\})"/g, () => args.map(quote).join(" "))
    .replace(/\$(?:(\d)|\{(\d+)\})/g, (_, a, b) => escape(values[Number(a ?? b)] ?? ""))
    .replace(/\$(?:[@*]|\{[@*]\})/g, () => args.map(escape).join(" "));
}

const SHELL_SCRIPT_NAME = /\.(sh|bash|zsh)$/i;

/** The shell a script's #! line names (directly or through env), or null. */
function shebangShell(text) {
  const m = /^#!\s*(\S+)([^\n]*)/.exec(text);
  if (!m) return null;
  let words = [m[1], ...m[2].trim().split(/\s+/).filter(Boolean)];
  if (base(words[0]) === "env") {
    words = words.slice(1);
    while (words.length > 0 && (words[0].startsWith("-") || isAssignment(words[0]))) words = words.slice(/^(-u|--unset|-C|--chdir)$/.test(words[0]) ? 2 : 1);
  }
  return SCRIPT_SHELLS.has(base(words[0] ?? "")) ? base(words[0]) : null;
}

/**
 * Text of a script run by path (./x.sh, /tmp/p.sh) when it is a shell
 * script: its #! line names a shell, or it has none and a .sh, .bash or .zsh
 * name. Null when a script with a shell name cannot be read; undefined otherwise.
 */
function pathScript(argv, dir) {
  if (!argv[0]?.includes("/") || INTERPRETERS.has(base(argv[0]))) return undefined;
  // After a cd to a generated or unresolved directory (cd "$root_dir"), the script is read from the directory before that cd.
  const known = dir.filter((part) => !part.includes(SUB) && !part.includes("$"));
  const text = readNamed(argv[0], dir) ?? (known.length === dir.length ? null : readNamed(argv[0], known));
  if (text === null) return SHELL_SCRIPT_NAME.test(argv[0]) ? null : undefined;
  if (text.startsWith("#!")) return shebangShell(text) ? text : undefined;
  return SHELL_SCRIPT_NAME.test(argv[0]) ? text : undefined;
}

/** Text of a shell script the command runs from a file, or undefined when it runs none. */
function shellScript(cmd, argv, segment, dir) {
  if (!SCRIPT_SHELLS.has(cmd) && cmd !== "source" && cmd !== ".") return pathScript(argv, dir);
  if (SCRIPT_SHELLS.has(cmd) && shellInline(argv)) return undefined;
  // --rcfile, --init-file and -o take a value, which is not the script.
  const file = argv.slice(1).find((w, i) => !w.startsWith("-") && !w.startsWith("+") && !/^([-+][a-zA-Z]*[oO]|--rcfile|--init-file)$/.test(argv[i] ?? ""));
  if (file !== undefined) return readNamed(file, dir) ?? null;
  if (segment.ins.length > 0) return readNamed(segment.ins[0], dir) ?? null;
  return undefined;
}

const DOCKER_VALUE_FLAGS =
  /^(-e|--env|--env-file|-u|--user|-w|--workdir|-v|--volume|--mount|--name|--network|--net|-p|--publish|--add-host|-l|--label|--label-file|--platform|--entrypoint|--detach-keys|-h|--hostname|--cpus|-m|--memory|--pull|--restart|--dns|--cap-add|--cap-drop|--device|--gpus|--ipc|--pid|--security-opt|--tmpfs|--ulimit|--log-driver|--log-opt|--cidfile|--shm-size|--stop-signal|--stop-timeout|--userns|--runtime|--link|--expose|--group-add|--volumes-from|--ip|--network-alias|-a|--attach|-f|--file|--project-name|--profile|--project-directory|--index)$/;

/** The command and environment a docker or podman run/exec (compose included) starts inside the container, or null. */
function dockerInner(argv) {
  if (!/^(docker|podman)$/.test(base(argv[0]))) return null;
  let i = 1;
  const env = {};
  let entrypoint;
  const options = () => {
    for (; i < argv.length && argv[i].startsWith("-"); i++) {
      const eq = /^(--[\w-]+)=(.*)$/s.exec(argv[i]);
      const [flag, value] = eq ? [eq[1], eq[2]] : DOCKER_VALUE_FLAGS.test(argv[i]) ? [argv[i], argv[++i]] : [argv[i], undefined];
      if (flag === "--entrypoint") entrypoint = value;
      if ((flag === "-e" || flag === "--env") && value?.includes("=")) env[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
    }
  };
  options();
  let sub = argv[i++];
  if (sub === "container" || sub === "compose") {
    options();
    sub = argv[i++];
  }
  if (sub !== "run" && sub !== "exec") return null;
  options();
  const rest = argv.slice(i + 1);
  const inner = entrypoint ? [entrypoint, ...rest] : rest;
  return inner.length > 0 ? { argv: inner, env } : null;
}

/** True when argv runs tools/guardrails/apply.mjs, by path or through an interpreter. */
function runsInstaller(argv, dir) {
  const isInstaller = (w) => /(^|\/)tools\/guardrails\/apply\.mjs$/i.test(wordSegs(w, dir)?.join("/") ?? "");
  if (isInstaller(argv[0] ?? "")) return true;
  return INTERPRETERS.has(base(argv[0])) && !SHELLS.has(base(argv[0])) && argv.slice(1).some(isInstaller);
}

function checkSegment(segment, state, dir, ctx, depth, substs) {
  const { argv, wrappers, env } = unwrap(segment.words);
  const cmd = base(argv[0]);
  if (runsInstaller(argv, dir)) return "runs tools/guardrails/apply.mjs, which installs the guardrail; only the lead runs it, with Blaine's approval";
  const shellAlias = cmd === "git" ? gitCall(argv, dir, ctx, state.gitAliases, state.gitIncludes) : null;
  if (shellAlias?.shell !== undefined) {
    // git runs sh -c '<alias> "$@"' '<alias>' <arguments>, so the arguments are put where the text uses them. A generated
    // argument becomes a placeholder word, so the later ones keep their positions.
    const values = shellAlias.shellArgs.map((w) => (w.includes(SUB) ? "_generated_" : w));
    const text = withPositional(`${shellAlias.shell} "$@"`, [shellAlias.shell, ...values]);
    const reason = checkCommand(text, shellAlias.dir, ctx, depth + 1);
    if (reason) return `git shell alias: ${reason}`;
  }
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
  let inline = [];
  if (cmd === "eval") inline = [argv.slice(1).join(" ")];
  else if (SCRIPT_SHELLS.has(cmd)) inline = shellInline(argv) ?? [];
  else if (SHELLS.has(cmd) || /^(npx|npm)$/.test(cmd)) inline = argv.filter((w, i) => /^(-c|--call)$/.test(argv[i - 1] ?? ""));
  for (const text of inline) {
    const reason = checkCommand(text, dir, ctx, depth + 1);
    if (reason) return reason;
  }
  if (cmd === "trap" && argv[1]) {
    const reason = checkCommand(argv[1], dir, ctx, depth + 1);
    if (reason) return `trap: ${reason}`;
  }
  const docker = dockerInner(argv);
  const inner = docker?.argv ?? runnerInner(argv);
  if (inner) {
    const innerState = { ...state, env: { ...state.env, ...env, ...docker?.env } };
    const reason = checkSegment({ ...segment, words: inner, op: null }, innerState, dir, ctx, depth + 1, substs);
    if (reason) return reason;
  }
  if (cmd === "concurrently") {
    for (const command of argv.slice(1).filter((w) => !w.startsWith("-"))) {
      const reason = checkCommand(command, dir, ctx, depth + 1);
      if (reason) return reason;
    }
  }
  const gh = cmd === "gh" ? ghCall(argv).argv : argv;
  if (cmd === "gh" && gh[1] === "alias" && /^(set|import)$/.test(gh[2] ?? "")) return "gh alias set/import could hide a merge behind a new name; aliases are set by Blaine";
  const cli = supabaseCli(argv);
  const cliReason = cli && supabaseReason(cli);
  if (cliReason) return cliReason;
  if (PG_CLIENTS.test(cmd)) {
    const reason = pgReason(argv, { ...state.env, ...env });
    if (reason) return reason;
  }
  if (/^(curl|wget|http|https)$/.test(cmd)) {
    const reason = supabaseHttpReason(argv, dir);
    if (reason) return reason;
  }
  const calls = scriptCalls(argv, dir);
  const unknownRunner = (inner && !PACKAGE_MANAGERS.test(base(inner[0]))) || ORCHESTRATORS.test(cmd);
  const named = unknownRunner ? namedScripts(inner && !ORCHESTRATORS.test(cmd) ? inner : argv, dir) : [];
  const scripts = scriptsReason([...calls, ...named], ctx, depth);
  if (scripts) return scripts;
  const target = mergeTarget(argv, { ...state.env, ...env }, dir);
  const merge = target && mergeReason(target, ctx);
  if (merge) return merge;
  const fullArgv = wrappers.has("xargs") && piped ? [...argv, ...state.prevArgs] : argv;
  return protectedWrite(fullArgv, segment, dir, substs, ctx, state);
}

/** Records an alias or include file that git config sets in this command, so a later git <alias> in it is expanded. */
function recordGitAlias(argv, dir, state) {
  if (base(argv[0]) !== "git") return;
  const git = gitCall(argv, dir, null, state.gitAliases, state.gitIncludes);
  const args = git.argv.slice(2);
  if (git.argv[1] !== "config" || args.some((w) => /^--(get|get-all|get-regexp|unset|unset-all|list)$|^-l$/.test(w))) return;
  const at = args.findIndex((w) => /^alias\.[^=]+$/i.test(w));
  if (at >= 0 && args[at + 1] !== undefined) state.gitAliases[args[at].slice(6).toLowerCase()] = args[at + 1];
  const include = args.findIndex((w) => GIT_INCLUDE_KEY.test(w));
  if (include >= 0 && args[include + 1] !== undefined) state.gitIncludes.push(`${args[include]}=${args[include + 1]}`);
}

/**
 * The directory a cd leads to. ~ and a bare cd are expanded from HOME; cd - goes back to the directory before the last
 * cd in this command. A directory that cannot be known gets an unresolved part, so git calls there fail closed.
 */
function cdTarget(dir, target, oldDir) {
  if (target === "-") return oldDir ?? [...dir, "$OLDPWD"];
  const home = process.env.HOME;
  if (target === undefined || target === "~" || target.startsWith("~/")) {
    return home?.startsWith("/") ? changeDir(changeDir([], home), (target ?? "~").slice(2)) : [...dir, "$HOME"];
  }
  if (target.startsWith("~")) return [...dir, "$HOME"];
  return changeDir(dir, target);
}

function checkCommand(src, dir, ctx, depth = 0) {
  if (depth > 6) return "command nests too deeply to check";
  // In collect mode (used by the tests to list every reason) a reason is recorded and checking goes on.
  const report = (reason) => {
    if (!reason || !ctx.collect) return reason;
    ctx.collect.push(reason);
    return null;
  };
  const { segments, substs } = parse(expandVars(src));
  for (const inner of substs) {
    const reason = report(checkCommand(inner, dir, ctx, depth + 1));
    if (reason) return reason;
  }
  const state = { decoded: false, env: {}, prevArgs: [], inTest: false, gitAliases: {}, gitIncludes: [], oldDir: undefined };
  for (const segment of segments) {
    const { argv, env } = unwrap(segment.words);
    const cmd = base(argv[0]);
    if (argv.length === 0 || cmd === "export") {
      Object.assign(state.env, env);
      for (const w of argv.slice(1)) if (isAssignment(w)) state.env[w.slice(0, w.indexOf("="))] = w.slice(w.indexOf("=") + 1);
    }
    if (state.inTest) {
      state.inTest = !segment.words.includes("]]");
      continue;
    }
    if (cmd === "[[" && !segment.words.includes("]]")) state.inTest = true;
    if (cmd === "cd" || cmd === "pushd") {
      [dir, state.oldDir] = [cdTarget(dir, argv.slice(1).find((w) => w === "-" || !w.startsWith("-")), state.oldDir), dir];
      continue;
    }
    const reason = report(checkSegment(segment, state, dir, ctx, depth, substs));
    if (reason) return reason;
    recordGitAlias(argv, dir, state);
    recordBranch(argv, dir, state, ctx);
    state.prevArgs = argv.slice(1);
  }
  return null;
}

/** Block reason for an execute_sql query that is not a single read only statement. */
export function sqlReason(sql) {
  if (typeof sql !== "string") return "execute_sql has no query string; failing closed";
  if (/(^|[^\w$])"?pgmq"?\s*\.\s*"?[\w$]+"?\s*\(/i.test(sql)) return "execute_sql calls a pgmq function, which changes queue state";
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
      if (/(^|[^\w$])U&\s*$/i.test(sql.slice(0, i))) return "execute_sql has a U& escaped string or identifier, which cannot be checked; failing closed";
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
      // A quoted identifier called as a function, or naming a schema before a dot, keeps its name.
      if (quote === "'") text += " '' ";
      else if (/^\s*\(/.test(sql.slice(i))) text += ` ${inner}`;
      else text += /^\s*\./.test(sql.slice(i)) ? ` ${inner.replace(/[^\w$]/g, "_") || "q"}` : " q ";
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
  if (write) return `execute_sql query contains "${write[0].trim()}", which is not read only`;
  // A schema qualified call into an app schema may be a user defined function that writes; system schemas and the
  // Supabase auth helpers that read the request (auth.uid, auth.role, auth.jwt, auth.email) stay allowed.
  for (const m of statement.matchAll(/(?:^|[^\w$.])([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)\s*\(/g)) {
    const [schema, fn] = [m[1].toLowerCase(), m[2].toLowerCase()];
    if (SQL_SYSTEM_SCHEMAS.has(schema) || (schema === "auth" && SQL_AUTH_READS.has(fn))) continue;
    return `execute_sql calls a function in the ${m[1]} schema, which may write; failing closed`;
  }
  return null;
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
 * cannot; it defaults to gh. With options.collect, returns every reason
 * found in a Bash command as an array instead (tests use it).
 */
export function decide(payload, options = {}) {
  const input = payload?.tool_input;
  if (input == null || typeof input !== "object") return "tool_input is missing; failing closed";
  const tool = String(payload.tool_name ?? "");
  const cwdPath = resolve(payload.cwd || process.cwd());
  const ctx = { prFiles: options.prFiles ?? ghPrFiles, cwd: cwdPath, visited: new Set(), gitAliases: new Map(), branches: [], collect: options.collect ? [] : null };
  const cwd = changeDir([], cwdPath);
  if (tool.startsWith("mcp__")) return checkMcp(tool, input, ctx);
  if (EDIT_TOOLS.has(tool)) return checkEdit(input, cwd);
  if (tool !== "Bash") return null;
  if (typeof input.command !== "string") return "tool_input.command is missing; failing closed";
  const reason = checkCommand(input.command, cwd, ctx);
  return ctx.collect ?? reason;
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
