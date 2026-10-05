/**
 * Live evaluation of advisory Jev decisions for agent orchestration, using
 * synthetic inputs only (no repository or private content is sent).
 *
 * Run: NODE_USE_ENV_PROXY=1 node scripts/jev-agent-decisions-eval.mjs
 * Writes docs/release/jarvis-loop/jev-agent-decisions-results.json (resolved
 * from this file's location, so the working directory does not matter).
 *
 * Decisions: evidence selection, duplicate detection, worker-role routing.
 * Each is compared with a deterministic lexical baseline. Required items are
 * retained in code before and after Jev. PROTECTED below is an illustrative
 * keyword list used only by this evaluation, not the protected-action boundary:
 * AGENTS.md protected actions are identified by ordinary reasoning against
 * AGENTS.md before and after any Jev call, and Jev never decides one.
 */
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { askJev, gatedChoice, JEV_MODEL } from "./jev-client.mjs";

export const MIN_CONFIDENCE = 0.5;
export const EVIDENCE_KEEP_FLOOR = 0.35;
export const RESULTS_PATH = fileURLToPath(new URL("../docs/release/jarvis-loop/jev-agent-decisions-results.json", import.meta.url));

const tokens = (s) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
export const jaccard = (a, b) => {
  const x = tokens(a), y = tokens(b);
  const inter = [...x].filter((t) => y.has(t)).length;
  return inter / (x.size + y.size - inter || 1);
};

/**
 * Run `fn` over `items` one at a time. Calls are sequential on purpose: each
 * call's latency is measured on its own and the live service is not burst.
 */
export function sequential(items, fn) {
  return items.reduce(async (previous, item) => {
    const out = await previous;
    out.push(await fn(item));
    return out;
  }, Promise.resolve([]));
}

export function createRecorder(ask = askJev) {
  const calls = [];
  async function call(label, state, questions, options) {
    const result = await ask(state, questions, options);
    calls.push({ label, ok: result.ok, reason: result.reason ?? null, model: result.model ?? null, latencyMs: result.latencyMs, usage: result.usage ?? null });
    return result;
  }
  return { calls, call };
}

// 1. Evidence selection from a bounded candidate set. Required items are never sent for filtering.
export const evidenceCases = [
  {
    id: "E1",
    task: "Fix the failing unit test for currency rounding in the quote total calculator.",
    candidates: [
      { id: "agents_contract", text: "Repository agent contract: protected actions and authority rules.", required: true },
      { id: "acceptance", text: "Acceptance criteria: quote totals round half-even to cents.", required: true },
      { id: "rounding_module", text: "Source: money rounding helper used by quote totals." },
      { id: "rounding_test", text: "Test file: quote total rounding cases and currency fixtures." },
      { id: "favicon_script", text: "Script that regenerates favicon images for the marketing site." },
      { id: "db_runbook", text: "Hosted database release runbook for schema migrations." },
    ],
    relevant: ["rounding_module", "rounding_test"],
  },
  {
    id: "E2",
    task: "Make the login page show a clear error when the magic link has expired.",
    candidates: [
      { id: "design_doc", text: "UI design guidance: typography, error states, spacing.", required: true },
      { id: "auth_callback", text: "Source: authentication callback route that verifies magic links." },
      { id: "worker_egress", text: "Worker egress configuration for an external sourcing provider." },
      { id: "cad_runner", text: "Native CAD runner that drives desktop modeling software." },
      { id: "login_e2e", text: "Browser test covering sign-in with email links." },
    ],
    relevant: ["auth_callback", "login_e2e"],
  },
];

/** Keep a candidate unless Jev gave a numeric probability below the floor (fail toward inclusion). */
export const keepEvidence = (p) => typeof p !== "number" || !Number.isFinite(p) || p >= EVIDENCE_KEEP_FLOOR;

export async function selectEvidence(item, call) {
  const required = item.candidates.filter((c) => c.required).map((c) => c.id);
  const optional = item.candidates.filter((c) => !c.required);
  const baseline = optional.filter((c) => jaccard(item.task, c.text) >= 0.1).map((c) => c.id);
  const questions = Object.fromEntries(optional.map((c) => [c.id, {
    type: "noul",
    instructions: { candidate: c.text, question: "Would an engineer doing `task` need to read `candidate` to complete it?" },
  }]));
  const result = await call(`evidence:${item.id}`, { task: item.task }, questions);
  let advisory = null, selected, mode;
  if (result.ok) {
    advisory = Object.fromEntries(optional.map((c) => [c.id, result.answers[c.id]?.noul ?? null]));
    selected = optional.filter((c) => keepEvidence(advisory[c.id])).map((c) => c.id);
    mode = "jev";
  } else {
    selected = baseline;
    mode = `fallback_baseline:${result.reason}`;
  }
  const final = [...required, ...selected];
  const score = (ids) => ({
    missedRelevant: item.relevant.filter((id) => !ids.includes(id)),
    extraIrrelevant: ids.filter((id) => !item.relevant.includes(id) && !required.includes(id)),
  });
  return { id: item.id, mode, required, advisory, final, requiredPreserved: required.every((id) => final.includes(id)), jev: score(final), baseline: score([...required, ...baseline]) };
}

