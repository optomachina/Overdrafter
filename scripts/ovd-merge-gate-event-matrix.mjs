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
 *
 * Fail closed: a workflow whose `on:` this parser cannot read (no top-level
 * `on:`, inline list or scalar, tabs, an indent other than two spaces, no event
 * keys, a merge_group value it cannot read) is an error, never a workflow with no
 * triggers. A leading UTF-8 BOM and CRLF line endings are normalised first.
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
const ON_KEY = /^["']?on["']?[ \t]*:/;
const EVENT_KEY = /^ {2}["']?([A-Za-z0-9_-]+)["']?[ \t]*:/gm;
const MERGE_GROUP_KEY = /^ {2}["']?merge_group["']?[ \t]*:(.*)$/m;
const NEXT_EVENT_KEY = /\n {2}["']?[A-Za-z0-9_-]+["']?[ \t]*:/;
const PATHS_KEY = /^ {4}["']?paths(?:-ignore)?["']?[ \t]*:/m;
const INLINE_PATHS_KEY = /(?:^|[{,\s])["']?paths(?:-ignore)?["']?\s*:/;

/** Code-unit order, the order Array#sort uses without a compare function. */
export function byCodeUnit(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Workflow text with a leading UTF-8 BOM removed and CRLF read as LF. */
export function normalizeWorkflowText(text) {
  return text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
}

/** A YAML value with a trailing `# comment` and surrounding whitespace removed. */
function withoutComment(value) {
  return value.replace(/(?:^|\s)#.*$/, "").trim();
}

function unquote(value) {
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

function listItems(value) {
  return value.split(",").map((item) => unquote(item.trim())).filter(Boolean);
}

/**
 * The top-level `on:` of a workflow. `form` is "block" (the only form the
 * matrix can check), "inline" (`on: push`, `on: [push]`), or "absent".
 */
export function parseWorkflowOn(text) {
  const lines = normalizeWorkflowText(text).split("\n");
  const start = lines.findIndex((line) => ON_KEY.test(line));
  if (start < 0) return { form: "absent", block: null };
  const rest = withoutComment(lines[start].replace(ON_KEY, ""));
  if (rest !== "") return { form: "inline", block: null };
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith("#")) break;
    body.push(line);
  }
  return { form: "block", block: `${body.join("\n")}\n` };
}

/** The `on:` block body, or null when the workflow has no block-form `on:`. */
export function workflowOnBlock(text) {
  return parseWorkflowOn(text).block;
}

export function workflowEventKeys(block) {
  return [...block.matchAll(EVENT_KEY)].map((match) => match[1]);
}

/** Why the matrix cannot read this `on:` block, or null when it can. */
function onBlockShapeError(block) {
  const keyed = block.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  if (keyed.some((line) => line.startsWith("\t") || /^ *\t/.test(line))) return "indents on: with a tab";
  const first = keyed[0];
  if (!first) return "has an empty on: block";
  if (!/^ {2}\S/.test(first)) return "indents on: events by something other than two spaces";
  if (workflowEventKeys(block).length === 0) return "has an on: block with no event keys";
  return null;
}

/**
 * The merge_group entry of an `on:` block: `value` is what follows the key on
 * its own line (comment removed; "" for the block form), `section` the key's
 * line and its nested lines. null when the block has no merge_group key.
 */
function mergeGroupSection(block) {
  const match = MERGE_GROUP_KEY.exec(block);
  if (!match) return null;
  const rest = block.slice(match.index);
  // Keep the newline that ends the section's last line: the nested types list
  // reads every item up to its newline.
  const next = rest.slice(1).search(NEXT_EVENT_KEY);
  const section = next === -1 ? rest : rest.slice(0, next + 2);
  return { value: withoutComment(match[1]), section };
}

function isEmptyValue(value) {
  return value === "" || value === "null" || value === "~";
}

/** Types from an inline map value: `{ types: [checks_requested] }`. */
function inlineMapTypes(value) {
  const map = value.match(/^\{(.*)\}$/);
  if (!map) return "unreadable";
  if (map[1].trim() === "") return null;
  const types = map[1].match(/(?:^|[{,\s])["']?types["']?\s*:\s*\[([^\]]*)\]/);
  if (types) return listItems(types[1]);
  return /(?:^|[{,\s])["']?types["']?\s*:/.test(map[1]) ? "unreadable" : null;
}

/**
 * merge_group activity types, null when the key exists with no types, "absent"
 * when there is no merge_group key, or "unreadable" when its value is in a form
 * this module does not read (parseWorkflow reports that as a parse error).
 */
export function mergeGroupTypes(block) {
  const entry = mergeGroupSection(block);
  if (entry === null) return "absent";
  const { value, section } = entry;
  if (!isEmptyValue(value)) return inlineMapTypes(value);
  const types = section.match(/^ {4}["']?types["']?[ \t]*:(.*)\n/m);
  if (!types) return null;
  const inline = withoutComment(types[1]);
  if (inline !== "") {
    const list = inline.match(/^\[([^\]]*)\]$/);
    return list ? listItems(list[1]) : "unreadable";
  }
  const nested = section.slice(types.index + types[0].length).match(/^(?: {6}- .+\n)+/);
  if (!nested) return null;
  return [...nested[0].matchAll(/^ {6}- (.+)\n/gm)].map((item) => unquote(withoutComment(item[1])));
}

/** True when merge_group carries a paths or paths-ignore filter, in either form. */
function mergeGroupFiltersPaths(block) {
  const entry = mergeGroupSection(block);
  if (entry === null) return false;
  return PATHS_KEY.test(entry.section) || INLINE_PATHS_KEY.test(entry.value);
}

/**
 * One workflow as diffEventMatrix reads it. `parseError` is set when the
 * workflow has an `on:` this module cannot read; its triggers are then unknown.
 */
export function parseWorkflow(file, text) {
  const { form, block } = parseWorkflowOn(text);
  let parseError = null;
  if (form === "absent") parseError = "has no top-level on: key";
  else if (form === "inline") parseError = "writes on: inline (on: push or on: [push])";
  else parseError = onBlockShapeError(block);
  let types = block && !parseError ? mergeGroupTypes(block) : "absent";
  if (types === "unreadable") {
    parseError = "writes merge_group: or its types: in a form the event matrix cannot read";
    types = "absent";
  }
  return {
    file,
    events: block && !parseError ? workflowEventKeys(block) : [],
    mergeGroupTypes: types,
    text,
    parseError,
  };
}

function concurrencyBlock(text) {
  return normalizeWorkflowText(text).match(/^concurrency:\n((?: {2}.*\n)+)/m)?.[1] ?? "";
}

function sameSet(left, right) {
  const a = [...left].sort(byCodeUnit);
  const b = [...right].sort(byCodeUnit);
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

function mergeGroupErrors(row, actual) {
  if (!actual.events.includes("merge_group")) return [];
  const errors = [];
  const expected = row.mergeGroupTypes === undefined ? "missing" : row.mergeGroupTypes;
  const got = actual.mergeGroupTypes;
  if (JSON.stringify(expected) !== JSON.stringify(got)) {
    errors.push(`${row.file} merge_group types are ${JSON.stringify(got)}; the event matrix says ${JSON.stringify(expected)}`);
  }
  if (mergeGroupFiltersPaths(workflowOnBlock(actual.text) ?? "")) {
    errors.push(`${row.file} filters merge_group with paths; a queue run would not see every required check`);
  }
  return errors;
}

function requiredRowErrors(row, actual) {
  if (!row.required) return [];
  const errors = [];
  if (JSON.stringify(row.mergeGroupTypes) !== JSON.stringify(["checks_requested"])) {
    errors.push(`${row.file} is a required check and must declare merge_group types ["checks_requested"]`);
  }
  if (!concurrencyBlock(actual.text).includes("github.event.pull_request.head.sha")) {
    errors.push(`${row.file} is a required check and must key concurrency on github.event.pull_request.head.sha`);
  }
  return errors;
}

function pushErrors(row, actual) {
  if (!actual.events.includes("push")) return [];
  const errors = [];
  if (actual.text.includes("--all") && row.push !== "report-only") {
    errors.push(`${row.file} runs --all and pushes to main; set push to report-only so open-PR overlaps do not fail main`);
  }
  if (row.push === "report-only") {
    if (!actual.text.includes("--report-only") || !actual.text.includes("github.event_name == 'push'")) {
      errors.push(`${row.file} is push report-only but the push step does not run --report-only`);
    }
  } else if (row.push !== "commit") {
    errors.push(`${row.file} push must be "commit" (the pushed tree) or "report-only" (other open PRs)`);
  }
  return errors;
}

function rowErrors(row, actual, { commentFilter, doc }) {
  const errors = [];
  if (!sameSet(actual.events, row.events)) {
    errors.push(`${row.file} triggers ${actual.events.join(", ")}; the event matrix lists ${row.events.join(", ")}`);
  }
  errors.push(...mergeGroupErrors(row, actual), ...requiredRowErrors(row, actual));
  if (actual.events.includes("issue_comment") && !actual.text.includes(commentFilter)) {
    errors.push(`${row.file} triggers issue_comment without commentFilterExpression(); every comment would start a gate run`);
  }
  errors.push(...pushErrors(row, actual));
  if (typeof doc === "string" && !doc.includes(row.file)) {
    errors.push(`${GATE_EVENT_MATRIX_DOC} does not mention ${row.file}; update the matrix doc in the same PR`);
  }
  return errors;
}

function requiredListErrors(rows, requiredWorkflows) {
  if (!Array.isArray(requiredWorkflows)) return [];
  const fromMatrix = rows.filter((row) => row.required).map((row) => row.file).sort(byCodeUnit);
  const fromTest = [...requiredWorkflows].sort(byCodeUnit);
  if (JSON.stringify(fromMatrix) === JSON.stringify(fromTest)) return [];
  return [`required checks in the event matrix (${fromMatrix.join(", ") || "none"}) differ from REQUIRED_CHECKS in ${MERGE_QUEUE_WORKFLOW_TEST} (${fromTest.join(", ") || "none"})`];
}

/**
 * Compare parsed workflow triggers to the matrix. `files` is
 * {file, events, mergeGroupTypes, text, parseError?}[]; `matrix` is the fixture object.
 */
export function diffEventMatrix({ files, matrix, requiredWorkflows, commentFilter, doc }) {
  if (matrix?.version !== 1 || !Array.isArray(matrix.workflows)) {
    return [`${GATE_EVENT_MATRIX_FILE} must be {version: 1, workflows: [...]}`];
  }
  const errors = [];
  for (const file of files) {
    if (file.parseError) {
      errors.push(`${file.file} ${file.parseError}; write on: as a block with two-space event keys so the event matrix can read its triggers`);
    }
  }
  const rows = matrix.workflows;
  const listed = new Set(rows.map((row) => row?.file));
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
    if (actual) errors.push(...rowErrors(row, actual, { commentFilter, doc }));
  }
  errors.push(...requiredListErrors(rows, requiredWorkflows));
  return errors;
}

function loadWorkflows(repoRoot) {
  const dir = path.join(repoRoot, ".github/workflows");
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort(byCodeUnit)
    .map((name) => parseWorkflow(`.github/workflows/${name}`, fs.readFileSync(path.join(dir, name), "utf8")));
}

function docErrors(doc) {
  if (!doc) return [];
  const errors = [];
  if (!/merge_group/.test(doc)) errors.push(`${GATE_EVENT_MATRIX_DOC} does not describe merge_group`);
  if (!/issue_comment/.test(doc)) errors.push(`${GATE_EVENT_MATRIX_DOC} does not describe issue_comment`);
  if (!/rate limit/i.test(doc)) errors.push(`${GATE_EVENT_MATRIX_DOC} does not describe rate limits`);
  if (!/push/.test(doc)) errors.push(`${GATE_EVENT_MATRIX_DOC} does not describe push`);
  return errors;
}

export function gateEventMatrixErrors(repoRoot) {
  if (!fs.existsSync(path.join(repoRoot, ".github/workflows"))) return [];
  const matrixPath = path.join(repoRoot, GATE_EVENT_MATRIX_FILE);
  const docPath = path.join(repoRoot, GATE_EVENT_MATRIX_DOC);
  if (!fs.existsSync(matrixPath)) return [`${GATE_EVENT_MATRIX_FILE} is missing`];
  const errors = [];
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
  errors.push(...docErrors(doc), ...diffEventMatrix({
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
