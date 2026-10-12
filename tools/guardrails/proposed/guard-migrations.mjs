#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for Bash, file edit and MCP calls. Best effort only.
 *
 * The real gates are elsewhere: the permission deny rules in
 * .claude/settings.json (Edit on supabase/migrations/** and the hosted
 * Supabase write tools), the rule that workers never merge, and Blaine's
 * explicit yes for anything under supabase/migrations/. A determined agent
 * can get past this hook.
 *
 * It blocks:
 * - Edit, Write, MultiEdit and NotebookEdit on any path containing
 *   supabase/migrations/, including worktree paths the deny rule misses;
 * - obvious Bash writes into supabase/migrations/ (redirects, tee, cp, mv,
 *   sed -i, git checkout/restore of those paths, and so on), any pipe into a
 *   shell, and decoded or generated text run by an interpreter;
 * - supabase CLI commands that create migration files or change a hosted
 *   project, also when reached through npm, yarn or pnpm run <script>;
 * - hosted Supabase write tools under any MCP server name, and execute_sql
 *   unless it is a single read only statement;
 * - merges and auto merges of a PR whose changed files include anything
 *   under supabase/migrations/, failing closed when the files cannot be
 *   listed.
 * Reads pass. Commit messages and gh --body/--title text are never scanned.
 * Residuals are listed in guard-migrations.node-test.mjs.
 *
 * Exit 2 with a reason on stderr blocks the call. Missing tool_input
 * fails closed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUB = "\u0001";
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "tcsh", "csh", "fish", "busybox", "eval", "source", "."]);
const INTERPRETERS = new Set([...SHELLS, "perl", "python", "python3", "node", "ruby", "php", "deno", "bun"]);
const READERS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "less", "more", "stat", "file", "diff", "find", "sort", "uniq", "nl", "md5sum", "sha256sum"]);
// Commands for which a bare "supabase" (or a glob that could expand to it) means the directory.
const FILE_WRITERS = new Set(["cp", "mv", "rm", "rmdir", "rsync", "ln", "install", "tar", "unzip", "touch", "mkdir", "chmod", "chown", "truncate", "dd", "tee", "shred", "git"]);
const GIT_READERS = new Set(["log", "show", "status", "blame", "diff", "grep", "ls-files", "add"]);
const WRAPPERS = new Set(["env", "sudo", "command", "exec", "nohup", "time", "nice", "timeout", "xargs", "stdbuf"]);
const VALUE_FLAGS = new Set(["-I", "-n", "-P", "-L", "-d", "-s", "-u", "-g"]);
const GH_TEXT_FLAGS = new Set(["--body", "-b", "--title", "-t", "--notes", "--message", "-m"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Hosted Supabase write tools. The first set has no namesake on the GitHub or Vercel servers.
const SUPABASE_ONLY_TOOLS = new Set(["apply_migration", "merge_branch", "reset_branch", "rebase_branch", "deploy_edge_function", "create_edge_function_secret", "restore_project"]);
const SHARED_NAME_TOOLS = new Set(["create_branch", "delete_branch", "pause_project", "create_project"]);
const KNOWN_SUPABASE_SERVERS = new Set(["fb51b900-5d04-4884-9f50-844879db0029"]);
const SQL_FIRST_WORDS = new Set(["select", "with", "show", "explain", "table"]);
const SQL_WRITE_WORDS =
  /\b(insert|update|delete|merge|alter|create|drop|grant|revoke|truncate|copy|call|do|set|refresh|vacuum|lock|into|analy[sz]e|execute)\b|\bcomment\s+on\b|\bsecurity\s+label\b/i;
const SQL_SIDE_EFFECTS =
  /\b(nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_promote|pg_notify|pg_advisory\w*|pg_create_\w+|pg_drop_\w+|pg_replication_\w+|lo_\w+|dblink\w*)\s*\(/i;
const MIGRATION_FILE = /(^|[\\/])supabase[\\/]+migrations([\\/]|$)/i;
const GH_TIMEOUT_MS = 8000;

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

/** Shell lexer: returns segments ({ words, outs, heredocs, op }) and the bodies of $( ), backticks and <( ). */
function parse(src) {
  const segments = [{ words: [], outs: [], heredocs: [], op: null }];
  const substs = [];
  const pendingDocs = [];
  let word = null;
  let redirect = null;
  const seg = () => segments.at(-1);
  const add = (text) => (word = (word ?? "") + text);
  const flush = () => {
    if (word === null) return;
    if (redirect === ">") seg().outs.push(word);
    else if (redirect === null) seg().words.push(word);
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
      redirect = m[0].includes(">") && m[0] !== ">&" ? ">" : "<";
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
      segments.push({ words: [], outs: [], heredocs: [], op: "\n" });
    } else if (/[;&|()\n]/.test(c)) {
      flush();
      const op = /^(&&|\|\||\|&|[;&|()\n])/.exec(src.slice(i))[0];
      segments.push({ words: [], outs: [], heredocs: [], op });
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
  return { segments: segments.filter((s) => s.words.length > 0 || s.outs.length > 0), substs };
}

function expandVars(src) {
  const vars = {};
  for (const m of src.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g)) {
    vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return src.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, name) => (name in vars ? vars[name] : all));
}

