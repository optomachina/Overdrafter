// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { askJev, JEV_MODEL } from "./jev-client.mjs";
import {
  baselineRoute,
  boundProbabilities,
  boundUsage,
  createRecorder,
  detectDuplicate,
  keepEvidence,
  RESULTS_PATH,
  route,
  runEvaluation,
  scoreChoices,
  selectEvidence,
  sequential,
  startStub,
} from "./jev-agent-decisions-eval.mjs";

/**
 * Synthetic stand-in for the live service. Calls with no options answer
 * deterministically; probes that target the local stub use the real client
 * over a real loopback socket; every other probe returns a failure, so the
 * test sends nothing outside the machine.
 */
function fakeAsk() {
  return vi.fn(async (state, questions, options) => {
    if (options?.endpoint?.startsWith("http://127.0.0.1:")) return askJev(state, questions, options);
    if (options) return { ok: false, reason: "synthetic_failure", latencyMs: 0 };
    // Mirror the live service's request validation: a choice without criteria is a 422.
    if (Object.values(questions).some((q) => q.type === "choice" && !q.criteria)) return { ok: false, reason: "http_422", latencyMs: 0 };
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      answers[id] = q.type === "noul"
        ? { type: "noul", noul: 0.9 }
        : { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.4, probabilities: {} };
    }
    return { ok: true, model: JEV_MODEL, answers, usage: { input_tokens: 5, output_tokens: 1 }, latencyMs: 3 };
  });
}

describe("baselineRoute", () => {
  it.each([
    ["Review the diff", "reviewer"],
    ["Run the gate", "verifier"],
    ["Update the README", "docs_writer"],
    ["Fix the bug", "implementer"],
    ["Look into it", "unrouted"],
  ])("routes %s to %s", (task, expected) => {
    expect(baselineRoute(task)).toBe(expected);
  });
});

describe("keepEvidence", () => {
  it("keeps items at or above the floor and items without a numeric probability", () => {
    expect(keepEvidence(0.35)).toBe(true);
    expect(keepEvidence(undefined)).toBe(true);
    expect(keepEvidence(Number.NaN)).toBe(true);
    expect(keepEvidence(0.34)).toBe(false);
  });
});

describe("sequential", () => {
  it("runs one item at a time in order", async () => {
    const order = [];
    const out = await sequential([1, 2, 3], async (n) => {
      order.push(`start${n}`);
      await Promise.resolve();
      order.push(`end${n}`);
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6]);
    expect(order).toEqual(["start1", "end1", "start2", "end2", "start3", "end3"]);
  });
});

