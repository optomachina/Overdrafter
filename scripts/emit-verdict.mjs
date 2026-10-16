#!/usr/bin/env node
/**
 * OVD-851: build, validate, and print an `overdrafter.verdict/v1` PR comment.
 *
 * Used by the independent verifier (role verifier, gate input) and by
 * reviewers (role reviewer, advisory, with --findings). Fills sha from
 * `git rev-parse <head>`, patch_id from `git patch-id --stable` over
 * base...head, and a UTC timestamp. Prints the comment body to stdout; it only
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
 * `git patch-id --stable` of the base...head diff (merge-base to head). Diff
 * options are pinned so local git config cannot change the id.
 */
export function computePatchId({ base, head, cwd }) {
  const diff = git(
    ["-c", "core.quotePath=true", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--diff-algorithm=myers", "--src-prefix=a/", "--dst-prefix=b/", `${base}...${head}`, "--"],
    { cwd },
  );
  if (!diff.trim()) throw new Error(`computePatchId: ${base}...${head} has an empty diff`);
  const [patchId] = git(["patch-id", "--stable"], { cwd, input: diff }).trim().split(/\s+/);
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
  const verdict = {
    schema: SCHEMA_ID,
    role: input.role,
    verdict: input.verdict,
    sha: input.sha ?? resolveSha(input.head, { cwd }),
    patch_id: input.patchId ?? computePatchId({ base: input.base, head: input.head, cwd }),
    verifier: { id: input.verifierId, model_family: input.modelFamily, github_login: input.githubLogin },
    evidence: input.evidence ?? [],
    notes: input.notes ?? [],
    readiness: input.readiness,
    ...(input.findings !== undefined ? { findings: tagCorroborated(input.findings) } : {}),
    timestamp: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  const { ok, errors } = validateVerdict(verdict);
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
export function postComment({ pr, body, run = spawnSync }) {
  if (!/^\d+$/.test(String(pr ?? ""))) throw new Error("--post requires --pr <number>");
  const result = run("gh", ["pr", "comment", String(pr), "--body-file", "-"], { input: body, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] });
  if (result.error || result.status !== 0) throw new Error(`gh pr comment failed (${result.error?.message ?? `exit ${result.status}`})`);
}

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
      findings: values.findings === undefined ? undefined : JSON.parse(readFileSync(values.findings, "utf8")),
    },
    { cwd, now },
  );
  const body = formatComment(verdict);
  if (values.post) postComment({ pr: values.pr, body, run });
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
