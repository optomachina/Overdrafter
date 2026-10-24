#!/usr/bin/env node
/**
 * Overdrafter QA: build an overdrafter.verdict/v1 PR comment body (OVD-851 format,
 * docs/verdict-format.md) with the QA human header kept on line 1.
 *
 * Reuses the repo's own code, never a copy: buildVerdict/formatComment from
 * scripts/emit-verdict.mjs and validateVerdict/parseVerdictComments from
 * scripts/verdict-schema.mjs, loaded from --schema-repo (an origin/main checkout).
 * patch_id and diff_id are computed by the repo functions over <base>...<sha>
 * in --git-dir (any checkout whose object db holds both commits).
 *
 * NEVER posts. Prints the body (or writes --out). Post it yourself as a NEW comment;
 * never edit a verdict comment (edited comments are rejected by the parser).
 *
 *   node verdict-v1.mjs --pr 845 --sha <40hex> --base <40hex> --verdict FAIL \
 *     --findings findings.json --evidence test=https://github.com/.../actions/runs/1 \
 *     --local-evidence /workspace/qa-batch/845.log \
 *     --proof 'Proof re-run: `cmd` at <sha>' \
 *     --families 'families: builder=unknown reviewers=none cross_family=false qa_catch_after_review=false' \
 *     --checks red --conflicts 0 --open-threads 0 --summary 'one-line why' --out 845-verdict-v1.md [--check]
 *
 * findings.json: [{ "severity": "high|medium|low|info" | "blocking": true|false,
 *                   "kind": "real|tracking|...", "file": "path", "line": 41, "message": "..." }]
 *   severity wins; else blocking:true -> high, blocking:false -> low.
 * Verdict mapping: FAIL -> FAIL; PASS with no notes -> PASS; PASS with notes -> PASS_NOTES
 *   (a high note on PASS is refused: blocking findings mean FAIL).
 * --check: also run the comment through parseVerdictComments as a simulated fresh,
 *   unedited comment by --github-login and print the result (exit 1 unless accepted).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const DEFAULTS = {
  "schema-repo": "/workspace/qa-batch/wt-verdict",
  "git-dir": "/workspace/qa-batch/repo-fresh",
  "verifier-id": "68639ff6-bbc0-436d-86d5-f6de3ddb9054",
  "model-family": "grok",
  "github-login": "optomachina",
};
const HEX40 = /^[0-9a-f]{40}$/;
const FAMILIES = /^families: builder=(codex|claude|grok|jev|unknown) reviewers=(none|[a-z0-9-]+:[^\s:,]+:[A-Z_]+@[0-9a-f]{7,40}(,[a-z0-9-]+:[^\s:,]+:[A-Z_]+@[0-9a-f]{7,40})*) cross_family=(true|false) qa_catch_after_review=(true|false)$/;

const { values: v } = parseArgs({
  strict: true,
  options: {
    pr: { type: "string" }, sha: { type: "string" }, base: { type: "string" },
    verdict: { type: "string" }, findings: { type: "string" },
    evidence: { type: "string", multiple: true, default: [] },
    "local-evidence": { type: "string", multiple: true, default: [] },
    proof: { type: "string" }, families: { type: "string" },
    summary: { type: "string", multiple: true, default: [] },
    checks: { type: "string" }, conflicts: { type: "string" }, "open-threads": { type: "string" },
    "schema-repo": { type: "string" }, "git-dir": { type: "string" },
    "verifier-id": { type: "string" }, "model-family": { type: "string" }, "github-login": { type: "string" },
    out: { type: "string" }, check: { type: "boolean", default: false },
  },
});
const opt = (k) => v[k] ?? DEFAULTS[k];
const die = (msg) => { process.stderr.write(`verdict-v1: ${msg}\n`); process.exit(1); };

const schemaRepo = resolve(opt("schema-repo"));
const { buildVerdict, formatComment } = await import(pathToFileURL(join(schemaRepo, "scripts/emit-verdict.mjs")).href);
const { parseVerdictComments } = await import(pathToFileURL(join(schemaRepo, "scripts/verdict-schema.mjs")).href);

if (!/^[1-9]\d{0,6}$/.test(v.pr ?? "")) die("--pr must be a PR number");
if (!HEX40.test(v.sha ?? "")) die("--sha must be the full 40-char lowercase head SHA");
if (!HEX40.test(v.base ?? "")) die("--base must be a full 40-char SHA (PR baseRefOid or `git rev-parse origin/main`)");
const qa = (v.verdict ?? "").toUpperCase();
if (!["PASS", "FAIL"].includes(qa)) die("--verdict must be PASS or FAIL");
if (!v.proof || !/^Proof re-run: \S/.test(v.proof) || !v.proof.includes(v.sha)) die("--proof must start 'Proof re-run: ' and contain the full --sha");
if (!v.families || !FAMILIES.test(v.families)) die("--families must be the OVD-912 line: families: builder=<codex|claude|grok|jev|unknown> reviewers=<none|family:model:VERDICT@sha,...> cross_family=<true|false> qa_catch_after_review=<true|false>");
if (v.evidence.length === 0) die("at least one --evidence kind=https://... is required (verify-run|test|log|artifact)");
const gitDir = resolve(opt("git-dir"));
for (const s of [v.sha, v.base]) {
  try { execFileSync("git", ["cat-file", "-e", `${s}^{commit}`], { cwd: gitDir, stdio: "ignore" }); }
  catch { die(`${s} is not in ${gitDir}; run: git -C ${gitDir} fetch origin pull/${v.pr}/head main`); }
}

const findings = v.findings ? JSON.parse(readFileSync(v.findings, "utf8")) : [];
if (!Array.isArray(findings)) die("--findings must hold a JSON array");
const notes = findings.map((f, i) => {
  const sev = f.severity ?? (f.blocking === true ? "high" : f.blocking === false ? "low" : null);
  if (!["high", "medium", "low", "info"].includes(sev)) die(`finding ${i}: needs severity high|medium|low|info or blocking true|false`);
  if (!f.message) die(`finding ${i}: message required`);
  const tag = f.blocking === true || sev === "high" ? "blocking" : "follow-up";
  const tags = [tag, f.kind && f.kind !== tag ? f.kind : null].filter(Boolean).join(", ");
  const loc = f.file ? ` (${f.file}${Array.isArray(f.lines) ? `:${f.lines.join(",")}` : f.line ? `:${f.line}` : ""})` : "";
  return `${sev}: [${tags}] ${f.message.replace(/\s+/g, " ").trim()}${loc}`;
});
const hasHigh = notes.some((n) => n.startsWith("high:"));
let verdict;
if (qa === "FAIL") verdict = "FAIL";
else if (hasHigh) die("PASS with a high (blocking) finding is contradictory; use FAIL");
else verdict = notes.length ? "PASS_NOTES" : "PASS";
if (qa === "FAIL" && !hasHigh) process.stderr.write("verdict-v1: warning: FAIL without any high/blocking finding\n");

const evidence = v.evidence.map((e) => {
  const at = e.indexOf("=");
  if (at <= 0) die(`--evidence must be kind=https://url (got ${JSON.stringify(e)})`);
  return { kind: e.slice(0, at), url: e.slice(at + 1) };
});
const count = (name) => { const x = v[name]; if (!/^\d+$/.test(x ?? "")) die(`--${name} must be a non-negative integer`); return Number(x); };
const now = new Date();
let obj;
try {
  obj = buildVerdict({
    role: "verifier", verdict, base: v.base, head: v.sha,
    verifierId: opt("verifier-id"), modelFamily: opt("model-family"), githubLogin: opt("github-login"),
    evidence, notes,
    readiness: { conflicts: count("conflicts"), open_threads: count("open-threads"), checks: v.checks },
  }, { cwd: gitDir, now });
} catch (e) { die(e.message); }

const human = [
  `QA: ${qa} on ${v.sha}`,
  ...v.summary,
  ...(findings.length ? ["", "Findings:", ...notes.map((n) => `- ${n}`)] : []),
  ...(v["local-evidence"].length ? ["", `Local evidence (QA box): ${v["local-evidence"].map((p) => `\`${p}\``).join(", ")}`] : []),
  "",
  v.proof,
  v.families,
  "",
  "",
];
const body = human.join("\n") + formatComment(obj);
if (body.split("\n")[0] !== `QA: ${qa} on ${v.sha}`) die("internal: first line drifted");

if (v.out) writeFileSync(v.out, body); else process.stdout.write(body);

if (v.check) {
  const created = new Date(now.getTime() + 2000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const r = parseVerdictComments([{ id: 1, body, created_at: created, updated_at: created, user: { login: opt("github-login") } }], { sha: v.sha });
  const ok = r.verdict && !r.conflict && r.rejected.length === 0;
  process.stderr.write(`verdict-v1 check: ${ok ? "ACCEPTED" : "REJECTED"} verdict=${r.verdict?.verdict ?? null} conflict=${r.conflict} rejected=${JSON.stringify(r.rejected)}\n`);
  if (!ok) process.exit(1);
}
