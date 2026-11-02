/**
 * Gate workflow event matrix (weekly retro, 2026-11-02).
 *
 * The week's merge-gate repairs failed on paths the PR-event tests did not
 * run: merge_group (#1005), issue_comment bursts and 403/429 rate limits
 * (#972, #1007, #1009), and push to main (#1013). This module fails the agent
 * contract when a workflow's triggers drift from
 * scripts/fixtures/sensitive-paths/gate-event-matrix.json, or when a required
 * check, an issue_comment trigger, or a push that scans open PRs drops the
 * safeguard that fixed that path.
 */
import fs from "node:fs";
import path from "node:path";

import { commentFilterExpression, createApi, isTriggerComment } from "./ovd-merge-gate.mjs";

export const GATE_EVENT_MATRIX_FILE = "scripts/fixtures/sensitive-paths/gate-event-matrix.json";
export const GATE_RATE_LIMIT_FIXTURE = "scripts/fixtures/sensitive-paths/gate-rate-limit.json";
export const GATE_ISSUE_COMMENT_FIXTURE = "scripts/fixtures/sensitive-paths/gate-issue-comments.json";
export const GATE_EVENT_MATRIX_DOC = "docs/ci/gate-event-matrix.md";
export const MERGE_QUEUE_WORKFLOW_TEST = "scripts/merge-queue-workflows.test.mjs";

const SCOPED_EVENTS = new Set(["merge_group", "issue_comment", "pull_request_target", "push"]);

export function workflowOnBlock(text) {
  const match = text.match(/^on:\n((?: {2}.*\n|\n)+)/m);
  return match ? match[1] : null;
}

export function workflowEventKeys(block) {
  return [...block.matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)].map((match) => match[1]);
}

/** merge_group activity types, null when the key exists with no types, or "absent". */
export function mergeGroupTypes(block) {
  const start = block.search(/^ {2}merge_group:\n/m);
  if (start < 0) return "absent";
  const rest = block.slice(start);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:/);
  const section = next === -1 ? rest : rest.slice(0, next + 1);
  const inline = section.match(/^ {4}types:\s*\[([^\]]+)\]/m);
  if (inline) return inline[1].split(",").map((item) => item.trim()).filter(Boolean);
  const nested = section.match(/^ {4}types:\n((?: {6}- .+\n)+)/m);
  if (!nested) return null;
  return [...nested[1].matchAll(/^ {6}- (.+)\n/gm)].map((match) => match[1].trim());
}