describe("deterministic guards", () => {
  it("routes the synthetic keyword-matched case to human_owner without calling Jev", async () => {
    const ask = fakeAsk();
    const { call, calls } = createRecorder(ask);
    const result = await route({ id: "P", task: "Deploy the worker to production", expected: "human_owner" }, call);
    expect(result.final).toBe("human_owner");
    expect(ask).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("never sends required evidence items to Jev and always keeps them", async () => {
    const ask = fakeAsk();
    const { call } = createRecorder(ask);
    const item = {
      id: "X",
      task: "Synthetic task",
      candidates: [{ id: "req", text: "Required.", required: true }, { id: "opt", text: "Optional." }],
      relevant: ["opt"],
    };
    const result = await selectEvidence(item, call);
    expect(Object.keys(ask.mock.calls[0][1])).toEqual(["opt"]);
    expect(result.final).toContain("req");
    expect(result.requiredPreserved).toBe(true);
  });

  it("falls back to the lexical baseline when Jev fails", async () => {
    const { call } = createRecorder(async () => ({ ok: false, reason: "synthetic_failure", latencyMs: 0 }));
    const result = await selectEvidence({ id: "Y", task: "rounding test", candidates: [{ id: "a", text: "rounding test file" }], relevant: ["a"] }, call);
    expect(result.mode).toBe("fallback_baseline:synthetic_failure");
    expect(result.final).toEqual(["a"]);
  });
});

describe("Jev accuracy scoring", () => {
  it("does not credit failed-call fallbacks as Jev accuracy", async () => {
    const report = await runEvaluation({ ask: async () => ({ ok: false, reason: "synthetic_down", latencyMs: 0 }) });
    const { evidence, duplicates, routing } = report.summary.correctness;
    expect(report.summary.liveCalls).toBe(0);
    expect(evidence).toMatchObject({ jevScoredCases: 0, fallbackCases: 2, jevMissed: [], jevExtra: [] });
    expect(duplicates).toMatchObject({ jev: "0/0", jevFailedCalls: 4 });
    expect(routing).toMatchObject({ jev: "0/0", jevFailedCalls: 5, deterministicGate: "1/1" });
    expect(report.evidence.every((e) => e.guard.keepFloor === 0.35 && e.guard.requiredRetained)).toBe(true);
  });

  it("scores only successful calls when some fail", () => {
    expect(scoreChoices([
      { jevCall: "ok", correct: true, baselineCorrect: false },
      { jevCall: "ok", correct: false, baselineCorrect: true },
      { jevCall: "failed", correct: true, baselineCorrect: true },
      { jevCall: "skipped", correct: true, baselineCorrect: true },
    ])).toEqual({ jev: "1/2", jevFailedCalls: 1, deterministicGate: "1/1", baseline: "3/4" });
  });
});

describe("createRecorder", () => {
  it("records the service's model and reason only as bounded printable tokens", async () => {
    const hostile = `x\u001b[2J\nFAKE LOG LINE ${"A".repeat(200)}`;
    const { call, calls } = createRecorder(async () => ({ ok: false, reason: hostile, model: hostile, latencyMs: 0 }));
    await call("probe", {}, {});
    expect(calls[0].model).toMatch(/^[\w.-]{1,64}$/);
    expect(calls[0].reason).toMatch(/^[\w.-]{1,64}$/);
  });

  it("records a non-string model as null", async () => {
    const { call, calls } = createRecorder(async () => ({ ok: false, reason: "x", model: { nested: true }, latencyMs: 0 }));
    await call("probe", {}, {});
    expect(calls[0].model).toBeNull();
  });
});

/** Service-shaped values an unexpected or compromised response could carry. */
const hostileUsage = () => ({ input_tokens: 471, output_tokens: "77", cached: { nested: "\u001b[2J" }, note: "x".repeat(500) });
const hostileProbabilities = (validKey) => ({
  [validKey]: 0.9,
  none: 1.5,
  T9: 0.2,
  reviewer_extra: "0.1",
  verifier: Number.NaN,
  "\u001b[2J FAKE LOG LINE": 0.3,
  // An own "__proto__" key, as JSON.parse produces from a response body.
  ...JSON.parse('{"__proto__": {"polluted": 1}}'),
});
const hostileChoiceAsk = (questionId, choice) => async () => ({
  ok: true,
  model: JEV_MODEL,
  latencyMs: 1,
  usage: hostileUsage(),
  answers: { [questionId]: { type: "choice", choice, confidence: 0.9, probabilities: hostileProbabilities(choice) } },
});

describe("bounded service-returned fields", () => {
  it("boundUsage keeps two non-negative integer counts", () => {
    expect(boundUsage({ input_tokens: 3, output_tokens: 0, extra: 1 })).toEqual({ input_tokens: 3, output_tokens: 0 });
    expect(boundUsage({ input_tokens: Number.NaN, output_tokens: Infinity })).toEqual({ input_tokens: null, output_tokens: null });
    expect(boundUsage({ input_tokens: "3", output_tokens: -1 })).toEqual({ input_tokens: null, output_tokens: null });
    for (const value of [null, undefined, 7, "x", [1, 2]]) expect(boundUsage(value)).toBeNull();
  });

  it("boundProbabilities keeps only criteria keys with values in [0, 1]", () => {
    expect(boundProbabilities({ a: 0, b: 1, c: 0.5, d: 0.5 }, ["a", "b", "c"])).toEqual({ a: 0, b: 1, c: 0.5 });
    expect(boundProbabilities({ a: -0.1, b: 1.01, c: Number.NaN, d: 0.5 }, ["a", "b", "c"])).toBeNull();
    expect(boundProbabilities(hostileProbabilities("a"), ["a", "none", "verifier", "reviewer_extra"])).toEqual({ a: 0.9 });
    for (const value of [null, undefined, 0.5, "x", [0.5]]) expect(boundProbabilities(value, ["0"])).toBeNull();
  });

  it("records usage only as two non-negative integer counts", async () => {
    const { call, calls } = createRecorder(async () => ({ ok: false, reason: "x", latencyMs: 0, usage: { input_tokens: -3, output_tokens: 2.5, extra: "y" } }));
    await call("probe", {}, {});
    const { call: call2, calls: calls2 } = createRecorder(async () => ({ ok: true, model: JEV_MODEL, answers: {}, latencyMs: 0, usage: hostileUsage() }));
    await call2("probe", {}, {});
    expect(calls[0].usage).toEqual({ input_tokens: null, output_tokens: null });
    expect(calls2[0].usage).toEqual({ input_tokens: 471, output_tokens: null });
    expect(JSON.stringify(calls2)).not.toContain("nested");
  });

  it("records a non-object usage as null", async () => {
    const { call, calls } = createRecorder(async () => ({ ok: true, model: JEV_MODEL, answers: {}, latencyMs: 0, usage: "lots" }));
    await call("probe", {}, {});
    expect(calls[0].usage).toBeNull();
  });

  it("keeps only the duplicate question's criteria keys with probabilities in [0, 1]", async () => {
    const { call, calls } = createRecorder(hostileChoiceAsk("dup", "T2"));
    const result = await detectDuplicate({ id: "D", proposal: "Expired login link error", expected: "T2" }, call);
    expect(result.probabilities).toEqual({ T2: 0.9 });
    expect(Object.getPrototypeOf(result.probabilities)).toBe(Object.prototype);
    expect(result).toMatchObject({ final: "T2", correct: true, gate: { status: "accepted", choice: "T2", confidence: 0.9 } });
    expect(calls[0].usage).toEqual({ input_tokens: 471, output_tokens: null });
  });

  it("keeps only the routing question's criteria keys with probabilities in [0, 1]", async () => {
    const { call } = createRecorder(hostileChoiceAsk("role", "reviewer"));
    const result = await route({ id: "R", task: "Review the diff", expected: "reviewer" }, call);
    expect(result.probabilities).toEqual({ reviewer: 0.9 });
    expect(result).toMatchObject({ final: "reviewer", correct: true });
  });

  it("records probabilities as null when nothing valid remains", async () => {
    const ask = async () => ({ ok: true, model: JEV_MODEL, latencyMs: 1, answers: { role: { type: "choice", choice: "reviewer", confidence: 0.9, probabilities: { other: 0.5, reviewer: 2 } } } });
    const { call } = createRecorder(ask);
    const result = await route({ id: "R", task: "Review the diff", expected: "reviewer" }, call);
    expect(result.probabilities).toBeNull();
    const { call: call2 } = createRecorder(async () => ({ ok: true, model: JEV_MODEL, latencyMs: 1, answers: { role: { type: "choice", choice: "reviewer", confidence: 0.9, probabilities: [0.5] } } }));
    expect((await route({ id: "R", task: "Review the diff", expected: "reviewer" }, call2)).probabilities).toBeNull();
  });

  it("writes no hostile value into a full synthetic report", async () => {
    const ask = async (state, questions, options) => {
      if (options) return { ok: false, reason: "synthetic_failure", latencyMs: 0, usage: hostileUsage() };
      if (Object.values(questions).some((q) => q.type === "choice" && !q.criteria)) return { ok: false, reason: "http_422", latencyMs: 0 };
      const answers = {};
      for (const [id, q] of Object.entries(questions)) {
        const first = q.type === "choice" ? Object.keys(q.criteria)[0] : null;
        answers[id] = q.type === "noul" ? { type: "noul", noul: 0.9 } : { type: "choice", choice: first, confidence: 0.9, probabilities: hostileProbabilities(first) };
      }
      return { ok: true, model: JEV_MODEL, answers, usage: hostileUsage(), latencyMs: 2 };
    };
    const report = await runEvaluation({ ask });
    const text = JSON.stringify(report);
    for (const needle of ["FAKE LOG LINE", "nested", "xxxxxxxx", "reviewer_extra", "T9", "1.5", "polluted"]) expect(text).not.toContain(needle);
    // Calls that returned usage record the bounded counts; the 422 probe returned none and records null.
    for (const c of report.calls) expect(c.usage).toEqual(c.label === "fail:422" ? null : { input_tokens: 471, output_tokens: null });
    for (const r of [...report.duplicates, ...report.routing.filter((x) => x.mode === "jev")]) {
      expect(Object.values(r.probabilities)).toEqual([0.9]);
    }
  });
});

describe("runEvaluation (synthetic service)", () => {
  it("records every probe as a failure that falls back, including the local stub shapes", async () => {
    const report = await runEvaluation({ ask: fakeAsk() });
    const byName = Object.fromEntries(report.failures.map((f) => [f.name, f]));
    expect(byName.malformed_body).toMatchObject({ source: "local_stub", reason: "malformed_response", gate: "failed" });
    expect(byName.unexpected_model).toMatchObject({ source: "local_stub", reason: "unexpected_model_version", gate: "failed" });
    expect(byName.missing_confidence).toMatchObject({ source: "local_stub", reason: "malformed_response", gate: "failed" });
    expect(report.summary.correctness.failuresFellBack).toBe(true);
    expect(report.summary.correctness.evidence.requiredPreserved).toBe(true);
    // Low-confidence (0.4) choices never become accepted decisions.
    expect(report.routing.filter((r) => r.mode === "jev").every((r) => r.final === "ordinary_reasoning")).toBe(true);
    expect(report.duplicates.every((d) => d.final === "needs_review")).toBe(true);
  });

  it("resolves the results path from the script location", () => {
    expect(RESULTS_PATH.endsWith("docs/release/jarvis-loop/jev-agent-decisions-results.json")).toBe(true);
  });

  it("stub server answers only on loopback", async () => {
    const stub = await startStub();
    try {
      expect(stub.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await stub.close();
    }
  });
});
