#!/usr/bin/env node
// OVD-921: evidence for an operator, never a protection or merge gate.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function onBlock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^(?:on|"on"|'on'):/.test(line));
  if (start === -1) return "";
  const block = [lines[start].slice(lines[start].indexOf(":") + 1).trimStart()];
  let index = start + 1;
  while (index < lines.length && (lines[index].trim() === "" || /^[ \t]/.test(lines[index]))) {
    block.push(lines[index]);
    index += 1;
  }
  return block.join("\n");
}

function hasTrigger(lines, name) {
  return lines.some((line) => {
    const trimmed = line.trim();
    if (trimmed === name || trimmed.split(":", 1)[0].trimEnd() === name) return true;
    return trimmed.split(/[,[\]]/).slice(1, -1).some((entry) => entry.trim() === name);
  });
}

function hasUntrustedCheckout(text) {
  const steps = text.split(/^ {6}- /m).slice(1);
  return steps.some((step) => {
    const lines = step.split("\n");
    return lines.some((line) => /^uses:\s*actions\/checkout@/.test(line.trim()))
      && lines.some((line) => /^\s/.test(line) && line.trim().startsWith("ref:")
        && ["head.sha", "head.ref", "head_sha", "github.event.pull_request.head"].some((head) => line.includes(head)));
  });
}

function jobBlock(text, jobId) {
  const lines = text.split("\n");
  const jobs = lines.indexOf("jobs:");
  if (jobs === -1) return "";
  const start = lines.findIndex((line, index) => index > jobs && line === `  ${jobId}:`);
  if (start === -1) return "";
  let end = start + 1;
  while (end < lines.length && !/^\S|^ {2}\S/.test(lines[end])) end += 1;
  return lines.slice(start + 1, end).join("\n");
}

export function checkWorkflowShape(workflowText, jobId) {
  const text = workflowText.replaceAll("\r\n", "\n");
  const triggers = onBlock(text).split("\n");
  const findings = [];
  const add = (code, detail) => findings.push({ code, detail });
  if (!hasTrigger(triggers, "merge_group")) {
    add("no_merge_group", "on: must include merge_group");
  }
  if (triggers.some((line) => /^\s/.test(line) && /^paths(?:-ignore)?\s*:/.test(line.trim()))) {
    add("paths_filter", "trigger has a paths filter");
  }
  const job = jobBlock(text, jobId);
  if (!job) add("job_missing", `job ${jobId} is missing`);
  else {
    const lines = job.split("\n");
    if (lines.some((line) => /^ {4}if\s*:/.test(line))) add("job_level_if", "job-level if can skip reporting");
    const name = lines.find((line) => line.startsWith("    name:"));
    if (name?.slice("    name:".length).trim() !== jobId) {
      add("job_name_mismatch", `job name must be exactly ${jobId}`);
    }
  }
  if ((hasTrigger(triggers, "pull_request_target") || hasTrigger(triggers, "workflow_run")) && hasUntrustedCheckout(text)) {
    add("untrusted_checkout", "privileged trigger checks out a PR head");
  }
  return { ok: findings.length === 0, findings };
}

export function reportingHistory({ heads, checkRunsBySha, checkName, appId = 15368 }) {
  const missing = heads.filter(({ sha }) => !(checkRunsBySha[sha] ?? [])
    .some((run) => run.name === checkName && run.app?.id === appId));
  return { total: heads.length, covered: heads.length - missing.length, missing,
    ok: heads.length > 0 && missing.length === 0 };
}

export function replayMergedPrs({ prs, evaluate = () => ({ applicable: false, reason: "no evaluator on main" }) }) {
  const result = { total: prs.length, applicable: 0, notApplicable: [], falseBlocks: [] };
  for (const pr of prs) {
    const verdict = evaluate(pr);
    if (!verdict.applicable) result.notApplicable.push({ number: pr.number, reason: verdict.reason });
    else {
      result.applicable += 1;
      if (verdict.block) result.falseBlocks.push({ number: pr.number, reason: verdict.reason });
    }
  }
  return result;
}

export function buildReport({ check, shape, history, replay }) {
  const reasons = [];
  if (!shape.ok) reasons.push(...shape.findings.map((finding) => finding.code));
  if (!history.ok) reasons.push("reporting_history_incomplete");
  if (replay) {
    if (replay.falseBlocks.length > 0) reasons.push("replay_false_blocks");
    if (replay.applicable === 0) reasons.push("replay_no_applicable_prs");
  }
  return { check, ready: reasons.length === 0, reasons, shape, history, replay, mode: "report" };
}

export function assertReadOnlyGhArgs(args) {
  // A deliberately small allowlist excludes fields, input, headers and aliases.
  if (!Array.isArray(args) || args[0] !== "api" || typeof args[1] !== "string"
    || !/^repos\/[\w.-]+\/[\w.-]+\/[\w/?=&.-]+$/.test(args[1])) {
    throw new Error("only gh api repository GET paths are allowed");
  }
  const rest = args.slice(2);
  if (rest.length !== 0 && !(rest.length === 2 && ["--method", "-X"].includes(rest[0]) && rest[1] === "GET")) {
    throw new Error("only GET without request fields or input is allowed");
  }
}

