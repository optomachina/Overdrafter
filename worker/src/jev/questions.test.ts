import { afterEach, describe, expect, it, vi } from "vitest";
import { JevTransportError, createJevQuestionsDecider, serializeQuestions, validateChoiceAnswer, validateNoulAnswer } from "./questions.js";

const request = { state: { x: 1 }, questions: { op: { type: "choice" as const, instructions: "pick", criteria: { A: null, B: "b" } } } };

afterEach(() => vi.unstubAllGlobals());

describe("validateChoiceAnswer", () => {
  it("accepts a 0.99 sum (seen on jev-1.14.0) and rejects a 0.97 sum", () => {
    expect(validateChoiceAnswer({ choice: "A", confidence: 0.9, probabilities: { A: 0.9, B: 0.09 } }, ["A", "B"])).not.toBeNull();
    expect(validateChoiceAnswer({ choice: "A", confidence: 0.9, probabilities: { A: 0.9, B: 0.07 } }, ["A", "B"])).toBeNull();
  });
  it("rejects missing or invented keys, a non-maximal choice and out-of-range values", () => {
    expect(validateChoiceAnswer({ choice: "A", confidence: 1, probabilities: { A: 1 } }, ["A", "B"])).toBeNull();
    expect(validateChoiceAnswer({ choice: "C", confidence: 1, probabilities: { A: 0, B: 0, C: 1 } }, ["A", "B"])).toBeNull();
    expect(validateChoiceAnswer({ choice: "B", confidence: 1, probabilities: { A: 0.8, B: 0.2 } }, ["A", "B"])).toBeNull();
    expect(validateChoiceAnswer({ choice: "A", confidence: 1, probabilities: { A: 1.2, B: -0.2 } }, ["A", "B"])).toBeNull();
  });
  it("validates noul answers", () => {
    expect(validateNoulAnswer({ noul: 0.4 })).toEqual({ noul: 0.4 });
    expect(validateNoulAnswer({ noul: 2 })).toBeNull();
  });
});

describe("serializeQuestions", () => {
  it("rejects option keys outside the API pattern and oversized bodies", () => {
    expect(() => serializeQuestions("jev-1.13.0", { state: {}, questions: { op: { type: "choice", instructions: "", criteria: { "bad key": null } } } })).toThrow(JevTransportError);
    expect(() => serializeQuestions("jev-1.13.0", { state: { big: "x".repeat(20_000) }, questions: request.questions })).toThrow("jev_request_budget");
  });
});

describe("createJevQuestionsDecider", () => {
  it("tolerates unknown keys and null usage, charging the estimate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "jev-1.13.0", extra: true, usage: null,
      answers: { op: { type: "choice", choice: "A", confidence: 0.8, probabilities: { A: 0.9, B: 0.1 } } },
    }), { status: 200, headers: { "x-typesafe-request-id": "req_synthetic" } })));
    const result = await createJevQuestionsDecider("synthetic-key", "jev-1.13.0")(request, AbortSignal.timeout(1000));
    expect(result.inputTokens).toBeNull();
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.requestId).toBe("req_synthetic");
  });
  it("maps statuses to distinct error codes and never leaks the key", async () => {
    for (const [status, code] of [[422, "jev_rejected_4xx"], [503, "jev_unavailable"], [429, "jev_rate_limited"]] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status, headers: status === 429 ? { "retry-after": "10" } : {} })));
      const error = await createJevQuestionsDecider("synthetic-key", "jev-1.13.0")(request, AbortSignal.timeout(1000)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JevTransportError);
      expect((error as JevTransportError).code).toBe(code);
      expect(String((error as Error).message)).not.toContain("synthetic-key");
    }
  });
  it("retries one 429 inside the deadline", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "0.05" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createJevQuestionsDecider("synthetic-key", "jev-1.13.0")(request, AbortSignal.timeout(2000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.inputTokens).toBe(5);
  });
});