// 2. Duplicate detection against existing tasks.
export const existingTasks = {
  T1: "Add retry with backoff to the supplier price fetcher",
  T2: "Show expired magic link error on login page",
  T3: "Migrate quote line items to integer cents",
  T4: "Rename sidebar project labels",
};
export const duplicateCases = [
  { id: "D1", proposal: "Login: handle expired email sign-in links with a friendly message", expected: "T2" },
  { id: "D2", proposal: "Retry transient failures when fetching vendor prices, with exponential delay", expected: "T1" },
  { id: "D3", proposal: "Add dark mode toggle to account settings", expected: "none" },
  { id: "D4", proposal: "Clean up money handling in quotes", expected: "ambiguous", ambiguous: true },
];
export async function detectDuplicate(item, call) {
  const scored = Object.entries(existingTasks).map(([id, t]) => [id, jaccard(item.proposal, t)]).sort((a, b) => b[1] - a[1]);
  const baseline = scored[0][1] >= 0.3 ? scored[0][0] : "none";
  const criteria = Object.fromEntries(Object.entries(existingTasks).map(([id, t]) => [id, `The proposal is the same work as: "${t}"`]));
  criteria.none = "The proposal is different work from every listed task, or only loosely related.";
  const result = await call(`duplicate:${item.id}`, { proposal: item.proposal }, {
    dup: { type: "choice", instructions: "Is `proposal` a duplicate of one existing task? Pick that task, or none.", criteria },
  });
  const gate = gatedChoice(result, "dup", MIN_CONFIDENCE);
  // Uncertain or failed: do not merge; flag for ordinary reasoning review and keep the work unblocked.
  const final = gate.status === "accepted" ? gate.choice : "needs_review";
  const correct = item.ambiguous ? final === "needs_review" || final === "none" : final === item.expected;
  return { id: item.id, expected: item.expected, baseline, baselineCorrect: item.ambiguous ? baseline === "none" : baseline === item.expected, gate, final, correct, probabilities: result.ok ? result.answers.dup.probabilities ?? null : null };
}

// 3. Routing among predefined worker roles. In this evaluation only, an illustrative keyword list
// (PROTECTED) routes matching synthetic tasks to the owner before any call; it is not the protected-action boundary.
export const roles = {
  implementer: "Writes or changes source code and tests for a bounded change.",
  reviewer: "Reads an existing diff or PR and reports defects; makes no changes.",
  verifier: "Runs deterministic checks, tests, and acceptance evidence for a given revision.",
  docs_writer: "Updates documentation only.",
};
export const PROTECTED = /\b(deploy|production|purchase|order|email|credential|delete|publish)\b/i;
export const routingCases = [
  { id: "R1", task: "Review PR 512 for concurrency bugs before merge", expected: "reviewer" },
  { id: "R2", task: "Add a unit test and fix the off-by-one in pagination", expected: "implementer" },
  { id: "R3", task: "Run the integration gate on commit abc123 and record results", expected: "verifier" },
  { id: "R4", task: "Update the README setup section for the new env var", expected: "docs_writer" },
  { id: "R5", task: "Deploy the worker to production", expected: "human_owner" },
  { id: "R6", task: "Look into the quote thing", expected: "ambiguous", ambiguous: true },
];
export function baselineRoute(task) {
  if (/\breview\b/i.test(task)) return "reviewer";
  if (/\b(run|verify|gate)\b/i.test(task)) return "verifier";
  if (/\b(readme|docs?)\b/i.test(task)) return "docs_writer";
  if (/\b(fix|add|implement)\b/i.test(task)) return "implementer";
  return "unrouted";
}
export async function route(item, call) {
  if (PROTECTED.test(item.task)) {
    return { id: item.id, expected: item.expected, baseline: "human_owner", final: "human_owner", mode: "deterministic_protected_gate", correct: item.expected === "human_owner", baselineCorrect: true };
  }
  const base = baselineRoute(item.task);
  const result = await call(`route:${item.id}`, { task: item.task }, {
    role: { type: "choice", instructions: "Which worker role should own `task`?", criteria: roles },
  });
  const gate = gatedChoice(result, "role", MIN_CONFIDENCE);
  const final = gate.status === "accepted" ? gate.choice : "ordinary_reasoning";
  const correct = item.ambiguous ? final === "ordinary_reasoning" : final === item.expected;
  return { id: item.id, expected: item.expected, baseline: base, baselineCorrect: item.ambiguous ? base === "unrouted" : base === item.expected, gate, final, mode: "jev", correct, probabilities: result.ok ? result.answers.role.probabilities ?? null : null };
}

/**
 * Local stub service for the response-shape probes the live service cannot be
 * made to produce: a non-JSON 200 body and a 200 body naming another model.
 * It binds to 127.0.0.1 only (bypassed by the agent proxy) and sends nothing out.
 */
