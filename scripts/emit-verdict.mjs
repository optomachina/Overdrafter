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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SCHEMA_ID, formatVerdictBlock, tagCorroborated, validateVerdict } from "./verdict-schema.mjs";

const git = (args, { cwd, input } = {}) =>
  execFileSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });

/** Resolve a revision to its 40-hex commit SHA. */
export function resolveSha(rev, { cwd } = {}) {
  return git(["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], { cwd }).trim();
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
 * both). Both ends are resolved with `resolveSha` (which ends option parsing)
 * before the diff, so neither can be read as a git option.
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

/** Post via `gh pr comment`. `run` is injectable so tests never touch GitHub. */
export function postComment({ pr, body, cwd, run = spawnSync }) {
  if (!/^\d+$/.test(String(pr ?? ""))) throw new Error("--post requires --pr <number>");
  const result = run("gh", ["pr", "comment", String(pr), "--body-file", "-"], { cwd, input: body, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] });
  if (result.error || result.status !== 0) throw new Error(`gh pr comment failed (${result.error?.message ?? `exit ${result.status}`})`);
}

const readFindings = (file) => {
  const findings = JSON.parse(readFileSync(file, "utf8"));
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
      findings: values.findings === undefined ? undefined : readFindings(values.findings),
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