export const SAFE_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];

export function resolveBinary(name, { dirs = SAFE_BIN_DIRS, exists = existsSync } = {}) {
  const found = dirs.map((dir) => join(dir, name)).find((candidate) => exists(candidate));
  if (!found) throw new Error(`${name} not found in fixed binary directories`);
  return found;
}

function runGhDefault(args) {
  assertReadOnlyGhArgs(args);
  const result = spawnSync(resolveBinary("gh"), args, { encoding: "utf8", env: { ...process.env, PATH: SAFE_BIN_DIRS.join(":") } });
  // Never forward stderr: an external command may include sensitive diagnostics.
  if (result.error || result.status !== 0) throw new Error("GitHub read failed");
  return JSON.parse(result.stdout);
}

function readArgs(argv) {
  const args = { repo: "optomachina/Overdrafter", heads: 20 };
  const valued = new Set(["check", "workflow", "job", "heads", "dry-run-merged", "evaluator", "repo"]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    if (argv[i] === "--json" || argv[i] === "--exit-nonzero-when-not-ready") args[key] = true;
    else if (argv[i].startsWith("--") && valued.has(key) && argv[i + 1] && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
    else throw new Error("unknown argument or missing value");
  }
  return args;
}

function parseArgs(argv) {
  const args = readArgs(argv);
  if (!args.check || !args.workflow || !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) throw new Error("--check and --workflow are required; repo must be owner/name");
  const workflow = resolve(args.workflow);
  if (!workflow.startsWith(`${resolve(".github/workflows")}/`)) throw new Error("workflow must be under .github/workflows");
  for (const key of ["heads", "dry-run-merged"]) {
    if (args[key] !== undefined) {
      if (!/^[1-9]\d*$/.test(String(args[key])) || !Number.isSafeInteger(Number(args[key]))) throw new Error("sample sizes must be positive integers");
      args[key] = Number(args[key]);
    }
  }
  if (args.evaluator && !args["dry-run-merged"]) throw new Error("--evaluator requires --dry-run-merged");
  return { ...args, workflow, job: args.job ?? args.check };
}

// Pages are read one at a time on purpose: whether another page is needed depends
// on the rows already selected, so the reads cannot be issued in parallel.
async function readPullPages(get, repo, state, count, mergedOnly, page = 1, selected = []) {
  const perPage = Math.min(count, 100);
  const rows = await get(`repos/${repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=${perPage}&page=${page}`);
  const next = selected.concat(rows.filter((pr) => !mergedOnly || pr.merged_at != null));
  if (next.length >= count || rows.length < perPage) return next.slice(0, count);
  return readPullPages(get, repo, state, count, mergedOnly, page + 1, next);
}

export async function main({ argv = process.argv.slice(2), runGh = runGhDefault, readFile = readFileSync, out = console.log, err = console.error } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (error) {
    err(error.message);
    return 2;
  }
  let report;
  try {
    let shape;
    try { shape = checkWorkflowShape(await readFile(args.workflow, "utf8"), args.job); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      shape = { ok: false, findings: [{ code: "workflow_missing", detail: "local workflow is missing" }] };
    }
    const get = async (path) => {
      const command = ["api", path];
      assertReadOnlyGhArgs(command);
      const data = await runGh(command);
      return typeof data === "string" ? JSON.parse(data) : data;
    };
    const pulls = (state, count, mergedOnly = false) => readPullPages(get, args.repo, state, count, mergedOnly);
    const heads = (await pulls("all", args.heads)).map((pr) => ({ number: pr.number, sha: pr.head.sha }));
    const checkRunsBySha = Object.fromEntries(await Promise.all(heads.map(async ({ sha }) =>
      [sha, (await get(`repos/${args.repo}/commits/${sha}/check-runs?per_page=100`)).check_runs])));
    const history = reportingHistory({ heads, checkRunsBySha, checkName: args.check });
    let replay;
    if (args["dry-run-merged"]) {
      const evaluate = args.evaluator ? (await import(pathToFileURL(resolve(args.evaluator)).href)).evaluate : undefined;
      if (args.evaluator && typeof evaluate !== "function") throw new Error("invalid evaluator");
      replay = replayMergedPrs({ prs: await pulls("closed", args["dry-run-merged"], true), evaluate });
    }
    report = buildReport({ check: args.check, shape, history, replay });
  } catch {
    // Errors are evidence gaps, never a default CI failure or raw data dump.
    report = { check: args.check, ready: false, reasons: ["readiness_report_error"], mode: "report" };
  }
  out(JSON.stringify(report, null, 2));
  return args["exit-nonzero-when-not-ready"] && !report.ready ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
