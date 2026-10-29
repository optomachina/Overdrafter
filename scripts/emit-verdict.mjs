#!/usr/bin/env node
/**
 * OVD-851: build, validate, and print an `overdrafter.verdict/v1` PR comment.
 *
 * Used by the independent verifier (role verifier, gate input) and by
 * reviewers (role reviewer, advisory, with --findings). --base and --head are
 * required commit SHAs (the tool never resolves refs); it fills sha from head,
 * patch_id from `git patch-id --verbatim` over base...head, diff_id from the
 * SHA-256 of `git diff --raw -z` over the same range, and a UTC timestamp.
 * It exits 1 with `emit-verdict: <reason>` on stderr, and prints no
 * verdict, on any error, including a diff that git patch-id cannot hash to a
 * single id (a NUL byte, or a line that makes it split the diff). Prints the
 * comment body to stdout; it only posts (via `gh pr comment`) when --post and
 * --pr are both given. Never edit a posted verdict comment: edited comments are
 * rejected, so post a new one.
 *
 * Arguments may come from an LLM, so they are treated as untrusted: --base and
 * --head must be full lowercase 40-hex commit SHAs and are passed to git after
 * --end-of-options, --pr must be a plain positive integer of at most 7 digits, and
 * --findings must be a regular file (not a symlink) whose realpath is inside the
 * repository root or $RUNNER_TEMP. git and gh run
 * from a fixed system directory with a fixed PATH, never the caller's PATH.
 * The one exception is an explicit GH_BIN override for gh, which must pass
 * resolveGhBin's ownership and permission checks or the script fails closed.
 *
 *   node scripts/emit-verdict.mjs --role verifier --verdict PASS \
 *     --base "$(git rev-parse origin/main)" --head "$(git rev-parse HEAD)" \
 *     --verifier-id astra-verifier --model-family opus --github-login my-bot \
 *     --evidence verify-run=https://github.com/o/r/actions/runs/1 \
 *     --checks green --conflicts 0 --open-threads 0 [--note "low: ..."] \
 *     [--findings findings.json] [--base-sha <40-hex>] \
 *     [--supersedes <comment id> --reason infra] [--pr 123 --post]
 *
 * --model-family opus and sonnet normalize to claude. Other unknown families are rejected.
 * See docs/verdict-format.md.
 */
import { normalizeModelFamily } from "./ovd-merge-gate.mjs";
import { isEntryPoint } from "./lib/entry-point.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SCHEMA_ID, formatVerdictBlock, tagCorroborated, validateVerdict } from "./verdict-schema.mjs";

/** Fixed, root-owned binary directories. The caller's PATH is never consulted. */
const SAFE_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin"];
const SAFE_ENV = { ...process.env, PATH: SAFE_BIN_DIRS.join(":") };

/** Absolute path of `name` in the first SAFE_BIN_DIRS entry that has it. */
export function resolveBinary(name, { dirs = SAFE_BIN_DIRS, exists = existsSync } = {}) {
  const found = dirs.map((dir) => join(dir, name)).find((candidate) => exists(candidate));
  if (!found) throw new Error(`${name} not found in ${dirs.join(", ")}`);
  return found;
}

/**
 * The gh binary to run. With GH_BIN unset or empty this is the strict
 * SAFE_BIN_DIRS lookup. Otherwise GH_BIN must be an absolute path whose
 * realpath is a regular, executable file owned by the current user or root and
 * not group- or world-writable. Any failed check throws; there is no fallback
 * to the PATH lookup after a bad override.
 */
export function resolveGhBin(env = process.env, { lookup = resolveBinary } = {}) {
  const override = env.GH_BIN;
  if (override === undefined || override === "") return lookup("gh");
  const fail = (reason) => new Error(`GH_BIN ${reason} (got ${JSON.stringify(override)})`);
  if (!isAbsolute(override)) throw fail("must be an absolute path");
  let target;
  try {
    target = realpathSync(override);
  } catch {
    throw fail("does not exist");
  }
  const stat = statSync(target);
  if (!stat.isFile()) throw fail("is not a regular file");
  if (stat.uid !== 0 && stat.uid !== process.getuid?.()) throw fail("must be owned by the current user or root");
  if ((stat.mode & 0o022) !== 0) throw fail("is group- or world-writable");
  try {
    accessSync(target, fsConstants.X_OK);
  } catch {
    throw fail("is not executable");
  }
  return target;
}

