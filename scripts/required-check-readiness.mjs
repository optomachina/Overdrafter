#!/usr/bin/env node
// OVD-921: evidence for an operator, never a protection or merge gate.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function onBlock(text) {
  return text.match(/^(?:on|"on"|'on'):\s*([^\n]*)\n((?:[ \t]+.*\n|\n|[ \t]+.*$)*)/m)?.slice(1).join("\n") ?? "";
}

function jobBlock(text, jobId) {
  const lines = text.split("\n");
  const jobs = lines.findIndex((line) => line === "jobs:");
  if (jobs === -1) return "";
  const start = lines.findIndex((line, index) => index > jobs && line === `  ${jobId}:`);
  if (start === -1) return "";
  let end = start + 1;
  while (end < lines.length && !/^\S|^ {2}\S/.test(lines[end])) end += 1;
  return lines.slice(start + 1, end).join("\n");
}

export function checkWorkflowShape(workflowText, jobId) {
  const text = workflowText.replace(/\r\n/g, "\n");
  const triggers = onBlock(text);
  const findings = [];
  const add = (code, detail) => findings.push({ code, detail });
  if (!/(?:^\s*merge_group\s*:|[\[,]\s*merge_group\s*[,\]]|^merge_group\s*$)/m.test(triggers)) {
    add("no_merge_group", "on: must include merge_group");
  }
  if (/^\s+paths(?:-ignore)?\s*:/m.test(triggers)) add("paths_filter", "trigger has a paths filter");
  const job = jobBlock(text, jobId);
  if (!job) add("job_missing", `job ${jobId} is missing`);
  else {
    if (/^ {4}if\s*:/m.test(job)) add("job_level_if", "job-level if can skip reporting");
    if (job.match(/^ {4}name:\s*(.*?)\s*$/m)?.[1] !== jobId) {
      add("job_name_mismatch", `job name must be exactly ${jobId}`);
    }
  }
  if (/\b(?:pull_request_target|workflow_run)\s*(?=:|[,\]])/.test(triggers)) {
    // Inspect each step separately so an unrelated ref cannot taint a checkout.
    const steps = text.split(/^ {6}- /m).slice(1);
    if (steps.some((step) => /(?:^|\n\s*)uses:\s*actions\/checkout@/.test(step)
      && /^\s+ref:.*(?:head\.sha|head\.ref|head_sha|github\.event\.pull_request\.head)/m.test(step))) {
      add("untrusted_checkout", "privileged trigger checks out a PR head");
    }
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

function runGhDefault(args) {
  assertReadOnlyGhArgs(args);
  const result = spawnSync("gh", args, { encoding: "utf8" });
  // Never forward stderr: an external command may include sensitive diagnostics.
  if (result.error || result.status !== 0) throw new Error("GitHub read failed");
  return JSON.parse(result.stdout);
}

function parseArgs(argv) {
  const args = { repo: "optomachina/Overdrafter", heads: 20 };
  const valued = new Set(["check", "workflow", "job", "heads", "dry-run-merged", "evaluator", "repo"]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    if (argv[i] === "--json" || argv[i] === "--exit-nonzero-when-not-ready") args[key] = true;
    else if (argv[i].startsWith("--") && valued.has(key) && argv[i + 1] && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
    else throw new Error("unknown argument or missing value");
  }
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
    // Page explicitly: requested samples must not silently truncate at 100.
    const pulls = async (state, count, mergedOnly = false) => {
      const selected = [];
      for (let page = 1; selected.length < count; page += 1) {
        const rows = await get(`repos/${args.repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=${Math.min(count, 100)}&page=${page}`);
        selected.push(...rows.filter((pr) => !mergedOnly || pr.merged_at != null));
        if (rows.length < Math.min(count, 100)) break;
      }
      return selected.slice(0, count);
    };
    const heads = (await pulls("all", args.heads)).map((pr) => ({ number: pr.number, sha: pr.head.sha }));
    const checkRunsBySha = {};
    for (const { sha } of heads) {
      checkRunsBySha[sha] = (await get(`repos/${args.repo}/commits/${sha}/check-runs?per_page=100`)).check_runs;
    }
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