const base = (word = "") => word.split("/").pop();

function unwrap(words) {
  let argv = words.slice(Math.max(0, words.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w))));
  while (WRAPPERS.has(base(argv[0]))) {
    const isOption = (w) => w.startsWith("-") || /^[A-Za-z_]\w*=/.test(w) || (base(argv[0]) === "timeout" && /^\d/.test(w));
    let i = 1;
    while (i < argv.length && isOption(argv[i])) i += VALUE_FLAGS.has(argv[i]) ? 2 : 1;
    argv = argv.slice(i);
  }
  return argv;
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
      re += `[${pattern.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
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

const inMigrations = (segs) => segs.some((s, i) => globEq(s, "supabase") && segs[i + 1] !== undefined && globEq(segs[i + 1], "migrations"));

function changeDir(dir, target) {
  if (!target || target === "-" || target.startsWith("~")) return dir;
  const next = target.startsWith("/") ? [] : [...dir];
  for (const part of target.split("/")) {
    if (part === "..") next.pop();
    else if (part && part !== ".") next.push(part);
  }
  return next;
}

/**
 * True when the word names supabase/migrations from dir. With wholeDir it
 * also counts a word naming the supabase directory itself, which matters
 * only for commands that write files.
 */
function touches(word, dir, wholeDir = false) {
  if (word.includes(SUB)) return false;
  if (/supabase[\\/]+migrations/i.test(word)) return true;
  const segs = changeDir(dir, word);
  return inMigrations(segs) || (wholeDir && word.split("/").some(Boolean) && globEq(segs.at(-1) ?? "", "supabase"));
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
    else if (!/^--message=/.test(w) && !/^-[a-zA-Z]*m./.test(w)) out.push(w);
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

/** Arguments after the supabase CLI name, or null when the command is not the supabase CLI. */
function supabaseCli(argv) {
  const cmd = base(argv[0]);
  if (cmd === "supabase") return argv.slice(1);
  if (!/^(npx|bunx|pnpx|npm|yarn|pnpm|bun)$/.test(cmd)) return null;
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i];
    if (w.startsWith("-") || ["run", "run-script", "exec", "dlx", "x"].includes(w)) continue;
    return /^supabase(@.*)?$/.test(base(w)) ? argv.slice(i + 1).filter((a) => a !== "--") : null;
  }
  return null;
}

/** Block reason for supabase CLI calls that write migration files or change a hosted project. */
function supabaseReason(args) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (/^(--workdir|--profile|--output|-o|--dns-resolver|--network-id)$/.test(args[i])) i++;
    else if (!args[i].startsWith("-")) positional.push(args[i]);
  }
  const [group, action] = positional;
  const hosted = args.some((w) => /^--(linked|db-url|project-ref)(=|$)/.test(w));
  const writesFiles = {
    migration: ["new", "squash", "fetch", "repair"],
    db: ["push", "pull"],
    functions: ["deploy", "delete"],
    secrets: ["set", "unset"],
    branches: ["create", "delete", "update", "disable"],
    projects: ["create", "delete"],
    config: ["push"],
  };
  if (writesFiles[group]?.includes(action)) return `supabase ${group} ${action} would create a migration or change a hosted project`;
  if (group === "db" && action === "diff" && args.some((w) => /^(-f|--file)/.test(w))) return "supabase db diff -f would write a migration file";
  if (hosted && (group === "db" || group === "migration")) return `supabase ${group} ${action ?? ""} targets a hosted database`.replace(/ +$/, "");
  return null;
}

function nearestPackageJson(dir) {
  for (let segs = [...dir]; ; segs.pop()) {
    const file = `/${[...segs, "package.json"].join("/")}`;
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
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

/** The script name and extra arguments for npm, yarn or pnpm running a package.json script, or null. */
function scriptCall(argv) {
  const cmd = base(argv[0]);
  if (!/^(npm|yarn|pnpm)$/.test(cmd)) return null;
  let i = 1;
  const nextPositional = () => {
    while (i < argv.length && argv[i].startsWith("-")) i += /^(--prefix|-w|--workspace|-C|--dir|--filter|--cwd)$/.test(argv[i]) ? 2 : 1;
    return argv[i++];
  };
  const sub = nextPositional();
  if (sub === undefined) return null;
  let name;
  if (["run", "run-script", "rum", "urn"].includes(sub)) name = nextPositional();
  else if (cmd === "npm") name = NPM_SCRIPT_ALIASES[sub];
  else if (!YARN_PNPM_BUILTINS.has(sub)) name = sub;
  if (!name) return null;
  return { name, extra: argv.slice(i).filter((w) => w !== "--") };
}

function scriptBodies(call, dir) {
  const scripts = nearestPackageJson(dir)?.scripts ?? {};
  const main = scripts[call.name];
  if (typeof main !== "string") return [];
  const quoted = call.extra.map((w) => `'${w.replace(/'/g, "'\\''")}'`).join(" ");
  return [scripts[`pre${call.name}`], `${main} ${quoted}`.trim(), scripts[`post${call.name}`]].filter((s) => typeof s === "string");
}