/**
 * Run git. Output is a string by default; pass `encoding: "buffer"` for raw
 * bytes (diff content is not guaranteed to be valid UTF-8).
 */
const git = (args, { cwd, input, encoding = "utf8" } = {}) =>
  execFileSync(resolveBinary("git"), args, {
    cwd,
    input,
    env: SAFE_ENV,
    shell: false,
    encoding,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

const SHA = /^[0-9a-f]{40}$/;

/**
 * Accept only a full, lowercase 40-hex commit SHA. Refs are never resolved
 * here; callers pass `$(git rev-parse <ref>)`. Returns the regex match, not the
 * caller's string, so only hex characters ever reach git's argv.
 */
export function assertSha(value, flag) {
  const match = typeof value === "string" ? SHA.exec(value) : null;
  if (!match) throw new Error(`${flag} must be a full 40-character lowercase commit SHA (got ${JSON.stringify(value ?? null)})`);
  return match[0];
}

/** Throw unless `sha` (already validated by assertSha) names a commit in the repository. */
const assertCommit = (sha, flag, { cwd } = {}) => {
  try {
    git(["cat-file", "-e", "--end-of-options", `${sha}^{commit}`], { cwd });
  } catch {
    throw new Error(`${flag} ${sha} is not a commit in this repository`);
  }
};

/**
 * Every diff option that git config could otherwise change is pinned here, so
 * the verifier and OVD-845 compute the same id for the same commits.
 */
const PINNED_DIFF = [
  "-c", "core.quotePath=true",
  "-c", "diff.suppressBlankEmpty=false",
  "diff",
  "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative",
  "--diff-algorithm=myers", "--indent-heuristic", "--unified=3", "--inter-hunk-context=0",
  "--submodule=short", "--ignore-submodules=none", "--full-index", "--binary",
  "--src-prefix=a/", "--dst-prefix=b/", "-O/dev/null",
];

/**
 * `git patch-id --verbatim` of the base...head diff (merge-base to head).
 * `--verbatim` keeps whitespace, so an indentation-only change yields a new id,
 * and implies the order-independent `--stable` hashing (git rejects passing
 * both). Both ends must be full commit SHAs (checked before any git call) and
 * follow `--end-of-options`, so neither can be read as a git option. Throws on
 * an empty diff, on a diff containing a NUL byte (see the guard below) and on
 * a diff that git patch-id splits into more than one patch (see
 * parsePatchIdOutput); the CLI reports each as `emit-verdict: <message>` on
 * stderr and exits 1.
 *
 * The id is lossy by git's design: it ignores hunk line numbers, ignores the
 * `index` lines of text diffs, and does not hash the path of an entry without
 * `---`/`+++` lines that follows a binary patch. Equal ids therefore do not
 * prove an identical change. The verdict binds to `sha` (the head SHA), and
 * reuse across a rebase must also require an equal `diff_id`
 * (computeDiffId). See docs/verdict-format.md.
 */
export function computePatchId({ base, head, cwd }) {
  const baseSha = assertSha(base, "--base");
  const headSha = assertSha(head, "--head");
  assertCommit(baseSha, "--base", { cwd });
  assertCommit(headSha, "--head", { cwd });
  // The diff stays a Buffer end to end: decoding it as UTF-8 would collapse every
  // invalid byte sequence to U+FFFD, so two different diffs could share an id.
  // Only patch-id's ASCII output is decoded.
  const diff = git([...PINNED_DIFF, "--end-of-options", `${baseSha}...${headSha}`, "--"], { cwd, encoding: "buffer" });
  if (diff.length === 0) throw new Error(`computePatchId: ${baseSha}...${headSha} has an empty diff`);
  // git patch-id hashes every diff line with strlen(), so it silently ignores
  // everything after the first NUL byte of a line, even for raw byte input. A
  // file git classifies as text (no NUL in its first 8000 bytes, or marked text
  // by .gitattributes) can still hold a later NUL, and --binary only
  // base85-encodes files git classifies as binary. Two diffs that differ only
  // after such a NUL would then share a patch_id, and OVD-845 would carry a
  // verdict over to a head it never verified. There is no byte-exact patch-id
  // for this input (and patch_id must stay git's own), so fail closed.
  if (diff.includes(0)) {
    throw new Error(
      `computePatchId: ${baseSha}...${headSha} diff contains a NUL byte, which git patch-id cannot hash (it stops reading a line at the first NUL); refusing to compute a patch_id that two different diffs could share`,
    );
  }
  return parsePatchIdOutput(git(["patch-id", "--verbatim"], { cwd, input: diff }), `${baseSha}...${headSha}`);
}

/**
 * The `git diff --raw` options for diff_id. `--raw -z --no-abbrev --no-renames
 * --full-index` select the format; `--no-relative`, `--ignore-submodules=none`,
 * `-O/dev/null` and `--no-color` pin the settings git config could otherwise
 * change (which paths are listed, how, and in what order).
 */
const PINNED_RAW_DIFF = [
  "diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--full-index",
  "--no-relative", "--ignore-submodules=none", "-O/dev/null", "--no-color",
];

/**
 * `diff_id`: the lowercase hex SHA-256 of the exact bytes of `git diff --raw -z`
 * over base...head (merge-base to head, the same range as computePatchId).
 * That output has one NUL-terminated record per changed path with its old and
 * new mode, its full old and new blob ids, a status letter and the path, so
 * two diffs share a diff_id only if the same paths changed between the same
 * blobs with the same modes. Unlike patch_id it hashes no diff text, so hunk
 * positions, binary patches, NUL bytes and encodings cannot make two different
 * diffs collide. A rebase onto a base that did not touch any of the changed
 * paths keeps the diff_id; a base that changed one of them gives a new one.
 *
 * Same argument rules as computePatchId: both ends must be full commit SHAs,
 * checked before any git call, and follow `--end-of-options`. The output stays
 * a Buffer and is hashed without decoding. Throws on an empty diff.
 */
export function computeDiffId({ base, head, cwd }) {
  const baseSha = assertSha(base, "--base");
  const headSha = assertSha(head, "--head");
  assertCommit(baseSha, "--base", { cwd });
  assertCommit(headSha, "--head", { cwd });
  const raw = git([...PINNED_RAW_DIFF, "--end-of-options", `${baseSha}...${headSha}`, "--"], { cwd, encoding: "buffer" });
  if (raw.length === 0) throw new Error(`computeDiffId: ${baseSha}...${headSha} has an empty diff`);
  return createHash("sha256").update(raw).digest("hex");
}

/** One `git patch-id` output line: `<patch id> <commit id or 40 zeros>`. */
const PATCH_ID_LINE = /^([0-9a-f]{40}) [0-9a-f]{40}$/;

/**
 * The patch id out of `git patch-id` output for one diff, or a thrown error.
 * git tests every input line with get_oid_hex(): a line that starts with 40 hex
 * characters is taken for the next commit's id, which ends the current patch
 * and starts a new one, and git prints one output line per patch. Diff text
 * lines start with `+`, `-` or a space, but a base85 data line of a `GIT binary
 * patch` starts with a length character, and `c` to `f` are hex digits, so a
 * crafted (yet valid) binary patch can split a diff in two. Taking the first id
 * would then ignore every file after the split. A single diff must yield
 * exactly one line of the form `<40-hex> <40-hex or zeros>`; anything else
 * fails closed. `label` names the diff in the error message.
 */
export function parsePatchIdOutput(output, label = "the diff") {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error(`computePatchId: git patch-id returned no id for ${label}`);
  if (lines.length > 1) {
    throw new Error(
      `computePatchId: git patch-id returned ${lines.length} ids for ${label}, which is one diff; a diff line that starts with 40 hex characters (for example a base85 line of a binary patch) makes it split the diff into several patches, and everything after the split would go unhashed, so refusing to compute a patch_id that two different diffs could share`,
    );
  }
  const match = PATCH_ID_LINE.exec(lines[0]);
  if (!match) throw new Error(`computePatchId: git patch-id returned an unexpected line for ${label}: ${JSON.stringify(lines[0])}`);
  return match[1];
}

const parseCount = (name, value) => {
  if (!/^\d+$/.test(value ?? "")) throw new Error(`--${name} must be a non-negative integer (got ${JSON.stringify(value ?? null)})`);
  return Number(value);
};

/** GitHub comment id. Omitted flag stays omitted so the verdict bytes do not gain a key. */
const parseSupersedes = (value) => {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--supersedes must be a positive integer comment id (got ${JSON.stringify(value)})`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--supersedes must be a positive integer comment id (got ${JSON.stringify(value)})`);
  return parsed;
};

function isGateFinding(finding) {
  return Boolean(finding) && typeof finding === "object" && !Array.isArray(finding) && Object.hasOwn(finding, "summary");
}

/**
 * Legacy findings (no `summary`) are tagged `corroborated`, as before, even
 * when gate findings sit next to them: corroboration is decided per legacy
 * finding, against the other legacy findings, and any caller-supplied
 * `corroborated` value is overwritten. Gate findings are emitted unchanged
 * (`corroborated` is not part of that shape), and the original order is kept.
 */
function prepareFindings(findings) {
  if (!Array.isArray(findings)) throw new Error("findings must be a JSON array of finding objects");
  const tagged = tagCorroborated(findings.filter((finding) => !isGateFinding(finding)), { normalizeFamily: normalizeModelFamily });
  let next = 0;
  return findings.map((finding) => (isGateFinding(finding) ? finding : tagged[next++]));
}

const parseEvidence = (entry) => {
  const at = entry.indexOf("=");
  if (at <= 0) throw new Error(`--evidence must be kind=https://url (got ${JSON.stringify(entry)})`);
  return { kind: entry.slice(0, at), url: entry.slice(at + 1) };
};

/**
 * Build a verdict object (sha/patch_id/diff_id/timestamp may be passed
 * explicitly for tests or computed from git) and validate it. Throws with
 * every schema error.
 */
export function buildVerdict(input, { cwd, now = new Date() } = {}) {
  if (input.findings !== undefined && !Array.isArray(input.findings)) throw new Error("findings must be a JSON array of finding objects");
  const modelFamily = normalizeModelFamily(input.modelFamily);
  if (modelFamily === null) throw new Error("verdict_schema_error: unknown --model-family");
  // Diff the exact head commit, so sha, patch_id and diff_id always describe the same tree.
  const sha = input.sha ?? assertSha(input.head, "--head");
  // Optional keys are spread only when the caller set them, so a verdict that
  // uses none of the OVD-845 fields stays byte-identical to the previous emitter.
  const verdict = {
    schema: SCHEMA_ID,
    role: input.role,
    verdict: input.verdict,
    sha,
    ...(input.baseSha !== undefined ? { base_sha: input.baseSha } : {}),
    patch_id: input.patchId ?? computePatchId({ base: input.base, head: sha, cwd }),
    diff_id: input.diffId ?? computeDiffId({ base: input.base, head: sha, cwd }),
    verifier: { id: input.verifierId, model_family: modelFamily, github_login: input.githubLogin },
    evidence: input.evidence ?? [],
    notes: input.notes ?? [],
    readiness: input.readiness,
    ...(input.findings !== undefined ? { findings: prepareFindings(input.findings) } : {}),
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    timestamp: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  const { ok, errors } = validateVerdict(verdict, { now });
  if (!ok) throw new Error(`invalid verdict:\n- ${errors.join("\n- ")}`);
  return verdict;
}

/** The PR comment body: one human summary line plus the machine-readable fenced block. */
export function formatComment(verdict) {
  const advisory = verdict.role === "reviewer" ? " (advisory reviewer verdict, not gate input)" : "";
  return [
    `**OverDrafter verdict: ${verdict.verdict}** for \`${verdict.sha}\` by ${verdict.verifier.id} (${verdict.verifier.model_family})${advisory}.`,
    "",
    formatVerdictBlock(verdict),
    "",
    "_Do not edit this comment. Edited verdict comments are invalid; post a new comment instead._",
    "",
  ].join("\n");
}

const PR_NUMBER = /^[1-9]\d{0,6}$/;
const BODY_FILE = "verdict.md";

/**
 * Post via `gh pr comment`. argv is fixed apart from the validated PR number;
 * the body is written to a file in a fresh private temp directory and passed
 * with --body-file, never through argv or stdin. The directory is always
 * removed afterwards. `run` and `gh` are injectable so tests never touch GitHub.
 */
export function postComment({ pr, body, cwd, run = spawnSync, gh }) {
  const match = PR_NUMBER.exec(String(pr ?? ""));
  if (!match) throw new Error("--post requires --pr <positive integer>");
  const prNumber = match[0];
  const ghBin = gh ?? resolveGhBin();
  const dir = mkdtempSync(join(tmpdir(), "ovd851-verdict-"));
  try {
    const bodyFile = join(dir, BODY_FILE);
    writeFileSync(bodyFile, body, { encoding: "utf8", mode: 0o600 });
    const result = run(ghBin, ["pr", "comment", prNumber, "--body-file", bodyFile], {
      cwd,
      env: SAFE_ENV,
      shell: false,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (result.error || result.status !== 0) {
      const reason = result.error?.message ?? "exit " + result.status;
      throw new Error(`gh pr comment failed (${reason})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True when `target` is strictly below `root` (both absolute, already resolved). */
const isInside = (root, target) => {
  const rel = relative(root, target);
  return rel !== "" && !rel.split(/[\\/]/).includes("..") && !isAbsolute(rel);
};

/**
 * Directories an input file may live in: the repository root (git toplevel of
 * `cwd`, or `cwd` itself outside a repository), plus $RUNNER_TEMP when set.
 */
export function inputBases({ cwd = process.cwd(), env = process.env } = {}) {
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], { cwd }).trim();
  } catch {
    root = cwd;
  }
  return [root, env.RUNNER_TEMP].filter(Boolean).map((base) => realpathSync(resolve(base)));
}

/**
 * Resolve a --findings path against each base in order (`path.resolve(base,
 * file)`). The path itself must not be a symlink, and its realpath must sit
 * strictly inside that base. Returns the validated realpath; anything else is
 * refused.
 */
export function resolveInputFile(file, { cwd = process.cwd(), env = process.env } = {}) {
  const label = `--findings ${JSON.stringify(file)}`;
  const bases = inputBases({ cwd, env });
  let found = false;
  for (const base of bases) {
    const candidate = resolve(base, file);
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      continue;
    }
    found = true;
    if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
    const real = realpathSync(candidate);
    if (!isInside(base, real)) continue;
    // A FIFO, socket, device or directory would block or fail inside readFileSync.
    // Check the resolved target too: a symlinked parent directory changes what is read.
    if (!stat.isFile() || !statSync(real).isFile()) throw new Error(`${label} must be a regular file`);
    return real;
  }
  if (!found) throw new Error(`${label} does not exist`);
  throw new Error(`${label} must be inside the repository root${env.RUNNER_TEMP ? " or $RUNNER_TEMP" : ""}`);
}

const readFindings = (file, { cwd, env } = {}) => {
  const validated = resolveInputFile(file, { cwd, env });
  const findings = JSON.parse(readFileSync(validated, "utf8"));
  if (!Array.isArray(findings)) throw new Error(`--findings ${file} must contain a JSON array of finding objects`);
  return findings;
};

const OPTIONS = {
  role: { type: "string", default: "verifier" },
  verdict: { type: "string" },
  base: { type: "string" },
  head: { type: "string" },
  "verifier-id": { type: "string" },
  "model-family": { type: "string" },
  "github-login": { type: "string" },
  evidence: { type: "string", multiple: true, default: [] },
  note: { type: "string", multiple: true, default: [] },
  checks: { type: "string" },
  conflicts: { type: "string" },
  "open-threads": { type: "string" },
  findings: { type: "string" },
  "base-sha": { type: "string" },
  supersedes: { type: "string" },
  reason: { type: "string" },
  pr: { type: "string" },
  post: { type: "boolean", default: false },
};

/** CLI entry point. Returns the comment body; posts only with --post. */
export function main(argv = process.argv.slice(2), { cwd, now, run, env } = {}) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
  // Both are required and checked before any git call (including --findings resolution).
  const base = assertSha(values.base, "--base");
  const head = assertSha(values.head, "--head");
  const verdict = buildVerdict(
    {
      role: values.role,
      verdict: values.verdict,
      base,
      head,
      verifierId: values["verifier-id"],
      modelFamily: values["model-family"],
      githubLogin: values["github-login"],
      evidence: values.evidence.map(parseEvidence),
      notes: values.note,
      readiness: {
        conflicts: parseCount("conflicts", values.conflicts),
        open_threads: parseCount("open-threads", values["open-threads"]),
        checks: values.checks,
      },
      findings: values.findings === undefined ? undefined : readFindings(values.findings, { cwd, env }),
      baseSha: values["base-sha"] === undefined ? undefined : assertSha(values["base-sha"], "--base-sha"),
      supersedes: parseSupersedes(values.supersedes),
      reason: values.reason,
    },
    { cwd, now },
  );
  const body = formatComment(verdict);
  if (values.post) postComment({ pr: values.pr, body, cwd, run });
  return body;
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.stdout.write(main());
  } catch (error) {
    process.stderr.write(`emit-verdict: ${error.message}\n`);
    process.exit(1);
  }
}

export { isEntryPoint } from "./lib/entry-point.mjs";