function mergeGroupSection(block) {
  const start = block.search(/^ {2}merge_group:\n/m);
  if (start < 0) return "";
  const rest = block.slice(start);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function concurrencyBlock(text) {
  return text.match(/^concurrency:\n((?: {2}.*\n)+)/m)?.[1] ?? "";
}

function sameSet(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function readJson(repoRoot, file) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8"));
}

/** Workflow names in REQUIRED_CHECKS (not the future-required list). */
export function requiredCheckWorkflows(testSource) {
  const start = testSource.indexOf("const REQUIRED_CHECKS");
  const end = testSource.indexOf("const FUTURE_REQUIRED_CHECKS");
  if (start < 0 || end < start) return [];
  return [...testSource.slice(start, end).matchAll(/workflow:\s*"([^"]+)"/g)].map((match) => `.github/workflows/${match[1]}`);
}

/**
 * Compare parsed workflow triggers to the matrix. `files` is
 * {file, events, mergeGroupTypes, text}[]; `matrix` is the fixture object.
 */
export function diffEventMatrix({ files, matrix, requiredWorkflows, commentFilter, doc }) {
  const errors = [];
  if (!matrix || matrix.version !== 1 || !Array.isArray(matrix.workflows)) {
    return [`${GATE_EVENT_MATRIX_FILE} must be {version: 1, workflows: [...]}`];
  }
  const rows = matrix.workflows;
  const listed = new Set(rows.map((row) => row.file));
  const scoped = files.filter((file) => file.events.some((event) => SCOPED_EVENTS.has(event)));
  for (const file of scoped) {
    if (!listed.has(file.file)) {
      errors.push(`${file.file} triggers ${file.events.join(", ")} but is missing from ${GATE_EVENT_MATRIX_FILE} and ${GATE_EVENT_MATRIX_DOC}`);
    }
  }
  const scopedNames = new Set(scoped.map((file) => file.file));
  for (const row of rows) {
    if (!row?.file || !Array.isArray(row.events)) {
      errors.push(`${GATE_EVENT_MATRIX_FILE} has a workflow row without file and events`);
      continue;
    }
    if (!scopedNames.has(row.file)) {
      errors.push(`${row.file} is in the event matrix but does not trigger merge_group, issue_comment, pull_request_target, or push`);
    }
    const actual = files.find((file) => file.file === row.file);
    if (!actual) continue;
    if (!sameSet(actual.events, row.events)) {
      errors.push(`${row.file} triggers ${actual.events.join(", ")}; the event matrix lists ${row.events.join(", ")}`);
    }
    if (actual.events.includes("merge_group")) {
      const expected = row.mergeGroupTypes === undefined ? "missing" : row.mergeGroupTypes;
      const got = actual.mergeGroupTypes;
      if (JSON.stringify(expected) !== JSON.stringify(got)) {
        errors.push(`${row.file} merge_group types are ${JSON.stringify(got)}; the event matrix says ${JSON.stringify(expected)}`);
      }
      const onBlock = workflowOnBlock(actual.text) ?? "";
      if (/^ {4}paths(?:-ignore)?:/m.test(mergeGroupSection(onBlock))) {
        errors.push(`${row.file} filters merge_group with paths; a queue run would not see every required check`);
      }
    }
    if (row.required) {
      if (JSON.stringify(row.mergeGroupTypes) !== JSON.stringify(["checks_requested"])) {
        errors.push(`${row.file} is a required check and must declare merge_group types ["checks_requested"]`);
      }
      if (!concurrencyBlock(actual.text).includes("github.event.pull_request.head.sha")) {
        errors.push(`${row.file} is a required check and must key concurrency on github.event.pull_request.head.sha`);
      }
    }
    if (actual.events.includes("issue_comment") && !actual.text.includes(commentFilter)) {
      errors.push(`${row.file} triggers issue_comment without commentFilterExpression(); every comment would start a gate run`);
    }
    if (actual.events.includes("push")) {
      const scansOpenPrs = actual.text.includes("--all");
      if (scansOpenPrs && row.push !== "report-only") {
        errors.push(`${row.file} runs --all and pushes to main; set push to report-only so open-PR overlaps do not fail main`);
      }
      if (row.push === "report-only") {
        if (!actual.text.includes("--report-only") || !actual.text.includes("github.event_name == 'push'")) {
          errors.push(`${row.file} is push report-only but the push step does not run --report-only`);
        }
      } else if (row.push !== "commit") {
        errors.push(`${row.file} push must be "commit" (the pushed tree) or "report-only" (other open PRs)`);
      }
    }
    if (typeof doc === "string" && !doc.includes(row.file)) {
      errors.push(`${GATE_EVENT_MATRIX_DOC} does not mention ${row.file}; update the matrix doc in the same PR`);
    }
  }
  if (Array.isArray(requiredWorkflows)) {
    const fromMatrix = rows.filter((row) => row.required).map((row) => row.file).sort();
    const fromTest = [...requiredWorkflows].sort();
    if (JSON.stringify(fromMatrix) !== JSON.stringify(fromTest)) {
      errors.push(`required checks in the event matrix (${fromMatrix.join(", ") || "none"}) differ from REQUIRED_CHECKS in ${MERGE_QUEUE_WORKFLOW_TEST} (${fromTest.join(", ") || "none"})`);
    }
  }
  return errors;
}

function loadWorkflows(repoRoot) {
  const dir = path.join(repoRoot, ".github/workflows");
  return fs.readdirSync(dir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).sort().map((name) => {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    const block = workflowOnBlock(text);
    return {
      file: `.github/workflows/${name}`,
      events: block ? workflowEventKeys(block) : [],
      mergeGroupTypes: block ? mergeGroupTypes(block) : "absent",
      text,
    };
  });
}

export function gateEventMatrixErrors(repoRoot) {
  const workflows = path.join(repoRoot, ".github/workflows");
  if (!fs.existsSync(workflows)) return [];
  const errors = [];
  const matrixPath = path.join(repoRoot, GATE_EVENT_MATRIX_FILE);
  const docPath = path.join(repoRoot, GATE_EVENT_MATRIX_DOC);
  if (!fs.existsSync(matrixPath)) return [`${GATE_EVENT_MATRIX_FILE} is missing`];
  if (!fs.existsSync(docPath)) errors.push(`${GATE_EVENT_MATRIX_DOC} is missing`);
  for (const fixture of [GATE_RATE_LIMIT_FIXTURE, GATE_ISSUE_COMMENT_FIXTURE]) {
    if (!fs.existsSync(path.join(repoRoot, fixture))) errors.push(`${fixture} is missing`);
  }
  let matrix;
  try {
    matrix = readJson(repoRoot, GATE_EVENT_MATRIX_FILE);
  } catch (error) {
    return [...errors, `${GATE_EVENT_MATRIX_FILE} is not valid JSON: ${error.message}`];
  }
  const testPath = path.join(repoRoot, MERGE_QUEUE_WORKFLOW_TEST);
  const requiredWorkflows = fs.existsSync(testPath) ? requiredCheckWorkflows(fs.readFileSync(testPath, "utf8")) : [];
  const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
  if (doc && !/merge_group/.test(doc)) errors.push(`${GATE_EVENT_MATRIX_DOC} does not describe merge_group`);
  if (doc && !/issue_comment/.test(doc)) errors.push(`${GATE_EVENT_MATRIX_DOC} does not describe issue_comment`);
  if (doc && !/rate limit/i.test(doc)) errors.push(`${GATE_EVENT_MATRIX_DOC} does not describe rate limits`);
  if (doc && !/push/.test(doc)) errors.push(`${GATE_EVENT_MATRIX_DOC} does not describe push`);
  errors.push(...diffEventMatrix({
    files: loadWorkflows(repoRoot),
    matrix,
    requiredWorkflows,
    commentFilter: commentFilterExpression(),
    doc,
  }));
  return errors;
}

function responseOf(spec) {
  const headers = spec.headers ?? {};
  const body = spec.body ?? {};
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Run the rate-limit and issue_comment fixtures. Returns error strings. */
export async function exerciseGateFixtures(repoRoot) {
  const errors = [];
  const rate = readJson(repoRoot, GATE_RATE_LIMIT_FIXTURE);
  const comments = readJson(repoRoot, GATE_ISSUE_COMMENT_FIXTURE);
  if (!Array.isArray(rate.cases) || rate.cases.length < 2) errors.push(`${GATE_RATE_LIMIT_FIXTURE} needs at least two cases`);
  if (!Array.isArray(comments.cases) || comments.cases.length < 2) errors.push(`${GATE_ISSUE_COMMENT_FIXTURE} needs at least two cases`);
  for (const item of rate.cases ?? []) {
    const queue = item.responses.map(responseOf);
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      const next = queue.shift();
      if (!next) throw new Error("no fixture response left");
      return next;
    };
    const api = createApi({ token: "fixture", fetchImpl, sleep: async () => {}, log: () => {} });
    try {
      await api.json("/repos/o/r/pulls/1");
      if (!item.ok) errors.push(`${item.name}: expected the call to fail`);
    } catch (error) {
      if (item.ok) errors.push(`${item.name}: ${error.message}`);
    }
    if (calls !== item.calls) errors.push(`${item.name}: GitHub was called ${calls} time(s), fixture expects ${item.calls}`);
  }
  for (const item of comments.cases ?? []) {
    const triggers = isTriggerComment({ body: item.body, previousBody: item.previousBody });
    if (triggers !== item.triggers) {
      errors.push(`${item.name}: isTriggerComment returned ${triggers}, fixture expects ${item.triggers}`);
    }
  }
  return errors;
}