/** A merge or auto merge request in a Bash command: { owner, repo, number } | { selector, repoFlag } | { graphql: true } | null. */
function mergeTarget(argv) {
  const cmd = base(argv[0]);
  const routeRe = /(?:^|\/)repos\/([^/\s]+)\/([^/\s]+)\/pulls\/(\d+)\/(?:ccr\/)?(merge|auto[_-]?merge)(?:[?#].*)?$/;
  if (cmd === "gh" && argv[1] === "pr" && argv[2] === "merge") {
    if (argv.includes("--disable-auto")) return null;
    let selector;
    let repoFlag;
    for (let i = 3; i < argv.length; i++) {
      const w = argv[i];
      if (w === "-R" || w === "--repo") repoFlag = argv[++i];
      else if (w.startsWith("--repo=")) repoFlag = w.slice(7);
      else if (/^(-b|--body|-F|--body-file|-t|--subject|-A|--author-email|--match-head-commit)$/.test(w)) i++;
      else if (!w.startsWith("-") && selector === undefined) selector = w;
    }
    return { selector, repoFlag };
  }
  if (cmd === "gh" && argv[1] === "api") {
    let route;
    let method;
    let hasFields = false;
    for (let i = 2; i < argv.length; i++) {
      const w = argv[i];
      if (w === "-X" || w === "--method") method = argv[++i];
      else if (/^-X./.test(w)) method = w.slice(2);
      else if (w.startsWith("--method=")) method = w.slice(9);
      else if (/^(-f|-F|--field|--raw-field|--input)$/.test(w)) {
        hasFields = true;
        i++;
      } else if (/^(-H|--header|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)$/.test(w)) i++;
      else if (!w.startsWith("-") && route === undefined) route = w;
    }
    if (route === "graphql" || route === "/graphql") {
      return argv.some((w) => /enablePullRequestAutoMerge|mergePullRequest/i.test(w)) ? { graphql: true } : null;
    }
    const m = routeRe.exec(route ?? "");
    const effective = (method ?? (hasFields ? "POST" : "GET")).toUpperCase();
    // DELETE on an auto merge route turns auto merge off.
    return m && effective !== "GET" && effective !== "DELETE" ? { owner: m[1], repo: m[2], number: m[3] } : null;
  }
  if (/^(curl|wget|http|https)$/.test(cmd)) {
    if (argv.some((w, i) => /^(-X|--request)$/.test(w) && /^(get|delete)$/i.test(argv[i + 1] ?? ""))) return null;
    for (const w of argv) {
      const m = routeRe.exec(w.replace(/^https?:\/\/[^/]+/, ""));
      if (m) return { owner: m[1], repo: m[2], number: m[3] };
    }
  }
  return null;
}

function runGh(args, cwd) {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS });
  if (result.error) throw new Error(result.error.code === "ETIMEDOUT" ? "gh timed out" : `gh failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh exited ${String(result.status)}: ${(result.stderr || "").trim().split("\n")[0]}`);
  return result.stdout;
}

