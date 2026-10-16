#!/usr/bin/env node
/**
 * OVD-851: build, validate, and print an `overdrafter.verdict/v1` PR comment.
 *
 * Used by the independent verifier (role verifier, gate input) and by
 * reviewers (role reviewer, advisory, with --findings). Resolves base and head
 * to commit SHAs once, then fills sha from the resolved head, patch_id from
 * `git patch-id --verbatim` over base...head, and a UTC timestamp. Prints the comment body to stdout; it only
 * posts (via `gh pr comment`) when --post and --pr are both given. Never edit a
 * posted verdict comment: edited comments are rejected, so post a new one.
 *
 * Arguments may come from an LLM, so they are treated as untrusted: --base and
 * --head must look like git revisions (no leading "-", no "..", only ref
 * characters), --pr must be a plain positive integer, and --findings must be a
 * file inside the working directory or the OS temp directory. git and gh run
 * from a fixed system directory with a fixed PATH, never the caller's PATH.
 * The one exception is an explicit GH_BIN override for gh, which must pass
 * resolveGhBin's ownership and permission checks or the script fails closed.
 *
 *   node scripts/emit-verdict.mjs --role verifier --verdict PASS \
 *     --base origin/main --head HEAD \
 *     --verifier-id astra-verifier --model-family opus --github-login my-bot \
 *     --evidence verify-run=https://github.com/o/r/actions/runs/1 \
 *     --checks green --conflicts 0 --open-threads 0 [--note "low: ..."] \
 *     [--findings findings.json] [--pr 123 --post]
 *
 * See docs/verdict-format.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

const git = (args, { cwd, input } = {}) =>
  execFileSync(resolveBinary("git"), args, {
    cwd,
    input,
    env: SAFE_ENV,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

const REV = /^[A-Za-z0-9_][A-Za-z0-9._/@{}~^+-]{0,254}$/;

/** Reject anything that is not a plain revision (branch, tag, SHA, HEAD~n, ...) before it reaches git. */
export function assertRev(rev) {
  if (typeof rev !== "string" || !REV.test(rev) || rev.includes("..")) {
    throw new Error(`invalid revision ${JSON.stringify(rev ?? null)}: use a branch, tag, or commit SHA`);
  }
  return rev;
}

/** Resolve a revision to its 40-hex commit SHA. */
export function resolveSha(rev, { cwd } = {}) {
  return git(["rev-parse", "--verify", "--end-of-options", `${assertRev(rev)}^{commit}`], { cwd }).trim();
}

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
 * both). Both ends are validated and resolved with `resolveSha` (which ends
 * option parsing) before the diff, so neither can be read as a git option.
 */
export function computePatchId({ base, head, cwd }) {
  const baseSha = resolveSha(base, { cwd });
  const headSha = resolveSha(head, { cwd });
  const diff = git([...PINNED_DIFF, `${baseSha}...${headSha}`, "--"], { cwd });
  if (!diff.trim()) throw new Error(`computePatchId: ${base}...${head} has an empty diff`);
  const [patchId] = git(["patch-id", "--verbatim"], { cwd, input: diff }).trim().split(/\s+/);
  if (!/^[0-9a-f]{40}$/.test(patchId ?? "")) throw new Error("computePatchId: git patch-id returned no id");
  return patchId;
}

const parseCount = (name, value) => {
  if (!/^\d+$/.test(value ?? "")) throw new Error(`--${name} must be a non-negative integer (got ${JSON.stringify(value ?? null)})`);
  return Number(value);
};

const parseEvidence = (entry) => {
  const at = entry.indexOf("=");
  if (at <= 0) throw new Error(`--evidence must be kind=https://url (got ${JSON.stringify(entry)})`);
  return { kind: entry.slice(0, at), url: entry.slice(at + 1) };
};

/**
 * Build a verdict object (sha/patch_id/timestamp may be passed explicitly for
 * tests or computed from git) and validate it. Throws with every schema error.
 */
