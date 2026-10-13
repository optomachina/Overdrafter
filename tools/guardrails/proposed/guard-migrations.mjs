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
 *   normalized first), git apply or git am of a patch that names them or
 *   that lands in them under --directory (after -p), any pipe into a
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
 * - git push to main. A literal destination that is main or master blocks,
 *   and a wildcard one blocks when it matches refs/heads/main or master. A
 *   push of the current branch (no refspec, HEAD, @, an empty destination, or
 *   a destination built by a variable or substitution that could spell
 *   main) is judged in two ways:
 *   with no git checkout, switch or branch -m before it in the command, git
 *   reads the branch in the push's own directory (failing closed when it
 *   cannot) and main or master blocks, and for a push with no refspec every
 *   remote.<name>.push refspec of the remote counts, else push.default is
 *   applied as git does (git rev-parse @{push} for the push remote); after
 *   one, only a new branch made right before the push (checkout -b, -B or
 *   --orphan, switch -c or -C, a literal name that is not main or master,
 *   same directory, no cd after it, no subshell, compound command or !,
 *   joined by && only; with no refspec also push.default simple or current)
 *   passes and everything else fails closed. A refspec with no colon that
 *   names a local branch is mapped as git maps it (remote.<name>.push, then
 *   push.default upstream through branch.<name>.merge), and a push with no
 *   refspec to a remote with remote.<name>.mirror true blocks. In a variable
 *   assigned from $PWD, $OLDPWD or a command substitution that part becomes
 *   an unresolved placeholder and the rest of the path is kept (quoted and
 *   unquoted parts of the value are joined; NAME= counts only at a word
 *   start outside quotes; assignments before a command word reach only the
 *   single quoted or escaped text of that command, such as its -c text;
 *   X+=v appends and unset X unsets; an assignment in a subshell ends with
 *   it, and one that may not run (after && or ||, in a pipeline, or in an
 *   if, case, loop or { } body) leaves both values possible, each checked;
 *   ${VAR:-x} and ${VAR-x} give the value of a known VAR and stay as
 *   written otherwise; eval of a command that is not known fails closed;
 *   timeout and time options with values are skipped), and a .. after an
 *   unresolved part keeps it unresolved. A dry run and tags only pass.
 *   Aliases from -c, git config, the repository config (include files too)
 *   and the GIT_CONFIG environment are expanded. Also the merges API,
 *   writes to the main ref, and contents API writes to main, master or an
 *   unnamed or empty (default) branch;
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
import { dirname, resolve } from "node:path";
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
// git config keys that decide where a push with no refspec goes.
const PUSH_CONFIG_KEY = /^(push\.default|remote\..+\.(push|fetch|url|mirror)|remote\.pushdefault|branch\..+\.(remote|pushremote|merge))$/i;
// Environment variables that change which git config is read, so an alias can come from them.
const GIT_CONFIG_ENV = /^(GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_PARAMETERS)$/;
const WRAPPERS = new Set(["env", "sudo", "command", "builtin", "exec", "nohup", "time", "nice", "timeout", "xargs", "stdbuf", "ionice", "chrt", "taskset"]);
// Shell keywords that start a command, and words that never write a file (keywords and assignment builtins).
const PREFIX_KEYWORDS = new Set(["!", "{", "do", "then", "else", "elif", "if", "while", "until"]);
// Words that open and close a compound command, and the keywords inside one.
const COMPOUND_OPEN = new Set(["if", "while", "until", "for", "select", "case", "{"]);
const COMPOUND_CLOSE = new Set(["fi", "done", "esac", "}"]);
const COMPOUND_INNER = new Set(["then", "do", "else", "elif", "!"]);
const NO_WRITE_WORDS = new Set(["for", "select", "case", "in", "done", "fi", "esac", "}", "[[", "]]", "readonly", "local", "declare", "typeset", "export", "return", "exit", "shift", "set", "unset", "trap"]);
const VALUE_FLAGS = new Set(["-I", "-n", "-P", "-L", "-d", "-s", "-u", "-g"]);
// Wrapper options that take the next word as their value, beyond VALUE_FLAGS.
const WRAPPER_VALUE_FLAGS = {
  timeout: new Set(["--signal", "-k", "--kill-after"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  env: new Set(["--unset", "-C", "--chdir"]),
  nice: new Set(["--adjustment"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  chrt: new Set(["-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"]),
};
// chrt takes a priority and taskset a CPU mask or list before the command; a word with a digit there is that value.
const WRAPPER_NUMBER = /^(timeout|chrt|taskset)$/;
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

/**
 * Shell lexer: returns segments ({ words, outs, ins, heredocs, op, depth }) and the bodies of $( ), backticks and <( ).
 * op is the operator before the segment and depth the number of subshell parentheses it sits in.
 */
function parse(src) {
  let depth = 0;
  const newSegment = (op) => ({ words: [], outs: [], ins: [], heredocs: [], op, depth });
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
      if (op === "(") depth++;
      else if (op === ")") depth = Math.max(0, depth - 1);
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
 * reference. Quoted and unquoted parts of a value are joined the way the shell
 * joins them. Arrays, escaped values and values that would split into several
 * words are not recorded, so references to them stay unresolved.
 */
const PWD_REF = /\$(?:\{((?:OLD)?PWD)\}|((?:OLD)?PWD)(?!\w))/g;
// A command substitution in a value is not known from the text. Like $PWD it becomes a placeholder that still holds $, so
// a cd to the value stays unresolved while the literal segments after it (supabase/migrations, .claude/hooks) are checked.
const SUBST_AT_ASSIGN = "$__SUBST_AT_ASSIGN";

/** The index just past the ) that closes a $( substitution whose body starts at i. Quoted spans are skipped. */
function substitutionEnd(src, i) {
  for (let depth = 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'" || c === '"') i = indexOrEnd(src, c, i + 1);
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return src.length;
}

/** The index of the " that closes a double quoted span opened at i, or -1 when nothing closes it. */
function closingQuote(src, i) {
  for (i++; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === '"') return i;
  }
  return -1;
}

/** Reads the assignment value that starts at i. Returns where it ends and its text, or text null when it cannot be recorded. */
function readValue(src, i) {
  // An array value is skipped whole and drops the old value.
  if (src[i] === "(") return { end: Math.min(matchClose(src, i, "(", ")") + 1, src.length), text: null };
  let text = "";
  let recordable = true;
  let quoted = false;
  while (i < src.length) {
    const c = src[i];
    if (!quoted && /[\s;&|<>)]/.test(c)) break;
    if (c === "\\") {
      // The escaped character is taken as it is, so an escaped quote neither opens nor closes a quoted part.
      recordable = false;
      text += src.slice(i, i + 2);
      i += 2;
    } else if (c === '"') {
      // A quote that nothing closes is left to the caller, so the rest of the command is not read as the value.
      if (!quoted && closingQuote(src, i) < 0) {
        recordable = false;
        break;
      }
      quoted = !quoted;
      i++;
    } else if (c === "'" && !quoted) {
      const close = src.indexOf("'", i + 1);
      if (close < 0) {
        recordable = false;
        break;
      }
      // A single quoted $ is literal; recording it would let a later expansion read it as a reference.
      if (src.slice(i + 1, close).includes("$")) recordable = false;
      text += src.slice(i + 1, close);
      i = close + 1;
    } else if (c === "`") {
      text += SUBST_AT_ASSIGN;
      i = indexOrEnd(src, "`", i + 1) + 1;
    } else if (c === "$" && src[i + 1] === "(") {
      text += SUBST_AT_ASSIGN;
      i = substitutionEnd(src, i + 2);
    } else {
      if (c === "$" && src[i + 1] === "'") recordable = false;
      text += c;
      i++;
    }
  }
  // Blanks are kept: an unquoted reference splits into words as the shell splits it. A newline or quote would be read as
  // syntax when the value is put back into the text, so such a value is not recorded. A value with an operator is marked
  // (see valueOf) and put back only inside double quotes, where the operator is text.
  if (quoted || /[\n"'\\`]/.test(text)) recordable = false;
  return { end: Math.min(i, src.length), text: recordable ? text : null };
}

// Marks a value that holds an operator (; & | < > ( )). It is put back only inside double quotes, where the shell reads
// the operator as text ("$C" for eval "$C"); anywhere else it stays unresolved, as an unknown value does.
const OPERATOR_VALUE = "\u0002";
const OPERATOR = /[;&|<>()]/;
// After source or . runs a file, a variable it may have set is this placeholder, which still holds $. A write target or
// push destination that holds it fails closed; anywhere else it is an unresolved value. These are rarely set by a file.
const SOURCED_AT = "$__SOURCED_";
const SOURCE_KEPT = new Set(["HOME", "PWD", "OLDPWD", "TMPDIR", "USER", "PATH"]);
// The key in the variable table that records that a file was sourced; it cannot be a variable name.
const SOURCED_KEY = "@sourced";

/**
 * The value of ${name<op>word} when name is known (null when it is known to be unset): the - and = forms give the value when it is set (with a colon, set and
 * not empty) and else the word, + gives the word or nothing the other way round, and ? gives the value or stays as
 * written. An unknown name stays as written, so a default is never taken for a value that may be set outside the command.
 */
function expandDefault(value, colon, op, word, seen) {
  if (value === undefined) return seen;
  // null is a variable known to be unset.
  const set = value !== null && (colon ? value !== "" : true);
  if (op === "+") return set ? word : "";
  if (op === "?") return set ? value : seen;
  return set ? value : word;
}

// A reference: ${name<op>word}, ${name} or $name. The word may hold $name, ${name} and ${name<op>plain word} references.
// A bare $name in the word matches its whole name ((?!\w)), so a name is never split between the two alternatives, which
// would backtrack exponentially on a long word that does not match.
const REF =
  String.raw`\$(?:\{([A-Za-z_]\w*)(:?)([-=+?])((?:[^}$` +
  "`" +
  String.raw`]|\$\{[A-Za-z_]\w*(?::?[-=+?][^}$` +
  "`" +
  String.raw`]*)?\}|\$[A-Za-z_]\w*(?!\w))*)\}|\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))`;

/**
 * An assignment group starting at i: name=value and name+=value words separated by blanks. Returns the end, the values
 * read as [name, text, append], and whether a command follows.
 */
function readAssignments(src, i) {
  const values = [];
  const head = /([A-Za-z_]\w*)(\+?)=/y;
  for (;;) {
    head.lastIndex = i;
    const m = head.exec(src);
    if (!m) break;
    const { end, text } = readValue(src, i + m[0].length);
    values.push([m[1], text, m[2] === "+"]);
    i = end;
    const blank = /[ \t]*/y;
    blank.lastIndex = i;
    blank.exec(src);
    if (blank.lastIndex === i) break;
    i = blank.lastIndex;
  }
  // Assignments before a command word apply to that command only and leave the shell variables as they were.
  const prefix = i < src.length && !/[\s;&|)#]/.test(src[i]) && values.length > 0 && !/^[A-Za-z_]\w*\+?=/.test(src.slice(i));
  return { end: i, values, prefix };
}

/** The end of the simple command that continues at i: the first ; & | newline or ) outside quotes and substitutions. */
function commandEnd(src, i) {
  for (; i < src.length; i++) {
    const c = src[i];
    if (/[;&|\n)]/.test(c)) return i;
    if (c === "\\") i++;
    else if (c === "'") i = indexOrEnd(src, "'", i + 1);
    else if (c === '"') i = Math.max(i, closingQuote(src, i) < 0 ? src.length : closingQuote(src, i));
    else if (c === "`") i = indexOrEnd(src, "`", i + 1);
    else if (c === "$" && src[i + 1] === "(") i = substitutionEnd(src, i + 2) - 1;
  }
  return src.length;
}

// X+=v when X is not known: the old part is a placeholder that still holds $, like a command substitution.
const APPEND_AT_ASSIGN = "$__APPEND_AT_ASSIGN";
// Keywords that open, divide and close a compound command whose body may not run, or may run in one branch only.
// A { } group is counted too, since it may be a function body that runs later or never.
const BODY_OPEN = /^(if|case|while|until|for|select|\{)$/;
const BODY_SPLIT = /^(else|elif|;;)$/;
const BODY_CLOSE = /^(fi|esac|done|\})$/;
// The most variable value combinations checked for one command text; past it the command fails closed.
const MAX_VARIANTS = 32;
// The most command readings (expanded texts, nested ones included) checked for one call; past it the call fails closed.
const MAX_WORK = 400;
// While the readings stay at or under MAX_VARIANTS, every default word and every loop item gets its own reading. Only past
// it may a word be folded into one unknown value (which is how a variable set outside the command is read), and only when
// it is safe: plain characters only (a - inside the word, not leading; no : or +), no glob, not a . or .. step, no
// protected path text or part of one, and not a command or subcommand word the checks look for or a package.json script
// name. Any other word keeps its own reading. The word must also stand as a whole argument where it is used (see
// wholeRef), since glued to other text (supa$s, m$p, --$f) even a plain word can complete a protected name.
const SAFE_CHARS = /^[A-Za-z0-9_.,@%=/-]+$/;
const PROTECTED_NAMES = ["supabase", "migrations", "github", "workflows", "claude", "hooks", "settings", "tools", "guardrails", "main", "master", "head"];
const PROTECTED_PART = new RegExp(PROTECTED_NAMES.join("|"), "i");
const CHECK_WORDS = new Set([
  "push", "deploy", "secrets", "query", "repair", "projects", "orgs", "branches", "storage", "functions", "db", "all", "mirror",
  "matching", "link", "reset", "merge", "migration", "new", "squash", "fetch", "pull", "delete", "sso", "domains", "config",
  "backups", "snippets", "tags", "force", "run", "exec", "apply", "diff", "schema", "sync", "rum", "urn", "npm", "npx", "pnpm",
  "yarn", "node", "env", "sh", "bash", "zsh", "psql", "git", "gh", "supabase", "docker",
]);
function safeWord(w, scripts, strict = false) {
  if (!SAFE_CHARS.test(w) || /^[@-]/.test(w) || /(?:^|\/)\.\.?(?:\/|$)/.test(w) || PROTECTED_PART.test(w)) return false;
  const lower = w.toLowerCase();
  if (CHECK_WORDS.has(lower) || scripts.has(w)) return false;
  // A part of a protected name (supa, ain, igration) completes it when glued to text the check cannot see. A short part
  // is safe only where the word is used whole; a value held in a variable (strict) may be glued wherever it is used.
  return (!strict && lower.length < 3) || !PROTECTED_NAMES.some((n) => n.includes(lower));
}
// Text before and after a reference that makes it a whole argument or a whole part of one: a blank, an operator or the
// command's edge, a double quote that itself stands at such an edge, or a separator (= : / ,) that starts or ends a value,
// a refspec side or a path step. Glued to any other text (supa$s, m$p, --$f, $p"ain") it is not whole.
const ARG_EDGE_BEFORE = /(?:^|[\s;&|(])"?$|[=:/,]$/;
const ARG_EDGE_AFTER = /^"?(?:$|[\s;&|)])|^[:/,]/;
/** Whether the reference src[start, end) stands as a whole argument or a whole part of one. */
const wholeRef = (src, start, end) => ARG_EDGE_BEFORE.test(src.slice(Math.max(0, start - 2), start)) && ARG_EDGE_AFTER.test(src.slice(end, end + 2));
/** Whether the reference src[start, end) follows an = , so its value may be stored and glued later. */
const afterEquals = (src, start) => src[start - 1] === "=";
// A merge of an unknown PR fails closed, so in a command that merges any word may be the PR and every word is read.
const MERGE_TEXT = /merge/i;
// The placeholders that stand for a value the command made itself; a sourced file cannot set them.
const INTERNAL_NAME = /^__(?:(?:OLD)?PWD_AT_ASSIGN|SUBST_AT_ASSIGN|APPEND_AT_ASSIGN|SOURCED_\w*)$/;
// The head of a function definition just before its { body: name() or function name.
const FUNCTION_HEAD = /(?:(?:^|[\s;&|(){}])function[ \t]+[^\s;&|<>()]+(?:[ \t]*\(\))?|(?:^|[\s;&|{}])[A-Za-z_][\w.:-]*[ \t]*\([ \t]*\))[ \t\n]*$/;

/** The possible values held in a variable slot: undefined (not known), null (unset) or a string. */
const altsOf = (v) => (v !== null && typeof v === "object" ? v.alts : [v]);
function union(values) {
  const alts = [];
  for (const v of values.flatMap(altsOf)) if (!alts.includes(v)) alts.push(v);
  return alts.length === 1 ? alts[0] : { alts };
}

/**
 * Every text the command can expand to, or null when there are more than MAX_VARIANTS. A variable that an assignment may
 * or may not have changed holds both values, and each combination of the values used is one text. Every default word and
 * loop item is read on its own first; only when that passes MAX_VARIANTS are the safe ones folded (see safeWord).
 */
function expandVariants(src, scripts) {
  // The script names are read only when folding needs them, since reading them runs git.
  return variantsOf(src, new Set(), false) ?? variantsOf(src, scripts(), true);
}

function variantsOf(src, scripts, fold) {
  const texts = [];
  let picks = [];
  for (let n = 0; n < MAX_VARIANTS; n++) {
    const counts = [];
    const text = expandVars(src, picks, counts, scripts, fold);
    if (!texts.includes(text)) texts.push(text);
    const next = counts.map((_, j) => picks[j] ?? 0);
    let k = counts.length - 1;
    while (k >= 0 && next[k] + 1 >= counts[k]) k--;
    if (k < 0) return texts;
    next[k]++;
    picks = next.slice(0, k + 1);
  }
  return null;
}

/**
 * Scans the command once, tracking quotes, substitutions and heredoc bodies. An assignment is recognized only at a word
 * start outside quotes, so NAME= inside a quoted string is text. A reference is expanded wherever it stands, since quoted
 * text may run again as -c or eval text. A prefix assignment (X=v cmd, env X=v cmd) does not change the shell variable;
 * its value is used only for the references that the child expands: single quoted and escaped ones in the rest of that
 * simple command. unset makes a variable known to be unset, and X+=v appends.
 *
 * An assignment in a subshell, $( ) or backticks is dropped at its end. One that may not run keeps the old value possible
 * too: after || or in a pipeline at once; after && or in the body of if, case or a loop it holds for the commands that run
 * only after it, and both values are possible once the && list ends, at else, elif and ;;, and after the body (a { }
 * group counts as a body, since it may be a function that runs later or never). picks and
 * counts choose among the possible values in the order they are read (see expandVariants); every reference to the same
 * value shares one pick. A variable that is not known gives ${X:-w}, ${X-w} and ${X:=w} two readings, as written and as
 * the word. A for loop over literal words records the loop variable with each word, local in a function body ends with
 * the body, and source or . marks every variable as possibly set by the file.
 */
function expandVars(src, picks = [], counts = [], scripts = new Set(), fold = false) {
  let vars = Object.create(null);
  let prefix = null;
  // Each scope records, for the variables assigned in it, the value before it and the values given in it.
  let scopes = [];
  let lastOp = null;
  let cmdStart = true;
  // Without fold every word gives a variable its own reading; with fold only a word that is not safe does (see safeWord).
  const anyWord = !fold || MERGE_TEXT.test(src);
  const forks = (w, strict) => anyWord || !safeWord(w, scripts, strict);
  // One pick per variable state: every reference to the same value, or to the same unknown variable between two
  // assignments, takes the same pick, so a variable used many times is one choice, not one per reference.
  const memo = new Map();
  const versions = Object.create(null);
  const pick = (key, n) => {
    if (!memo.has(key)) {
      const at = counts.length;
      counts.push(n);
      memo.set(key, picks[at] ?? 0);
    }
    return memo.get(key);
  };
  const lookup = (name, child) => {
    const raw = child && prefix && name in prefix.values ? prefix.values[name] : vars[name];
    if (raw === undefined && vars[SOURCED_KEY] && !SOURCE_KEPT.has(name) && !INTERNAL_NAME.test(name)) return SOURCED_AT + name;
    return raw !== null && typeof raw === "object" ? raw.alts[pick(raw, raw.alts.length)] : raw;
  };
  const store = (name, value) => {
    versions[name] = (versions[name] ?? 0) + 1;
    if (value === undefined) delete vars[name];
    else vars[name] = value;
  };
  const note = (scope, name, values) => {
    scope.pending[name] ??= { old: vars[name], seen: [] };
    scope.pending[name].seen.push(...values);
  };
  const merge = (scope) => {
    const parent = scopes[scopes.indexOf(scope) - 1];
    for (const [name, { old, seen }] of Object.entries(scope.pending)) {
      // A local variable of a function body ends with it and never reaches the variable outside.
      if (scope.locals && name in scope.locals) continue;
      if (parent) note(parent, name, seen);
      store(name, union([old, ...seen, vars[name]]));
    }
    for (const [name, old] of Object.entries(scope.locals ?? {})) store(name, old);
    scope.pending = {};
    scope.locals = undefined;
  };
  const assign = (name, value) => {
    // After || the next command may run whether or not the assignment did.
    if (lastOp === "||") return store(name, union([vars[name], value]));
    const scope = scopes.at(-1);
    if (scope) note(scope, name, [value]);
    store(name, value);
  };
  const endList = () => {
    while (scopes.at(-1)?.kind === "chain") merge(scopes.pop());
    lastOp = null;
  };
  const unmark = (v) => (typeof v === "string" && v.startsWith(OPERATOR_VALUE) ? v.slice(1) : v);
  const mark = (v) => (OPERATOR.test(v) ? OPERATOR_VALUE + v : v);
  // dq: the reference stands inside double quotes of this text, where an operator value is text. nested: the reference is
  // part of a default word or a loop item, so it is never a whole argument. held: the text is an assigned value, which a
  // later reference may glue to other text, so a safe word must pass the strict check.
  const resolve = (child, dq, nested = false, held = false) => (seen, name, colon, op, word, braced, bare, at, text) => {
    const shown = (v) => {
      if (typeof v !== "string" || !v.startsWith(OPERATOR_VALUE)) return v;
      return dq ? v.slice(1) : undefined;
    };
    if (name === undefined) {
      const value = shown(lookup(braced ?? bare, child));
      return value === undefined ? seen : (value ?? "");
    }
    const plain = !nested && typeof text === "string" && wholeRef(text, at, at + seen.length) && !forks(word, held || afterEquals(text, at));
    // ${X:-$Y} takes the value of Y as its word.
    word = word.replace(new RegExp(REF, "g"), resolve(child, dq, true));
    const value = shown(lookup(name, child));
    if (value === undefined && (op === "-" || op === "=")) {
      // A variable that is not known may be set or not, so the reference is both as written and the word; ${X:=word}
      // also records X with the word in the second case. Past the cap, a safe word standing as a whole argument is read
      // as written only.
      if (plain || pick(`?${name}#${versions[name] ?? 0}${colon}`, 2) === 0) return seen;
      if (op === "=" && !child) assign(name, word);
      return word;
    }
    const result = expandDefault(value, colon, op, word, seen);
    // ${X:=word} also assigns X.
    if (op === "=" && value !== undefined && !child) assign(name, result);
    return result;
  };
  const ref = new RegExp(REF, "g");
  const refAt = new RegExp(REF, "y");
  const head = /[A-Za-z_]\w*\+?=/y;
  const keyword = /(if|case|while|until|for|select|else|elif|fi|esac|done|then|do|\{|\}|!)(?=[\s;&|()]|$)/y;
  const unset = /unset((?:[ \t]+-[a-z]+)*)((?:[ \t]+[A-Za-z_]\w*)+)[ \t]*(?=[;&|)\n#]|$)/y;
  const sourceWord = /(source|\.)(?=[ \t])/y;
  // for NAME in WORDS: plain words and quoted words without backslash or glob characters, which may hold $name and ${name}.
  // A reference matches its whole name, so a word is read only one way (no backtracking across splits of a name).
  const forRef = String.raw`\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*(?!\w))`;
  const forWord = String.raw`(?:[^\s;&|<>()'"\`\\$*?[\]{}]|${forRef})+|'[^'\n$]*'|"(?:[^"$\`\\\n]|${forRef})*"`;
  const forList = new RegExp(String.raw`[ \t]+([A-Za-z_]\w*)[ \t]+in((?:[ \t]+(?:${forWord}))*)[ \t]*(?=[;\n])`, "y");
  // Unquoted, a word's references split on blanks; quoted, the word is one item.
  const forItems = (list) =>
    (list.match(new RegExp(forWord, "g")) ?? []).flatMap((w) => {
      if (w.startsWith("'")) return [w.slice(1, -1)];
      const text = w.replace(/^"(.*)"$/s, "$1").replace(new RegExp(REF, "g"), resolve(false, true, true));
      return w.startsWith('"') ? [text] : text.split(/[ \t]+/).filter(Boolean);
    });
  const forName = /[ \t]+([A-Za-z_]\w*)/y;
  // Whether every reference to name after from is a plain $name or ${name} that stands as a whole argument: "glued" when
  // one does not, "value" when one follows an = (so the value may be stored and glued later), and "whole" otherwise.
  const usesWhole = (name, from) => {
    const uses = new RegExp(String.raw`\$(?:\{[#!]?)?${name}(?!\w)\}?`, "g");
    uses.lastIndex = from;
    let whole = "whole";
    for (let m; (m = uses.exec(src)); ) {
      if (m[0] !== `$${name}` && m[0] !== `\${${name}}`) return "glued";
      if (!wholeRef(src, m.index, m.index + m[0].length)) return "glued";
      if (afterEquals(src, m.index)) whole = "value";
    }
    return whole;
  };
  // for NAME in WORDS where a word is a glob or a brace list: a word that names a protected path is kept as written.
  const globList = new RegExp(String.raw`[ \t]+([A-Za-z_]\w*)[ \t]+in((?:[ \t]+[^\s;&|<>()'"\`\\]+)+)[ \t]*(?=[;\n])`, "y");
  // The loop variable is each word that keep picks, and one unknown value for all the others.
  const loopValue = (words, keep) => {
    const kept = words.filter(keep);
    return union(kept.length < words.length ? [undefined, ...kept] : kept);
  };
  // $PWD or $OLDPWD in a value is the directory at the time of the assignment, which a later cd cannot know from the text.
  // It becomes a placeholder that still holds $, like a command substitution. A value that cannot be recorded is undefined.
  // Inside a value an operator is text, so a reference is put in whatever it holds, and the value is marked when it holds one.
  const valueOf = (text) => (text === null ? undefined : mark(text.replace(PWD_REF, (seen, b, p) => `$__${b ?? p}_AT_ASSIGN`).replace(ref, resolve(false, true, false, true))));
  const appendTo = (old, text) => {
    if (text === undefined) return undefined;
    const before = old === undefined ? APPEND_AT_ASSIGN : (unmark(old) ?? "");
    return mark(before + unmark(text));
  };
  // After source or . the variables are wiped and marked as possibly set by the file, once its command ends.
  let sourcedAt = null;
  let out = "";
  let quote = null;
  let wordStart = true;
  const frames = [];
  const docs = [];
  const openFrame = (frame) => {
    frames.push({ ...frame, vars: { ...vars }, scopes: scopes.length, lastOp });
    lastOp = null;
    cmdStart = true;
  };
  const closeFrame = () => {
    const frame = frames.pop();
    if (frame.vars) ({ vars, lastOp } = frame);
    if (frame.vars) scopes = scopes.slice(0, frame.scopes);
    return frame.quote;
  };
  for (let i = 0; i < src.length; ) {
    if (prefix && i >= prefix.end) prefix = null;
    if (sourcedAt !== null && i >= sourcedAt) {
      vars = Object.create(null);
      vars[SOURCED_KEY] = true;
      sourcedAt = null;
    }
    const c = src[i];
    const next = src[i + 1];
    if (quote === null && wordStart && c === "#") {
      const eol = indexOrEnd(src, "\n", i);
      out += src.slice(i, eol);
      i = eol;
      continue;
    }
    if (quote === null && wordStart) {
      keyword.lastIndex = i;
      const k = keyword.exec(src)?.[1];
      // The { of function name { comes after the name, so it is not at a command start.
      const fn = k === "{" && FUNCTION_HEAD.test(src.slice(Math.max(0, i - 200), i));
      if (k !== undefined && (cmdStart || fn)) {
        if (BODY_OPEN.test(k)) scopes.push({ kind: "body", pending: {}, fn });
        if (k === "for") {
          // The loop variable holds each word of a literal list in turn that could change a check, and one unknown value
          // for the other words. Over a glob that names a protected path it holds the glob as written, so a write to it
          // fails closed; over any other glob or a reference it is not known.
          forList.lastIndex = i + k.length;
          globList.lastIndex = i + k.length;
          forName.lastIndex = i + k.length;
          const list = forList.exec(src);
          const globs = list ? null : globList.exec(src);
          const name = list?.[1] ?? globs?.[1] ?? forName.exec(src)?.[1];
          let words = [];
          let value;
          if (list) {
            // Past the cap, a safe word is folded only when every use of the loop variable is a whole argument.
            const uses = usesWhole(list[1], i);
            value = loopValue((words = forItems(list[2]).map(mark)), (w) => uses === "glued" || forks(w, uses === "value"));
          } else if (globs) {
            words = globs[2].trim().split(/[ \t]+/).map((w) => w.replace(new RegExp(REF, "g"), resolve(false, true, true)));
            value = loopValue(words, (w) => PROTECTED_TEXT.test(w));
          }
          if (name !== undefined && (words.length > 0 || !(list || globs))) assign(name, value);
        }
        const body = scopes.findLast((sc) => sc.kind === "body");
        if (BODY_SPLIT.test(k) && body) for (const [name, { old }] of Object.entries(body.pending)) store(name, old);
        if (BODY_CLOSE.test(k) && body) {
          while (scopes.at(-1) !== body) merge(scopes.pop());
          merge(scopes.pop());
        }
        out += k;
        i += k.length;
        wordStart = false;
        continue;
      }
      sourceWord.lastIndex = i;
      if (cmdStart && sourceWord.test(src)) sourcedAt = commandEnd(src, i);
      unset.lastIndex = i;
      const u = cmdStart ? unset.exec(src) : null;
      if (u && !/f/.test(u[1])) {
        for (const name of u[2].trim().split(/[ \t]+/)) assign(name, null);
        out += u[0];
        i += u[0].length;
        wordStart = false;
        cmdStart = false;
        continue;
      }
    }
    head.lastIndex = i;
    if (quote === null && wordStart && head.test(src)) {
      const { end, values, prefix: isPrefix } = readAssignments(src, i);
      if (isPrefix) {
        const at = commandEnd(src, end);
        prefix = { end: at, values: { ...(prefix && prefix.end === at ? prefix.values : {}) } };
        for (const [name, text, append] of values) prefix.values[name] = append ? appendTo(lookup(name, false), valueOf(text)) : valueOf(text);
      } else {
        // local (or declare and typeset without -g) in a function body makes a variable that ends with the body. Outside
        // a function body (in an if body or a { } group) it sets the variable as a plain assignment does.
        const local = /(?:^|[\s;&|(){}])(?:local|declare|typeset)(?:[ \t]+[-+](?![A-Za-z]*g)[A-Za-z]+)*[ \t]+$/.test(src.slice(Math.max(0, i - 80), i));
        const body = local ? scopes.findLast((sc) => sc.fn) : undefined;
        for (const [name, text, append] of values) {
          if (body) {
            body.locals ??= {};
            if (!(name in body.locals)) body.locals[name] = vars[name];
          }
          assign(name, append ? appendTo(lookup(name, false), valueOf(text)) : valueOf(text));
        }
      }
      out += src.slice(i, end);
      wordStart = /[ \t]/.test(src[end - 1]);
      i = Math.max(end, i + 1);
      continue;
    }
    if (quote === null && wordStart && !/[\s;&|()]/.test(c)) cmdStart = false;
    wordStart = false;
    if (c === "$" && quote !== "$'") {
      refAt.lastIndex = i;
      const m = refAt.exec(src);
      if (m) {
        const child = quote === "'" || src[i - 1] === "\\";
        out += resolve(child, !child && quote === '"')(...m, i, src);
        i = refAt.lastIndex;
        continue;
      }
    }
    let take = 1;
    if (quote === "'" || quote === "$'") {
      if (c === "\\" && quote === "$'") take = 2;
      else if (c === "'") quote = null;
    } else if (c === "\\") {
      // An escaped $ is still read as a reference above, as text a child shell expands.
      take = next === "$" ? 1 : 2;
    } else if (c === '"') {
      quote = quote === '"' ? null : '"';
    } else if (c === "`") {
      if (frames.at(-1)?.tick) quote = closeFrame();
      else {
        openFrame({ quote, tick: true });
        quote = null;
      }
    } else if (c === "$" && next === "(") {
      openFrame({ quote });
      quote = null;
      take = 2;
    } else if (quote === null) {
      if (c === "'") quote = "'";
      else if (c === "$" && next === "'") {
        quote = "$'";
        take = 2;
      } else if (c === "(") openFrame({ quote: null });
      else if (c === ")" && frames.length > 0 && !frames.at(-1).tick) quote = closeFrame();
      else if (c === "<" && next === "<" && src[i + 2] !== "<" && src[i - 1] !== "<") {
        const m = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(src.slice(i));
        if (m) {
          docs.push(m[2]);
          take = m[0].length;
        } else take = 2;
      } else if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
        // A list joined by && or || : an assignment after it may not run.
        if (c === "|") for (const scope of scopes.filter((sc) => sc.kind === "chain")) merge(scope);
        else if (scopes.at(-1)?.kind !== "chain") scopes.push({ kind: "chain", pending: {} });
        lastOp = c === "&" ? "&&" : "||";
        take = 2;
      } else if (c === "|") lastOp = "||";
      else if (c === ";" && next === ";") {
        endList();
        const body = scopes.findLast((sc) => sc.kind === "body");
        if (body) for (const [name, { old }] of Object.entries(body.pending)) store(name, old);
        take = 2;
      } else if (c === ";" || c === "\n" || (c === "&" && !/[<>]/.test(src[i - 1] ?? "") && next !== ">")) endList();
      if (/[\s;&|()]/.test(c)) wordStart = true;
      if (/[;&|(\n]/.test(c)) cmdStart = true;
      if (c === "\n" && docs.length > 0) {
        // Heredoc bodies are copied line by line with their references expanded and quotes not tracked.
        out += c;
        i++;
        for (const delim of docs.splice(0)) {
          while (i < src.length) {
            const eol = indexOrEnd(src, "\n", i);
            const line = src.slice(i, eol);
            out += line.replace(ref, resolve(false)) + (eol < src.length ? "\n" : "");
            i = eol + 1;
            if (line.replace(/^\t+/, "") === delim) break;
          }
        }
        continue;
      }
    }
    out += src.slice(i, i + take);
    i += take;
  }
  return out;
}

const base = (word = "") => word.split("/").pop();
const isAssignment = (w) => /^[A-Za-z_]\w*\+?=/.test(w);
/** The name and value of an assignment word; X+=v gives v. */
const assignmentOf = (w) => {
  const at = w.indexOf("=");
  return [w.slice(0, at).replace(/\+$/, ""), w.slice(at + 1)];
};

/** Strips leading assignments and wrapper commands; returns the argv, the wrappers seen and the assignments. */
function unwrap(words) {
  const env = {};
  let argv = [...words];
  const wrappers = new Set();
  const takeAssignments = () => {
    while (argv.length > 0 && isAssignment(argv[0])) {
      const [name, value] = assignmentOf(argv[0]);
      env[name] = value;
      argv = argv.slice(1);
    }
  };
  takeAssignments();
  while (PREFIX_KEYWORDS.has(argv[0])) argv = argv.slice(1);
  while (WRAPPERS.has(base(argv[0]))) {
    const wrapper = base(argv[0]);
    wrappers.add(wrapper);
    const isOption = (w) => w.startsWith("-") || isAssignment(w) || (WRAPPER_NUMBER.test(wrapper) && /^(\d[\w.,-]*|0x[\da-f]+)$/i.test(w));
    let i = 1;
    const takesValue = (w) => VALUE_FLAGS.has(w) || (WRAPPER_VALUE_FLAGS[wrapper]?.has(w) ?? false);
    for (; i < argv.length && isOption(argv[i]); i += takesValue(argv[i]) ? 2 : 1) {
      if (isAssignment(argv[i])) {
        const [name, value] = assignmentOf(argv[i]);
        env[name] = value;
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

const unresolvedPart = (part = "") => part.includes("$") || part.includes(SUB);

function changeDir(dir, target) {
  if (!target || target === "-" || target.startsWith("~")) return dir;
  const next = target.startsWith("/") ? [] : [...dir];
  for (const part of target.split("/")) {
    // A .. after an unresolved part could go anywhere, so the unresolved part stays and the directory stays unresolved.
    if (part === "..") {
      if (!unresolvedPart(next.at(-1))) next.pop();
    } else if (part && part !== ".") next.push(part);
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
 * names, and any -c value that names a protected path. state carries the
 * aliases and include files set earlier in the command, and env the
 * assignments in effect for the call (only the GIT_CONFIG ones are used).
 */
function gitCall(argv, dir, ctx, state = {}, env = {}) {
  let cwd = dir;
  let gitDir;
  let config = null;
  const aliases = { ...state.gitAliases };
  const includes = [...(state.gitIncludes ?? [])];
  const pushConfig = [];
  let pushConfigUnknown = false;
  const configEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!GIT_CONFIG_ENV.test(key)) continue;
    // As in the shell, a leading ~ is expanded; git reads a relative config path from the directory the command runs in.
    const path = value.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
    configEnv[key] = /^GIT_CONFIG_(GLOBAL|SYSTEM)$/.test(key) && path && !path.startsWith("/") ? pathOf(dir, path) : path;
  }
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
    // Settings that decide where a push with no refspec goes are passed on when the push destination is read.
    if ((flag === "-c" || flag === "--config-env") && PUSH_CONFIG_KEY.test(value.split("=")[0])) {
      if (flag === "-c" && !value.includes(SUB) && !value.includes("$")) pushConfig.push(value);
      else pushConfigUnknown = true;
    }
  }
  let rest = argv.slice(i);
  const call = { dir: cwd, gitDir, config, includes, configEnv, pushConfig, pushConfigUnknown };
  // An alias is expanded, a few levels deep: a ! alias is returned as shell text to check, any other becomes git
  // arguments. Aliases come from -c, from git config set earlier in the same command, or from the repository config
  // and the files it includes (also an include.path given with -c or set earlier in the command), with the GIT_CONFIG
  // environment of the call. An alias written with git config --file counts only when that file is read. Past the depth
  // limit, or when an include file or the GIT_CONFIG environment cannot be read, an alias is not known, so the call fails closed.
  for (let depth = 0; rest[0] !== undefined && !GIT_BUILTINS.has(rest[0]); depth++) {
    const name = rest[0].toLowerCase();
    let alias = Object.hasOwn(aliases, name) ? aliases[name] : undefined;
    if (alias === undefined && ctx) {
      try {
        alias = fileAlias(name, call, state.gitFileAliases ?? []) ?? configAlias(name, call, ctx);
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
  const configEnv = call.configEnv ?? {};
  if (Object.values(configEnv).some((v) => v.includes(SUB) || v.includes("$"))) throw new Error("the GIT_CONFIG environment cannot be resolved");
  const full = ["-C", where, ...(call.gitDir ? ["--git-dir", call.gitDir] : []), ...[...(call.includes ?? []), ...(call.pushConfig ?? [])].flatMap((c) => ["-c", c]), ...args];
  // Nothing runs while a call is checked, so one git read gives the same answer for every reading of the command.
  const key = JSON.stringify([git, full, configEnv]);
  if (gitCache.has(key)) return gitCache.get(key);
  const result = spawnSync(git, full, { encoding: "utf8", timeout: GH_TIMEOUT_MS, env: { ...process.env, ...configEnv, LC_ALL: "C" } });
  if (result.error) throw new Error(result.error.code === "ETIMEDOUT" ? "git timed out" : `git failed: ${result.error.message}`);
  gitCache.set(key, result);
  return result;
}
// git results for the call being checked; decide clears it.
const gitCache = new Map();

/**
 * The value of alias.<name> in the git config seen from the call's directory, include files followed, or undefined.
 * Throws when it cannot be read: git fails (a shim that is not git exits 1 with an error), or an include file
 * given in the command does not exist yet (git skips a missing include, and the command may write it first).
 */
function configAlias(name, call, ctx) {
  const key = `${call.dir.join("/")}#${call.gitDir ?? ""}#${(call.includes ?? []).join("\n")}#${JSON.stringify(call.configEnv ?? {})}#${name}`;
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

/**
 * The alias set earlier in the command with git config --file <path>, when git reads that file for the call: the
 * global or system file (GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM included), an include file, or the repository config.
 * A file git does not read gives undefined, so it cannot hide or invent an alias.
 */
function fileAlias(name, call, recorded) {
  const candidates = recorded.filter((r) => r.name === name);
  if (candidates.length === 0) return undefined;
  const env = { ...process.env, ...call.configEnv };
  const home = process.env.HOME ?? "";
  const loaded = new Set([
    ...(env.GIT_CONFIG_GLOBAL !== undefined ? [env.GIT_CONFIG_GLOBAL] : [`${home}/.gitconfig`, `${env.XDG_CONFIG_HOME || `${home}/.config`}/git/config`]),
    env.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig",
    ...(call.includes ?? []).map((c) => c.slice(c.indexOf("=") + 1).replace(/^~(?=\/)/, home)),
  ]);
  const common = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], call);
  if (common.status === 0 && common.stdout.trim()) loaded.add(`${common.stdout.trim()}/config`);
  return candidates.findLast((r) => loaded.has(r.file))?.value;
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

// Script names by directory for the current call, so a name the hook may run is never read as a plain word.
const scriptCache = new Map();

/**
 * Every package.json script name of the nearest package above dir, of its workspaces, and of every package.json tracked in
 * the git repository that holds dir, so a cd or --prefix in the command cannot reach a script the set leaves out.
 */
function scriptNames(dir) {
  const key = dir.join("/");
  if (!scriptCache.has(key)) {
    const names = new Set(Object.keys(nearestPackage(dir)?.scripts ?? {}));
    for (const d of workspaceDirs(dir)) for (const name of Object.keys(readPackage(d)?.scripts ?? {})) names.add(name);
    for (const d of trackedPackageDirs(dir)) for (const name of Object.keys(readPackage(d)?.scripts ?? {})) names.add(name);
    scriptCache.set(key, names);
  }
  return scriptCache.get(key);
}

/** Directories of the package.json files tracked in the git repository that holds dir; none when git cannot list them. */
function trackedPackageDirs(dir) {
  try {
    const top = runGit(["rev-parse", "--show-toplevel"], { dir });
    const root = top.stdout.trim();
    if (top.status !== 0 || !root.startsWith("/")) return [];
    const listed = runGit(["ls-files", "-z", "--", "*package.json"], { dir: root.split("/").filter(Boolean) });
    if (listed.status !== 0) return [];
    return listed.stdout.split("\0").filter((f) => base(f) === "package.json").map((f) => changeDir(root.split("/").filter(Boolean), dirname(f)));
  } catch {
    return [];
  }
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

/**
 * Block reason for a contents API write by the branch it commits to: main or master, a branch the body does not name
 * or leaves empty (the default branch), or one that cannot be read. JSON fields are matched as text, so an escaped
 * spelling such as m\u0061in is not decoded (a documented residual). An explicit other branch passes.
 */
function contentsBranchReason(body) {
  if (body === null) return "a contents API write whose body cannot be read; failing closed";
  const branches = [...body.matchAll(/(?:^|\n)branch=([^\n]*)|"branch"\s*:\s*"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
  // An empty branch field is the default branch too.
  if (branches.length === 0 || branches.includes("")) return "a contents API write that names no branch commits to the default branch; agents never push to main";
  if (branches.some((b) => b.includes("$") || b.includes(SUB))) return "a contents API write to a branch that cannot be read; failing closed";
  if (branches.some((b) => /^(refs\/)?(heads\/)?(main|master)$/.test(b))) return "a contents API write to the main branch; agents never push to main";
  return null;
}

/** Block reason for a REST call that merges branches, writes the main ref, or commits to main through the contents API. Agents never push to main. */
function branchWriteReason(route, method, body) {
  if (method === "GET" || method === "HEAD") return null;
  const path = route.replace(/^\w+:\/\/[^/]+/, "").replace(/^\/+/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (/^repos\/[^/]+\/[^/]+\/merges$/.test(path)) return "the merges API merges one branch into another; agents never merge";
  if (/^repos\/[^/]+\/[^/]+\/contents\/./.test(path) && (method === "PUT" || method === "DELETE")) return contentsBranchReason(body);
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

// PR file lookups for the current call, by target and directory, so a PR named in many readings is looked up once.
const prCache = new Map();

function mergeReason(target, ctx) {
  if (target.graphql) return `${target.graphql}, so its changed files cannot be checked; failing closed (use gh pr merge)`;
  const key = JSON.stringify([target, ctx.cwd]);
  if (!prCache.has(key)) {
    try {
      prCache.set(key, { result: ctx.prFiles(target, ctx.cwd) });
    } catch (error) {
      prCache.set(key, { error });
    }
  }
  const { result, error } = prCache.get(key);
  if (error) return `could not list the PR's changed files to check for supabase/migrations/ (${error.message}); failing closed`;
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

/**
 * The first line of a patch that writes a protected path, or null. Paths in diff --git, --- and +++ headers lose strip
 * leading parts as git apply -p does before they are checked; rename and copy lines are checked as written. Hunk content
 * is text, not a path. Any other line that names a protected path (a binary or quoted header) fails closed.
 */
function patchTarget(text, strip, isProtected) {
  const cut = (path) => path.split("/").slice(strip).join("/");
  for (const line of text.split("\n")) {
    if (/^[ +\-\\]/.test(line) && !/^(---|\+\+\+) /.test(line)) continue;
    let m;
    let paths = null;
    if ((m = /^diff --git (\S+) (\S+)$/.exec(line)) && !line.includes('"')) paths = [cut(m[1]), cut(m[2])];
    else if ((m = /^(?:---|\+\+\+) ([^\s"]+)(\t.*)?$/.exec(line))) paths = m[1] === "/dev/null" ? [] : [cut(m[1])];
    else if ((m = /^(?:rename|copy) (?:from|to) ([^"]+)$/.exec(line))) paths = [m[1]];
    if (paths === null ? PROTECTED_TEXT.test(line) : paths.some((path) => isProtected(path))) return line;
  }
  return null;
}

/**
 * Block reason for a patch. With a directory (git apply or git am --directory) every path the patch names lands under
 * it, so the joined paths are checked too.
 */
function patchReason(files, dir, what, { directory, strip = 1 } = {}) {
  if (directory !== undefined && protectedName(directory, dir)) return `${what} --directory=${directory} places files in a protected path`;
  if (files.length === 0) return `${what} reads a patch from stdin, which cannot be checked; failing closed`;
  for (const file of files) {
    const text = readNamed(file, dir);
    if (text === null) return `${what} patch ${file} cannot be read to check it; failing closed`;
    const target = patchTarget(text, strip, (path) => protectedName(directory === undefined ? path : `${directory}/${path}`, dir));
    if (target) return `${what} patch ${file} ${directory === undefined ? "changes a protected path" : `lands in a protected path under --directory=${directory}`}: ${target}`;
  }
  return null;
}

/** The patch files, --directory value and -p strip count of a git apply or git am command. */
function patchArgs(args) {
  const files = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const long = /^--(directory|include|exclude|whitespace)(?:=(.*))?$/.exec(w);
    if (long) {
      const value = long[2] ?? args[++i] ?? "";
      if (long[1] === "directory") opts.directory = value.replace(/\/+$/, "");
    } else if (/^-p\d*$/.test(w)) opts.strip = Number(w.slice(2) || args[++i]);
    else if (!w.startsWith("-")) files.push(w);
  }
  if (!Number.isInteger(opts.strip)) delete opts.strip;
  return { files, opts };
}

/**
 * Whether a git checkout, switch or branch -m changes the branch: undefined when it does not (a path restore, a patch),
 * else { name, created }. name is the branch left checked out, or null when it cannot be read from the command (a
 * generated or variable name, -, --detach); created is true for -b, -B, -c, -C and --orphan, which make a new branch.
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
  const named = (name) => (name.includes(SUB) || name.includes("$") || name === "-" || name.startsWith("@{") || name === "" ? null : name);
  const change = (name, isNew = false) => ({ name: named(name), created: isNew });
  if (sub === "branch") return move && positional.length > 0 ? change(positional.at(-1)) : undefined;
  if (detach) return change("-");
  if (created !== undefined) return change(created, true);
  if (positional.length !== 1) return undefined;
  const [target] = positional;
  // A lone checkout argument that is an existing path restores that path.
  if (!track && sub === "checkout" && dash < 0 && target !== "-" && !target.includes(SUB) && !target.includes("$") && existsSync(pathOf(dir, target))) return undefined;
  return change(target);
}

/** Records a git checkout, switch or branch -m in this command, in the order the hook reads them. */
function recordBranch(argv, dir, state, ctx, env) {
  if (base(argv[0]) !== "git") return;
  const git = gitCall(argv, dir, ctx, state, env);
  if (git.error || git.shell !== undefined) return;
  const change = branchChange(git.argv.slice(1), git.dir);
  if (change !== undefined) ctx.branchChanges.push({ ...change, inv: state.inv, index: state.index, compound: state.compound > 0, negated: state.negated, dir: git.dir, gitDir: git.gitDir });
}

const NAME_THE_BRANCH = "name the destination branch explicitly, for example git push -u origin HEAD:<branch>";

/**
 * Whether the branch change before a push of the current branch is a new branch made right before it: git checkout -b,
 * -B or --orphan, or git switch -c or -C, with a literal name that is not main or master, in the same command text, the
 * same directory (no cd after the change, no differing -C), outside any subshell and any compound command (if, while,
 * until, for, select, case or a { } group), not negated with !, and joined to the push by && all the way, so a creation
 * that fails (the branch already exists) stops the push.
 */
function newBranchBeforePush(change, call, state) {
  if (!change.created || change.compound || change.negated || change.name === null || MAIN_REF.test(change.name) || change.inv !== state.inv) return false;
  if (state.lastCd > change.index) return false;
  if (change.gitDir !== call.gitDir || change.dir.join("/") !== call.dir.join("/")) return false;
  const chain = state.segments.slice(change.index, state.index + 1);
  if (chain.some((s) => s.depth !== 0)) return false;
  if (!chain.slice(1).every((s) => s.op === "&&")) return false;
  // The change itself must run whenever the push would: after ;, a newline, && or at the start, not after || or |.
  const own = chain[0].op;
  return own === null || own === ";" || own === "\n" || own === "&&";
}

/** git config of the call as [key, value] pairs (section and variable names lowercased by git). Throws when it cannot be read. */
function gitConfigList(call) {
  if (call.pushConfigUnknown) throw new Error("a push setting given with -c or --config-env cannot be resolved");
  const result = runGit(["config", "-z", "--list"], call);
  if (result.status !== 0) throw new Error(`git config --list exited ${String(result.status)}`);
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const nl = entry.indexOf("\n");
      // A key written with no value (a bare "mirror" line) is a true boolean to git.
      return nl < 0 ? [entry, "true"] : [entry.slice(0, nl), entry.slice(nl + 1)];
    });
}

const configValue = (config, key) => config.findLast(([k]) => k === key)?.[1];
const pushMode = (config) => (configValue(config, "push.default") ?? "simple").toLowerCase();
// git rev-parse @{push} errors that mean there is no upstream, so push.default simple or current push the branch to its own name.
const NO_PUSH_UPSTREAM = /no upstream configured for branch|no such branch|has no remote for pushing/;

/**
 * Where a push with no refspec sends the current branch. The remote is the one named, else the branch's push remote
 * (branch.<b>.pushRemote, remote.pushDefault, branch.<b>.remote, origin). When that remote has remote.<name>.push
 * values git pushes every one of them, so they are all returned as { refspecs }. Otherwise push.default decides:
 * { matching: true } for matching, { nothing: true } when git pushes nothing, else the branch name on the remote.
 * For the push remote it is read with git rev-parse @{push}, with no upstream the branch name, as simple and current
 * push; for another named remote, which @{push} does not describe, push.default is applied as git does. Throws when
 * it cannot be resolved.
 */
function pushDestination(branch, remoteArg, call) {
  const config = gitConfigList(call);
  if (remoteArg !== undefined && (remoteArg.includes(SUB) || remoteArg.includes("$"))) throw new Error("the remote cannot be resolved");
  const fetchRemote = configValue(config, `branch.${branch}.remote`) ?? "origin";
  const pushRemote = configValue(config, `branch.${branch}.pushremote`) ?? configValue(config, "remote.pushdefault") ?? fetchRemote;
  const remote = remoteArg ?? pushRemote;
  if (gitTrue(configValue(config, `remote.${remote}.mirror`) ?? "false")) return { mirror: remote };
  const refspecs = config.filter(([k]) => k === `remote.${remote}.push`).map(([, v]) => v);
  if (refspecs.length > 0) return { refspecs };
  const mode = pushMode(config);
  if (mode === "matching") return { matching: true };
  if (mode === "nothing") return { nothing: true };
  if (!["simple", "current", "upstream", "tracking"].includes(mode)) throw new Error(`push.default ${mode} is not known`);
  // As git does: current pushes to the branch name, and so does simple to a remote that is not the branch's upstream
  // remote (@{push} cannot resolve that one).
  if (mode === "current" || (mode === "simple" && remote !== fetchRemote)) return branch;
  if (remote !== pushRemote) {
    // simple pushes to the branch name or refuses when the upstream has another name; upstream pushes to
    // branch.<b>.merge when the remote is the branch's upstream remote, and refuses otherwise.
    if (mode === "simple") return branch;
    if (remote !== fetchRemote) return { nothing: true };
    const merges = config.filter(([k]) => k === `branch.${branch}.merge`);
    if (merges.length !== 1) throw new Error(`branch.${branch}.merge has ${String(merges.length)} values`);
    return merges[0][1];
  }
  const at = runGit(["rev-parse", "--symbolic-full-name", "@{push}"], call);
  let full = at.stdout.trim();
  if (at.status !== 0) {
    const error = at.stderr.trim();
    if (NO_PUSH_UPSTREAM.test(error)) return branch;
    if (!/ambiguous argument '@\{push\}'|unknown revision/.test(error)) throw new Error(`git rev-parse @{push} failed: ${error.split("\n")[0] || `exit ${String(at.status)}`}`);
    // The destination has no remote tracking ref yet (a branch never pushed); for-each-ref names it anyway.
    full = runGit(["for-each-ref", "--format=%(push)", `refs/heads/${branch}`], call).stdout.trim();
  }
  const remotes = [...new Set(config.map(([k]) => /^remote\.(.+)\.url$/.exec(k)?.[1]).filter(Boolean))].sort((a, b) => b.length - a.length);
  const tracking = remotes.find((r) => full.startsWith(`refs/remotes/${r}/`));
  const fetch = config.filter(([k]) => k === `remote.${tracking}.fetch`).map(([, v]) => v.replace(/^\+/, ""));
  if (!tracking || fetch.length !== 1 || fetch[0] !== `refs/heads/*:refs/remotes/${tracking}/*`) throw new Error(`the push destination ${full || "(none)"} cannot be mapped to a remote branch`);
  return full.slice(`refs/remotes/${tracking}/`.length);
}

/** Whether a configured push refspec updates main or master: : (matching), a destination that is main, or a wildcard matching it. */
function refspecIsMain(spec, branch) {
  const text = spec.replace(/^\+/, "");
  if (text.startsWith("^")) return false;
  if (text === ":") return true;
  const colon = text.indexOf(":");
  const src = colon < 0 ? text : text.slice(0, colon);
  let dst = colon < 0 || text.slice(colon + 1) === "" ? src : text.slice(colon + 1);
  if (dst === "HEAD" || dst === "@") dst = branch;
  return dst === "" || destinationIsMain(dst);
}

/** Whether a git boolean config value is true; a value git does not read as false counts as true (failing closed). */
const gitTrue = (value) => !/^(false|no|off|0*|)$/i.test(value.trim());

/**
 * Where git sends a refspec with no colon that names a local ref (builtin/push.c refspec_append_mapped): the
 * destination of a matching remote.<remote>.push value, else with push.default upstream or tracking the branch's one
 * branch.<name>.merge value, else the same name. Every matching remote.<remote>.push value counts (git takes the first),
 * and its source may be written short or full. Returns the destinations; throws when they cannot be known.
 */
function mappedDestinations(spec, remote, call, ctx) {
  if (remote === undefined || remote.includes(SUB) || remote.includes("$")) throw new Error("the remote cannot be resolved");
  const plain = spec.replace(/^\+/, "");
  // In a directory that does not exist git push cannot run, so the name is taken as written.
  if (!call.dir.some((part) => part.includes(SUB) || part.includes("$")) && !call.gitDir && !isDirectory(pathOf(call.dir, "."))) return [plain];
  const config = gitConfigList(call);
  const full = /^refs\//.test(plain) ? plain : `refs/heads/${plain.replace(/^heads\//, "")}`;
  const names = new Set([plain, full, full.replace(/^refs\//, ""), full.replace(/^refs\/heads\//, "")]);
  const dests = [];
  for (const [, value] of config.filter(([k]) => k === `remote.${remote}.push`)) {
    const text = value.replace(/^\+/, "");
    if (text.startsWith("^") || text === ":") continue;
    const colon = text.indexOf(":");
    const src = colon < 0 ? text : text.slice(0, colon);
    const dst = colon < 0 || text.slice(colon + 1) === "" ? src : text.slice(colon + 1);
    const star = src.indexOf("*");
    for (const name of names) {
      if (star < 0 ? name === src : name.length >= src.length - 1 && name.startsWith(src.slice(0, star)) && name.endsWith(src.slice(star + 1))) {
        dests.push(star < 0 ? dst : dst.replace("*", name.slice(star, name.length - (src.length - star - 1))));
      }
    }
  }
  if (dests.length > 0) return dests;
  const mode = pushMode(config);
  if ((mode === "upstream" || mode === "tracking") && full.startsWith("refs/heads/")) {
    const branch = full.slice(11);
    // A branch made earlier in the same command may get an upstream (git checkout -b x origin/main) that config does not show yet.
    if (ctx.branchChanges.some((c) => c.name === branch)) throw new Error(`push.default ${mode} with ${branch} made in the same command`);
    const merges = config.filter(([k]) => k === `branch.${branch}.merge`);
    if (merges.length === 1) return [merges[0][1]];
  }
  return [plain];
}

/** Block reason for a refspec with no colon that git maps to main through remote.<name>.push or push.default upstream. */
function mappedReason(spec, remote, call, ctx) {
  let dests;
  try {
    dests = mappedDestinations(spec, remote, call, ctx);
  } catch (error) {
    return `git push ${spec}, whose destination cannot be resolved (${error.message}); failing closed, ${NAME_THE_BRANCH}`;
  }
  const main = dests.find((d) => destinationIsMain(d));
  return main === undefined ? null : `git push ${spec} goes to ${main} on the remote (remote.<name>.push or push.default upstream), and agents never push to main; ${NAME_THE_BRANCH}`;
}

/**
 * Block reason for a push whose destination is the current branch. With no branch change earlier in the command the
 * branch is read with git symbolic-ref in the push's directory, and for a push with no refspec the destination is read
 * with git rev-parse @{push}; after a change, only a new branch made right before the push passes, a push with no
 * refspec only when push.default is simple or current and no remote.<name>.push is set, and anything else fails closed.
 */
function currentPushReason(call, ctx, state, push) {
  const last = ctx.branchChanges.at(-1);
  if (last !== undefined) {
    if (!newBranchBeforePush(last, call, state)) return `git push of the current branch after a branch change in the same command; failing closed, ${NAME_THE_BRANCH}`;
    if (push.mapped) return mappedReason(last.name, push.remote, call, ctx);
    if (!push.implicit) return null;
    let config;
    try {
      config = gitConfigList(call);
    } catch (error) {
      return `git push with no refspec after a new branch, and git config cannot be read (${error.message}); failing closed, ${NAME_THE_BRANCH}`;
    }
    const mode = pushMode(config);
    if (mode !== "simple" && mode !== "current") return `git push with no refspec after a new branch, with push.default ${mode} (it may push to the start point's branch); failing closed, ${NAME_THE_BRANCH}`;
    if (config.some(([k]) => /^remote\..+\.push$/.test(k))) return `git push with no refspec after a new branch, with a remote.<name>.push refspec set; failing closed, ${NAME_THE_BRANCH}`;
    if (config.some(([k, v]) => /^remote\..+\.mirror$/.test(k) && gitTrue(v))) return `git push with no refspec after a new branch, with a remote.<name>.mirror set (it pushes every ref, main included); failing closed, ${NAME_THE_BRANCH}`;
    return null;
  }
  let branch;
  try {
    branch = currentBranch(call);
  } catch (error) {
    return `git push of the current branch, which cannot be resolved (${error.message}); failing closed, ${NAME_THE_BRANCH}`;
  }
  if (MAIN_REF.test(branch)) return `git push from ${branch} would update ${branch}; agents never push to main`;
  if (push.mapped) return mappedReason(branch, push.remote, call, ctx);
  if (!push.implicit) return null;
  let dest;
  try {
    dest = pushDestination(branch, push.remote, call);
  } catch (error) {
    return `git push with no refspec, whose destination cannot be resolved (${error.message}); failing closed, ${NAME_THE_BRANCH}`;
  }
  if (dest.refspecs) {
    const main = dest.refspecs.find((spec) => refspecIsMain(spec, branch));
    return main === undefined ? null : `git push with no refspec pushes every remote.<name>.push refspec, and ${main} updates main; agents never push to main; ${NAME_THE_BRANCH}`;
  }
  if (dest.mirror) return `git push with no refspec to ${dest.mirror}, whose remote.${dest.mirror}.mirror is set, pushes every ref, main included; agents never push to main; ${NAME_THE_BRANCH}`;
  if (dest.nothing) return null;
  if (dest.matching) return `git push with no refspec and push.default matching also pushes main; failing closed, ${NAME_THE_BRANCH}`;
  return MAIN_REF.test(dest) ? `git push from ${branch} goes to ${dest} on the remote (push.default or remote.<name>.push), and agents never push to main; ${NAME_THE_BRANCH}` : null;
}

/** Whether a literal push destination is main or master, or a wildcard that matches refs/heads/main or refs/heads/master. */
function destinationIsMain(dest) {
  if (!/[*?[]/.test(dest)) return MAIN_REF.test(dest);
  return ["main", "master"].some((name) => [name, `heads/${name}`, `refs/heads/${name}`].some((ref) => globEq(dest, ref)));
}

/** Block reason for a git push that would update main. */
function pushReason(args, call, ctx, state) {
  const positional = [];
  let tags = false;
  let every = null;
  let dryRun = false;
  let repo;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "--repo") repo = args[++i];
    else if (w.startsWith("--repo=")) repo = w.slice(7);
    else if (/^(-o|--push-option|--receive-pack|--exec)$/.test(w)) i++;
    // As in git, the last of --dry-run (or -n) and --no-dry-run wins.
    else if (w === "--dry-run" || w === "-n" || w === "--no-dry-run") dryRun = w !== "--no-dry-run";
    else if (/^--(all|mirror|branches)$/.test(w)) every = w;
    else if (w === "--tags") tags = true;
    else if (!w.startsWith("-")) positional.push(w);
  }
  if (dryRun) return null; // a dry run writes nothing
  if (every) return `git push ${every} would push main; agents never push to main`;
  // As in git, the first positional argument is the repository (it overrides --repo) and the rest are refspecs.
  const specs = positional.slice(1);
  // With no refspec, a push updates the current branch; --tags alone pushes only tags.
  let current = specs.length === 0 && !tags;
  let mapped = false;
  for (let k = 0; k < specs.length; k++) {
    const spec = specs[k];
    // tag <name> pushes refs/tags/<name>.
    if (spec === "tag") {
      k++;
      continue;
    }
    const plain = spec.replace(/^\+/, "");
    if (plain === ":") return `git push ${spec} pushes every matching branch, main included; agents never push to main`;
    // The colon inside a ${VAR:-x} expansion is not the refspec colon.
    const colon = plain.replace(/\$\{[^}]*\}/g, (m) => "_".repeat(m.length)).lastIndexOf(":");
    // An empty destination (HEAD:, main:) names the same ref as the source.
    const dest = (colon < 0 ? plain : plain.slice(colon + 1)) || plain.slice(0, colon);
    if (dest.includes(SOURCED_AT)) return `git push ${spec} has a destination from a variable that a sourced file may set; failing closed`;
    if (dest.includes(SUB) || dest.includes("$")) {
      // A default or alternate value written in the destination (HEAD:${TARGET:-main}) is judged as written. Otherwise a
      // destination built by substitution or a variable is read as the current branch, unless it cannot spell main
      // whatever the values are (HEAD:fix/$(date +%s)), which is judged like a wildcard.
      const filled = dest.replace(/\$\{[A-Za-z_]\w*:?[-=+?]([^}]*)\}/g, "$1").replace(/\$(\{[^}]*\}|[A-Za-z_]\w*|\d|[@*#?$!-])/g, "").replaceAll(SUB, "");
      if (destinationIsMain(filled)) return `git push ${spec} can expand to main; agents never push to main`;
      const pattern = dest.replace(/\$(\{[^}]*\}|[A-Za-z_]\w*|\d|[@*#?$!-])/g, "*").replaceAll(SUB, "*");
      if (destinationIsMain(pattern)) {
        current = true;
        // git maps a refspec with no colon that names the current branch through remote.<name>.push or push.default upstream.
        if (colon < 0) mapped = true;
      }
    } else if (/^(HEAD|@)$/.test(dest)) current = true;
    else if (destinationIsMain(dest)) return `git push ${spec} would update main; agents never push to main`;
    else if (colon < 0) {
      // A local branch named with no colon goes where git maps it, which can be main (push.default upstream).
      const reason = mappedReason(plain, positional[0], call, ctx);
      if (reason) return reason;
    }
  }
  return current ? currentPushReason(call, ctx, state, { implicit: specs.length === 0 && !tags, remote: positional[0] ?? repo, mapped }) : null;
}

function gitReason(argv, segment, call, ctx, state) {
  const dir = call.dir;
  const sub = argv[1];
  const args = argv.slice(2);
  if (sub === "commit") return commitArgs(argv).some((w) => protectedName(w, dir, true)) ? "git commit reads or writes a protected file" : null;
  if (sub === "push") return pushReason(args, call, ctx, state);
  const output = args.find((w) => w.startsWith("--output"));
  if (output) return protectedName(output.replace(/^--output=?/, "") || args[args.indexOf(output) + 1] || "", dir, true) ? "git writes output to a protected path" : null;
  // reflog expire and reflog delete change the reflog; its other forms read it.
  if (GIT_READERS.has(sub) && !(sub === "reflog" && /^(expire|delete|drop)$/.test(args[0] ?? ""))) return null;
  if (sub === "apply" || sub === "am") {
    if (args.some((w) => /^--(abort|skip|quit|continue|show-current-patch)$/.test(w))) return null;
    if (sub === "apply" && args.some((w) => /^--(check|stat|numstat|summary)$/.test(w)) && !args.includes("--apply")) return null;
    const { files, opts } = patchArgs(args);
    return patchReason([...files, ...segment.ins], dir, `git ${sub}`, opts);
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
  if (target?.includes(SOURCED_AT)) return "to a path from a variable that a sourced file may set; failing closed";
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
    const git = gitCall(argv, dir, ctx, state, { ...state.env, ...unwrap(segment.words).env });
    if (git.error) return git.error;
    if (git.config) return `git -c ${git.config} names a protected path`;
    // Plain arguments were checked with the alias text (checkSegment); a generated one that names a protected path cannot be.
    if (git.shell !== undefined) return git.shellArgs.some((w) => w.includes(SUB) && protectedName(w, git.dir, true)) ? "git shell alias gets a generated protected path as an argument" : null;
    return gitReason(git.argv, segment, git, ctx, state);
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
  if (writesArgs && args.some((w) => w.includes(SOURCED_AT))) return `${cmd} would write to a path from a variable that a sourced file may set; failing closed`;
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
  const shellAlias = cmd === "git" ? gitCall(argv, dir, ctx, state, { ...state.env, ...env }) : null;
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
  if (cmd === "eval") {
    inline = [argv.slice(1).join(" ")];
    // A command word that is still a reference or a placeholder is not known, so what eval runs cannot be checked.
    if (parse(inline[0]).segments.some((s) => (unwrap(s.words).argv[0] ?? "").includes("$"))) return "eval runs a command from a variable that is not known; failing closed";
  }
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

/**
 * Records an alias or include file that git config sets in this command, so a later git <alias> in it is expanded. An
 * alias written with --file is kept with its file and used only where git reads that file (fileAlias).
 */
function recordGitAlias(argv, dir, state) {
  if (base(argv[0]) !== "git") return;
  const git = gitCall(argv, dir, null, state);
  const args = git.argv.slice(2);
  if (git.argv[1] !== "config" || args.some((w) => /^--(get|get-all|get-regexp|unset|unset-all|list|blob)(=|$)|^-l$/.test(w))) return;
  const fileAt = args.findIndex((w) => /^(-f|--file)(=|$)/.test(w));
  const file = fileAt < 0 ? undefined : /^--file=/.test(args[fileAt]) ? args[fileAt].slice(7) : args[fileAt + 1];
  const at = args.findIndex((w, i) => /^alias\.[^=]+$/i.test(w) && (fileAt < 0 || i !== fileAt + 1));
  if (at >= 0 && args[at + 1] !== undefined) {
    const name = args[at].slice(6).toLowerCase();
    if (file === undefined) state.gitAliases[name] = args[at + 1];
    else if (!file.includes(SUB) && !file.includes("$")) state.gitFileAliases.push({ file: pathOf(git.dir, file.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")), name, value: args[at + 1] });
  }
  const include = args.findIndex((w) => GIT_INCLUDE_KEY.test(w));
  if (include >= 0 && args[include + 1] !== undefined) state.gitIncludes.push(`${args[include]}=${args[include + 1]}`);
}

/**
 * The directory a cd leads to. $PWD and ${PWD} are the current directory; ~, $HOME, ${HOME} and a bare cd are expanded from HOME; cd - goes back to the directory before the last
 * cd in this command. A directory that cannot be known gets an unresolved part, so git calls there fail closed.
 */
function cdTarget(dir, target, oldDir) {
  if (target === "-") return oldDir ?? [...dir, "$OLDPWD"];
  // $PWD is the directory the cd runs in.
  const pwdVar = /^\$(\{PWD\}|PWD)(?=\/|$)/.exec(target ?? "");
  if (pwdVar) return changeDir(dir, `.${target.slice(pwdVar[0].length)}`);
  const home = process.env.HOME;
  const homeVar = /^\$(\{HOME\}|HOME)(?=\/|$)/.exec(target ?? "");
  if (homeVar) target = `~${target.slice(homeVar[0].length)}`;
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
  const texts = expandVariants(src, () => scriptNames(dir));
  if (texts === null) return report("the command has too many possible variable values to check; failing closed");
  for (const text of texts) {
    // Readings multiply across nested -c, eval and $( ) text; past the budget the command fails closed, also in collect mode.
    if (++ctx.work > MAX_WORK) {
      const reason = "the command has too many readings to check in time; failing closed";
      ctx.collect?.push(reason);
      return reason;
    }
    const reason = checkExpanded(text, dir, ctx, depth, report);
    if (reason) return reason;
  }
  return null;
}

/** checkCommand for one expansion of the command text. */
function checkExpanded(text, dir, ctx, depth, report) {
  const { segments, substs } = parse(text);
  for (const inner of substs) {
    const reason = report(checkCommand(inner, dir, ctx, depth + 1));
    if (reason) return reason;
  }
  const state = { decoded: false, env: {}, prevArgs: [], inTest: false, gitAliases: {}, gitIncludes: [], gitFileAliases: [], oldDir: undefined };
  // Each command text checked gets its own number, so a branch change and a push are known to be in the same text.
  // lastCd is the index of the last segment that changed directory, compound the depth of if, while, for, case and { }.
  Object.assign(state, { inv: ctx.invocations++, segments, index: 0, lastCd: -1, compound: 0 });
  // A subshell gets a copy of the directory; a cd inside it does not change the directory after it.
  const outer = [];
  state.dirStack = [];
  for (const [index, segment] of segments.entries()) {
    while (outer.length < segment.depth) outer.push({ dir, oldDir: state.oldDir, lastCd: state.lastCd, dirStack: [...state.dirStack] });
    while (outer.length > segment.depth) ({ dir, oldDir: state.oldDir, lastCd: state.lastCd, dirStack: state.dirStack } = outer.pop());
    state.index = index;
    // A pipeline negated with ! succeeds when its command fails, so a creation there never stops a push after it.
    state.negated = false;
    for (const w of segment.words) {
      if (COMPOUND_OPEN.has(w)) state.compound++;
      else if (COMPOUND_CLOSE.has(w)) state.compound = Math.max(0, state.compound - 1);
      else if (w === "!") state.negated = true;
      else if (!COMPOUND_INNER.has(w)) break;
    }
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
    if (cmd === "cd" || cmd === "pushd" || cmd === "popd") {
      // popd returns to a directory on the stack, a pushd with no directory or a +N or -N rotates the stack, and a cd in
      // a pipeline runs in its own subshell; none is followed, so the directory after them is unresolved. popd's
      // unresolved part goes on the directory before the last pushd in this command, where popd most likely returns.
      const piped = /^\|&?$/.test(segment.op ?? "") || /^\|&?$/.test(segments[index + 1]?.op ?? "");
      const target = argv.slice(1).find((w) => w === "-" || !w.startsWith("-"));
      let next;
      if (piped) next = [...dir, "$DIRSTACK"];
      else if (cmd === "popd") next = [...(state.dirStack.pop() ?? dir), "$DIRSTACK"];
      else if (cmd === "pushd" && (target === undefined || /^[+-]\d+$/.test(target))) next = [...dir, "$DIRSTACK"];
      else next = cdTarget(dir, target, state.oldDir);
      if (cmd === "pushd" && !piped) state.dirStack.push(dir);
      [dir, state.oldDir] = [next, dir];
      state.lastCd = index;
      continue;
    }
    const reason = report(checkSegment(segment, state, dir, ctx, depth, substs));
    if (reason) return reason;
    recordGitAlias(argv, dir, state);
    recordBranch(argv, dir, state, ctx, { ...state.env, ...env });
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
  const ctx = { prFiles: options.prFiles ?? ghPrFiles, cwd: cwdPath, visited: new Set(), gitAliases: new Map(), branchChanges: [], invocations: 0, work: 0, collect: options.collect ? [] : null };
  const cwd = changeDir([], cwdPath);
  gitCache.clear();
  prCache.clear();
  scriptCache.clear();
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
  process.stderr.write(blockMessage(reason));
  return 2;
}

/**
 * The text shown when a call is blocked. A push whose destination is the current branch has an intended fix, naming a
 * destination that is not main, so its message says so; every other block says to stop and report.
 */
export function blockMessage(reason) {
  if (reason.includes(NAME_THE_BRANCH)) {
    return (
      `guard-migrations blocked this call: ${reason}.\n` +
      "This push of the current branch goes to main, or the hook could not confirm that it goes anywhere else. The intended fix is to name a destination branch that is not main, for example git push -u origin HEAD:<branch>; doing that is not routing around the guard. Stop and report only if the destination you need really is main.\n"
    );
  }
  return (
    `guard-migrations blocked this call: ${reason}.\n` +
    "This hook is best effort. The real gates are the deny rules in .claude/settings.json, workers never merging, and Blaine's explicit yes for anything under supabase/migrations/. Stop and report; do not route around it.\n"
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