/** Default lookup of a PR's changed files with the gh CLI. Throws when they cannot be listed. */
export function ghPrFiles(target, cwd) {
  let { owner, repo, number } = target;
  let host;
  const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(target.selector ?? "");
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
    const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(viewed);
    if (!m) throw new Error(`gh pr view returned no PR URL (${viewed || "empty"})`);
    [, host, owner, repo, number] = m;
  }
  const hostArgs = host && host !== "github.com" ? ["--hostname", host] : [];
  const out = runGh(["api", ...hostArgs, "--paginate", `repos/${owner}/${repo}/pulls/${number}/files`, "--jq", ".[].filename"], cwd);
  return out.split("\n").filter(Boolean);
}

function mergeReason(target, ctx) {
  if (target.graphql) return "a GraphQL merge mutation hides which PR it merges, so its changed files cannot be checked; use gh pr merge";
  let files;
  try {
    files = ctx.prFiles(target, ctx.cwd);
  } catch (error) {
    return `could not list the PR's changed files to check for supabase/migrations/ (${error.message}); failing closed`;
  }
  if (!Array.isArray(files)) return "PR file lookup returned no list; failing closed";
  return files.some((f) => MIGRATION_FILE.test(f)) ? "this PR changes files under supabase/migrations/, so merging it needs Blaine's explicit yes" : null;
}

function migrationWrite(argv, outs, dir) {
  if (outs.some((target) => touches(target, dir, true))) return "redirects output into supabase/migrations";
  const cmd = base(argv[0]);
  if (cmd === "git" && argv[1] === "commit") {
    return commitArgs(argv).some((w) => touches(w, dir, true)) ? "git commit reads or writes a file in supabase/migrations" : null;
  }
  if (cmd === "git" && GIT_READERS.has(argv[1]) && !argv.some((w) => w.startsWith("--output"))) return null;
  const args = cmd === "gh" ? ghArgs(argv) : argv.slice(1);
  if (!inMigrations(dir) && !args.some((w) => touches(w, dir, FILE_WRITERS.has(cmd)))) return null;
  if (READERS.has(cmd) && !readerWrites(cmd, args)) return null;
  return `${cmd} would write to supabase/migrations`;
}

