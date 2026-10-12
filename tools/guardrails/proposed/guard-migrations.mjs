#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for Bash and MCP calls. Best effort only.
 *
 * The real gates are elsewhere: the permission deny rules in
 * .claude/settings.json (Edit/Write/NotebookEdit on supabase/migrations/**
 * and the hosted Supabase write tools), the rule that agents never merge
 * or apply migration PRs, and Blaine's explicit yes for each migration
 * window. A determined agent can get past this hook.
 *
 * It blocks obvious Bash writes into supabase/migrations/ (redirects, tee,
 * cp, mv, sed -i, git checkout/restore of those paths, and so on), any pipe
 * into a shell, decoded or generated text run by an interpreter, supabase
 * CLI commands that create or apply migrations, and attempts to add the
 * blaine-window label. Reads pass. git commit message text is never
 * scanned. Residuals are listed in guard-migrations.node-test.mjs.
 *
 * Exit 2 with a reason on stderr blocks the call. Missing tool_input
 * fails closed.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUB = "\u0001";
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "tcsh", "csh", "fish", "busybox", "eval", "source", "."]);
const INTERPRETERS = new Set([...SHELLS, "perl", "python", "python3", "node", "ruby", "php", "deno", "bun"]);
const READERS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "less", "more", "stat", "file", "diff", "find", "sort", "uniq", "nl", "md5sum", "sha256sum"]);
const GIT_READERS = new Set(["log", "show", "status", "blame", "diff", "grep", "ls-files", "add"]);
const WRAPPERS = new Set(["env", "sudo", "command", "exec", "nohup", "time", "nice", "timeout", "xargs", "stdbuf"]);
const VALUE_FLAGS = new Set(["-I", "-n", "-P", "-L", "-d", "-s", "-u", "-g"]);

function matchClose(src, i, open, close) {
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return i;
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
  const seg = () => segments[segments.length - 1];
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
      const end = src.indexOf("'", i + 1) < 0 ? src.length : src.indexOf("'", i + 1);
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
        else if (src[i] === "`") i = subst(i, src.indexOf("`", i + 1) < 0 ? src.length : src.indexOf("`", i + 1), 1);
        else add(src[i++]);
      }
      i++;
    } else if (c === "$" && next === "(") {
      i = subst(i, matchClose(src, i + 1, "(", ")"), 2);
    } else if (c === "`") {
      i = subst(i, src.indexOf("`", i + 1) < 0 ? src.length : src.indexOf("`", i + 1), 1);
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
          const eol = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
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
    const wrapper = base(argv[0]);
    argv = argv.slice(1);
    while (argv.length > 0 && (argv[0].startsWith("-") || /^[A-Za-z_]\w*=/.test(argv[0]) || (wrapper === "timeout" && /^\d/.test(argv[0])))) {
      argv = argv.slice(VALUE_FLAGS.has(argv[0]) ? 2 : 1);
    }
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

/** True when the word names supabase/migrations (or the supabase dir itself) from dir. */
function touches(word, dir) {
  if (word.includes(SUB)) return false;
  if (/supabase[\\/]+migrations/i.test(word)) return true;
  const segs = changeDir(dir, word);
  return inMigrations(segs) || (word.split("/").some(Boolean) && globEq(segs[segs.length - 1] ?? "", "supabase"));
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

function supabaseApplies(argv) {
  const at = argv.findIndex((w) => base(w) === "supabase");
  if (at < 0 || base(argv[0]) === "git") return false;
  const [group, action] = argv.slice(at + 1).filter((w) => !w.startsWith("-"));
  if (group === "migration") return ["new", "up", "down", "repair", "squash", "fetch"].includes(action);
  if (group === "db") return ["push", "reset", "pull"].includes(action) || (action === "diff" && argv.some((w) => /^(-f|--file)/.test(w)));
  return false;
}

function addsWindowLabel(argv) {
  const bad = (w = "") => w.toLowerCase().includes("blaine-window") || w.includes(SUB);
  const flagged = argv.some((w, i) => (/^(--add-label|--label|-l)$/.test(w) && bad(argv[i + 1])) || (/^--(add-)?label=/.test(w) && bad(w)));
  return flagged || (argv.some((w) => /labels/i.test(w)) && argv.some(bad));
}

function migrationWrite(argv, outs, dir) {
  if (outs.some((target) => touches(target, dir))) return "redirects output into supabase/migrations";
  const cmd = base(argv[0]);
  if (cmd === "git" && argv[1] === "commit") {
    return commitArgs(argv).some((w) => touches(w, dir)) ? "git commit reads or writes a file in supabase/migrations" : null;
  }
  if (cmd === "git" && GIT_READERS.has(argv[1]) && !argv.some((w) => w.startsWith("--output"))) return null;
  const args = argv.slice(1);
  if (!inMigrations(dir) && !args.some((w) => touches(w, dir))) return null;
  if (READERS.has(cmd) && !readerWrites(cmd, args)) return null;
  return `${cmd} would write to supabase/migrations`;
}

function checkCommand(src, dir, depth = 0) {
  if (depth > 4) return "command nests too deeply to check";
  const { segments, substs } = parse(expandVars(src));
  for (const inner of substs) {
    const reason = checkCommand(inner, dir, depth + 1);
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
      const reason = SHELLS.has(cmd) ? checkCommand(body, dir, depth + 1) : INTERPRETERS.has(cmd) && /supabase\W+migrations/i.test(body) ? "interpreter heredoc mentions supabase/migrations" : null;
      if (reason) return reason;
    }
    if (cmd === "eval" || (SHELLS.has(cmd) && argv.includes("-c"))) {
      const reason = checkCommand(cmd === "eval" ? argv.slice(1).join(" ") : argv[argv.indexOf("-c") + 1] ?? "", dir, depth + 1);
      if (reason) return reason;
    }
    if (cmd === "cd" || cmd === "pushd") {
      dir = changeDir(dir, argv[1]);
      continue;
    }
    if (supabaseApplies(argv)) return "supabase CLI would create or apply a migration";
    if (/^(gh|hub|curl|wget|http)$/.test(cmd) && addsWindowLabel(argv)) return "would add the blaine-window label";
    const reason = migrationWrite(argv, segment.outs, dir);
    if (reason) return reason;
  }
  return null;
}

/** Label fields naming blaine-window, or path fields under supabase/migrations, in MCP arguments. */
function checkMcp(tool, input) {
  if (/__(get|list|search|read|query|download)/.test(tool)) return null;
  let reason = null;
  JSON.stringify(input, (key, value) => {
    if (/label/i.test(key) && JSON.stringify(value)?.toLowerCase().includes("blaine-window")) reason = "would add the blaine-window label";
    if (/^(path|file_?path|filename)$/i.test(key) && typeof value === "string" && touches(value, [])) reason = "MCP write to supabase/migrations";
    return value;
  });
  return reason;
}

/** Returns a block reason, or null to allow. */
export function decide(payload) {
  const input = payload?.tool_input;
  if (input == null || typeof input !== "object") return "tool_input is missing; failing closed";
  const tool = String(payload.tool_name ?? "");
  if (tool.startsWith("mcp__")) return checkMcp(tool, input);
  if (tool !== "Bash") return null;
  if (typeof input.command !== "string") return "tool_input.command is missing; failing closed";
  return checkCommand(input.command, changeDir([], resolve(payload.cwd || process.cwd())));
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
      "This hook is best effort. The real gates are the deny rules in .claude/settings.json, agents never merging or applying migration PRs, and Blaine's explicit yes per migration window. Stop and report; do not route around it.\n",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