export async function startStub() {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/malformed") return res.end("not json");
      if (req.url === "/wrong-model") return res.end(JSON.stringify({ model: "jev-9.9.9-stub", answers: { role: { type: "choice", choice: "implementer", confidence: 0.9 } } }));
      if (req.url === "/missing-confidence") return res.end(JSON.stringify({ model: JEV_MODEL, answers: { role: { type: "choice", choice: "implementer" } } }));
      res.statusCode = 404;
      return res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

// 4. Service failures: each must fall back without throwing.
export async function failures(call, stubBase) {
  const q = { role: { type: "choice", instructions: "Which worker role should own `task`?", criteria: roles } };
  const state = { task: "Add a unit test" };
  const probes = [
    // Live probes: a real refused connection, a client timeout, and two server-side HTTP errors.
    { name: "unreachable_host", source: "live", run: () => call("fail:unreachable", state, q, { endpoint: "https://127.0.0.1:65530/v1/systemone", timeoutMs: 3000 }) },
    { name: "timeout", source: "live", run: () => call("fail:timeout", state, q, { timeoutMs: 1 }) },
    { name: "validation_422", source: "live", run: () => call("fail:422", state, { role: { type: "choice", instructions: "x" } }) },
    { name: "unknown_model_request_400", source: "live", run: () => call("fail:model", state, q, { model: "jev-0.0.0-nonexistent" }) },
    // Local stub probes: response shapes the live service does not return on demand.
    { name: "malformed_body", source: "local_stub", run: () => call("fail:malformed", state, q, { endpoint: `${stubBase}/malformed` }) },
    { name: "unexpected_model", source: "local_stub", run: () => call("fail:wrong_model", state, q, { endpoint: `${stubBase}/wrong-model` }) },
    { name: "missing_confidence", source: "local_stub", run: () => call("fail:missing_confidence", state, q, { endpoint: `${stubBase}/missing-confidence` }) },
  ];
  return sequential(probes, async ({ name, source, run }) => {
    const result = await run();
    const gate = gatedChoice(result, "role");
    return { name, source, reason: result.reason ?? null, gate: gate.status, fallback: gate.status === "failed" ? baselineRoute(state.task) : null };
  });
}

export function summarize({ calls, evidence, duplicates, routing, failureResults, wallMs }) {
  const live = calls.filter((c) => c.ok);
  const inputTokens = live.reduce((n, c) => n + (c.usage?.input_tokens ?? 0), 0);
  const latencies = live.map((c) => c.latencyMs).sort((a, b) => a - b);
  return {
    generatedAt: new Date().toISOString(),
    requestedModel: JEV_MODEL,
    returnedModels: [...new Set(live.map((c) => c.model))],
    inputs: "synthetic only",
    liveCalls: live.length,
    failedCalls: calls.length - live.length,
    inputTokens,
    outputTokens: live.reduce((n, c) => n + (c.usage?.output_tokens ?? 0), 0),
    estimatedCostUsd: +(inputTokens * 0.042e-6).toFixed(8),
    latencyMs: { median: latencies[Math.floor(latencies.length / 2)] ?? null, max: Math.max(0, ...latencies) },
    wallMs,
    correctness: {
      evidence: { jevMissed: evidence.flatMap((e) => e.jev.missedRelevant), jevExtra: evidence.flatMap((e) => e.jev.extraIrrelevant), baselineMissed: evidence.flatMap((e) => e.baseline.missedRelevant), baselineExtra: evidence.flatMap((e) => e.baseline.extraIrrelevant), requiredPreserved: evidence.every((e) => e.requiredPreserved) },
      duplicates: { jev: `${duplicates.filter((d) => d.correct).length}/${duplicates.length}`, baseline: `${duplicates.filter((d) => d.baselineCorrect).length}/${duplicates.length}` },
      routing: { jev: `${routing.filter((r) => r.correct).length}/${routing.length}`, baseline: `${routing.filter((r) => r.baselineCorrect).length}/${routing.length}` },
      failuresFellBack: failureResults.every((f) => f.gate === "failed" && f.fallback),
    },
  };
}

export async function runEvaluation({ ask = askJev } = {}) {
  const { calls, call } = createRecorder(ask);
  const started = performance.now();
  const evidence = await sequential(evidenceCases, (c) => selectEvidence(c, call));
  const duplicates = await sequential(duplicateCases, (c) => detectDuplicate(c, call));
  const routing = await sequential(routingCases, (c) => route(c, call));
  const stub = await startStub();
  let failureResults;
  try {
    failureResults = await failures(call, stub.base);
  } finally {
    await stub.close();
  }
  const summary = summarize({ calls, evidence, duplicates, routing, failureResults, wallMs: Math.round(performance.now() - started) });
  return { summary, evidence, duplicates, routing, failures: failureResults, calls };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runEvaluation();
  writeFileSync(RESULTS_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}