function checkCommand(src, dir, ctx, depth = 0) {
  if (depth > 4) return "command nests too deeply to check";
  const { segments, substs } = parse(expandVars(src));
  for (const inner of substs) {
    const reason = checkCommand(inner, dir, ctx, depth + 1);
    if (reason) return reason;
  }
  let decoded = false;
  for (const segment of segments) {
    const argv = unwrap(segment.words);
    const cmd = base(argv[0]);
    const piped = segment.op === "|" || segment.op === "|&";
    if (!piped) decoded = false;
    if (piped && SHELLS.has(cmd)) return "pipes into a shell interpreter";
    if (piped && decoded && INTERPRETERS.has(cmd)) return "runs decoded text with an interpreter";
    if (/^(base64|base32|xxd|uudecode|openssl)$/.test(cmd) && argv.some((w) => /^-[a-zA-Z]*[dDr]$|^--decode/.test(w))) decoded = true;
    if (SHELLS.has(cmd) && argv.slice(1).some((w) => w.includes(SUB))) return "runs a shell on generated text";
    if (INTERPRETERS.has(cmd) && argv.some((w) => w.includes(SUB)) && argv.some((w) => /^(-[ceEpr]|--eval)$/.test(w))) {
      return "runs generated code with an interpreter";
    }
    for (const body of segment.heredocs) {
      if (SHELLS.has(cmd)) {
        const reason = checkCommand(body, dir, ctx, depth + 1);
        if (reason) return reason;
      } else if (INTERPRETERS.has(cmd) && /supabase\W+migrations/i.test(body)) {
        return "interpreter heredoc mentions supabase/migrations";
      }
    }
    if (cmd === "eval" || (SHELLS.has(cmd) && argv.includes("-c"))) {
      const reason = checkCommand(cmd === "eval" ? argv.slice(1).join(" ") : (argv[argv.indexOf("-c") + 1] ?? ""), dir, ctx, depth + 1);
      if (reason) return reason;
    }
    if (cmd === "cd" || cmd === "pushd") {
      dir = changeDir(dir, argv[1]);
      continue;
    }
    const cli = supabaseCli(argv);
    const cliReason = cli && supabaseReason(cli);
    if (cliReason) return cliReason;
    const call = scriptCall(argv);
    for (const body of call ? scriptBodies(call, dir) : []) {
      const reason = checkCommand(body, dir, ctx, depth + 1);
      if (reason) return `${call.name} script: ${reason}`;
    }
    const target = mergeTarget(argv);
    const merge = target && mergeReason(target, ctx);
    if (merge) return merge;
    const reason = migrationWrite(argv, segment.outs, dir);
    if (reason) return reason;
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
      const backslashes = quote === "'" && /[eE]$/.test(sql.slice(0, i)) && !/\w[eE]$/.test(sql.slice(0, i));
      for (i++; i < sql.length; i++) {
        if (backslashes && sql[i] === "\\") i++;
        else if (sql[i] === quote && sql[i + 1] === quote) i++;
        else if (sql[i] === quote) break;
      }
      if (i >= sql.length) return "execute_sql has an unterminated quote; failing closed";
      i++;
      text += quote === "'" ? " '' " : " q ";
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

function checkMcp(tool, input, ctx) {
  const parts = tool.split("__");
  const name = parts.at(-1);
  const server = parts.slice(1, -1).join("__");
  const supabaseServer = /supabase/i.test(server) || KNOWN_SUPABASE_SERVERS.has(server);
  if (SUPABASE_ONLY_TOOLS.has(name)) return `${name} is a hosted Supabase write`;
  if (SHARED_NAME_TOOLS.has(name) && (supabaseServer || "project_id" in input || "organization_id" in input)) return `${name} is a hosted Supabase write`;
  if (name === "execute_sql") return sqlReason(input.query ?? input.sql);
  if (name === "merge_pull_request" || name === "enable_pr_auto_merge") {
    const number = input.pullNumber ?? input.pull_number ?? input.number;
    if (!input.owner || !input.repo || number === undefined) return `${name} is missing owner, repo or pull number; failing closed`;
    return mergeReason({ owner: input.owner, repo: input.repo, number }, ctx);
  }
  if (/^(get|list|search|read|query|download)/.test(name)) return null;
  let reason = null;
  JSON.stringify(input, (key, value) => {
    if (/^(path|file_?path|filename)$/i.test(key) && typeof value === "string" && touches(value, [], true)) reason = "MCP write to supabase/migrations";
    return value;
  });
  return reason;
}

function checkEdit(input, cwd) {
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && (MIGRATION_FILE.test(value) || inMigrations(changeDir(cwd, value)))) {
      return "file edits under supabase/migrations/ need Blaine's explicit yes";
    }
  }
  return null;
}

/**
 * Returns a block reason, or null to allow. options.prFiles(target, cwd)
 * lists a PR's changed files and throws when it cannot; it defaults to gh.
 */
export function decide(payload, options = {}) {
  const input = payload?.tool_input;
  if (input == null || typeof input !== "object") return "tool_input is missing; failing closed";
  const tool = String(payload.tool_name ?? "");
  const cwdPath = resolve(payload.cwd || process.cwd());
  const ctx = { prFiles: options.prFiles ?? ghPrFiles, cwd: cwdPath };
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