export function buildVerdict(input, { cwd, now = new Date() } = {}) {
  if (input.findings !== undefined && !Array.isArray(input.findings)) throw new Error("findings must be a JSON array of finding objects");
  // Resolve head once and diff that exact commit, so sha and patch_id always describe the same tree.
  const sha = input.sha ?? resolveSha(input.head, { cwd });
  const verdict = {
    schema: SCHEMA_ID,
    role: input.role,
    verdict: input.verdict,
    sha,
    patch_id: input.patchId ?? computePatchId({ base: input.base, head: sha, cwd }),
    verifier: { id: input.verifierId, model_family: input.modelFamily, github_login: input.githubLogin },
    evidence: input.evidence ?? [],
    notes: input.notes ?? [],
    readiness: input.readiness,
    ...(input.findings !== undefined ? { findings: tagCorroborated(input.findings) } : {}),
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

/**
 * Post via `gh pr comment`. The body goes over stdin, never argv. `run` and
 * `gh` are injectable so tests never touch GitHub.
 */
export function postComment({ pr, body, cwd, run = spawnSync, gh }) {
  const prNumber = String(pr ?? "");
  if (!/^[1-9]\d{0,9}$/.test(prNumber)) throw new Error("--post requires --pr <positive integer>");
  const result = run(gh ?? resolveGhBin(), ["pr", "comment", prNumber, "--body-file", "-"], {
    cwd,
    input: body,
    env: SAFE_ENV,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? "exit " + result.status;
    throw new Error(`gh pr comment failed (${reason})`);
  }
}

const isInside = (root, target) => {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * Resolve a --findings path and require it (after following symlinks) to sit
 * inside `cwd` or the OS temp directory. Anything else is refused.
 */
export function resolveInputFile(file, { cwd = process.cwd() } = {}) {
  const roots = [cwd, tmpdir()].map((root) => realpathSync(resolve(root)));
  let target;
  try {
    target = realpathSync(resolve(cwd, file));
  } catch {
    throw new Error(`--findings ${JSON.stringify(file)} does not exist`);
  }
  if (!roots.some((root) => isInside(root, target))) {
    throw new Error(`--findings ${JSON.stringify(file)} must be inside the working directory or ${tmpdir()}`);
  }
  return target;
}

const readFindings = (file, { cwd } = {}) => {
  const findings = JSON.parse(readFileSync(resolveInputFile(file, { cwd }), "utf8"));
  if (!Array.isArray(findings)) throw new Error(`--findings ${file} must contain a JSON array of finding objects`);
  return findings;
};

const OPTIONS = {
  role: { type: "string", default: "verifier" },
  verdict: { type: "string" },
  base: { type: "string", default: "origin/main" },
  head: { type: "string", default: "HEAD" },
  "verifier-id": { type: "string" },
  "model-family": { type: "string" },
  "github-login": { type: "string" },
  evidence: { type: "string", multiple: true, default: [] },
  note: { type: "string", multiple: true, default: [] },
  checks: { type: "string" },
  conflicts: { type: "string" },
  "open-threads": { type: "string" },
  findings: { type: "string" },
  pr: { type: "string" },
  post: { type: "boolean", default: false },
};

/** CLI entry point. Returns the comment body; posts only with --post. */
export function main(argv = process.argv.slice(2), { cwd, now, run } = {}) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
  const verdict = buildVerdict(
    {
      role: values.role,
      verdict: values.verdict,
      base: values.base,
      head: values.head,
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
      findings: values.findings === undefined ? undefined : readFindings(values.findings, { cwd }),
    },
    { cwd, now },
  );
  const body = formatComment(verdict);
  if (values.post) postComment({ pr: values.pr, body, cwd, run });
  return body;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(main());
  } catch (error) {
    process.stderr.write(`emit-verdict: ${error.message}\n`);
    process.exit(1);
  }
}
