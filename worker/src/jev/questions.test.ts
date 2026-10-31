// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevQuestionsDecider, JEV_DRIVER_MODEL, validateChoiceAnswer, validateNoulAnswer, type QuestionsRequest } from "./questions";

afterEach(() => vi.unstubAllGlobals());
const KEY = "synthetic-key-value";
const request: QuestionsRequest = {
  state: { synthetic: true },
  questions: {
    op: { type: "choice", instructions: "Pick one.", criteria: { CLICK: "Press.", DONE: "Finished." } },
    target: { type: "choice", instructions: "Which element?", criteria: { f0_e1: null, none: null } },
    present: { type: "noul", instructions: "Is it there?" },
  },
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), init);
const ok = {
  model: JEV_DRIVER_MODEL, extra_field: "ignored",
  answers: { op: { type: "choice", choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.99, DONE: 0 } } },
  usage: { input_tokens: 321, output_tokens: 0 },
};

describe("multi-question Jev transport", () => {
  it("posts every question once to the pinned endpoint and model, with null criteria", async () => {
    const fetch = vi.fn().mockResolvedValue(reply(ok, { headers: { "x-typesafe-request-id": "req_synthetic.1" } }));
    vi.stubGlobal("fetch", fetch);
    const result = await createJevQuestionsDecider(KEY)(request, new AbortController().signal);
    expect(result).toMatchObject({ model: JEV_DRIVER_MODEL, inputTokens: 321, estimatedUsage: false, requestId: "req_synthetic.1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({ model: JEV_DRIVER_MODEL, ...request });
  });

  it("charges the estimate when usage is null and ignores unknown keys", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ ...ok, usage: null })));
    const result = await createJevQuestionsDecider(KEY)(request, new AbortController().signal);
    expect(result.estimatedUsage).toBe(true);
    expect(result.inputTokens).toBe(Math.ceil(Buffer.byteLength(JSON.stringify({ model: JEV_DRIVER_MODEL, ...request })) / 2));
  });

  it("retries once on 429 honouring retry-after, then reports rate limiting", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply({}, { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(reply(ok));
    vi.stubGlobal("fetch", fetch);
    await expect(createJevQuestionsDecider(KEY)(request, new AbortController().signal)).resolves.toMatchObject({ inputTokens: 321 });
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => reply({}, { status: 529, headers: { "retry-after": "0" } })));
    await expect(createJevQuestionsDecider(KEY)(request, new AbortController().signal)).rejects.toMatchObject({ code: "jev_rate_limited" });
  });

  it.each([
    [() => reply({ error: KEY }, { status: 400 }), "jev_rejected_4xx"],
    [() => reply({ error: KEY }, { status: 503 }), "jev_unavailable"],
    [() => new Response(`not json ${KEY}`), "jev_invalid_response"],
    [() => reply({ ...ok, model: "jev-1.14.0" }), "jev_invalid_response"],
    [() => new Response("x".repeat(70_000)), "jev_invalid_response"],
  ])("maps failures to a distinct code without leaking the key (%#)", async (response, code) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response()));
    const error = await createJevQuestionsDecider(KEY)(request, new AbortController().signal).catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code });
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(KEY);
  });

  it("refuses an oversized or malformed request before any network call", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const decide = createJevQuestionsDecider(KEY);
    await expect(decide({ ...request, state: "x".repeat(13_000) }, new AbortController().signal)).rejects.toMatchObject({ code: "jev_request_budget" });
    await expect(decide({ ...request, questions: { "bad key": request.questions.op } }, new AbortController().signal)).rejects.toMatchObject({ code: "jev_invalid_question" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("answer validation", () => {
  const offered = ["CLICK", "DONE"];
  const answer = (probabilities: Record<string, number>, choice = "CLICK") => ({ type: "choice", choice, confidence: 0.9, probabilities });
  it("accepts a sum within 0.02 of one (1.14 returned 0.99) and rejects worse", () => {
    expect(validateChoiceAnswer(answer({ CLICK: 0.98, DONE: 0.01 }), offered)).not.toBeNull();
    expect(validateChoiceAnswer(answer({ CLICK: 0.9, DONE: 0.05 }), offered)).toBeNull();
  });
  it("rejects invented or missing options, non-finite values and a non-maximal choice", () => {
    expect(validateChoiceAnswer(answer({ CLICK: 0.5, DONE: 0.4, BUY: 0.1 }), offered)).toBeNull();
    expect(validateChoiceAnswer(answer({ CLICK: 1 }), offered)).toBeNull();
    expect(validateChoiceAnswer(answer({ CLICK: Number.NaN, DONE: 1 }), offered)).toBeNull();
    expect(validateChoiceAnswer(answer({ CLICK: 0.2, DONE: 0.8 }), offered)).toBeNull();
    expect(validateChoiceAnswer(answer({ CLICK: 0.5, DONE: 0.5 }, "BUY"), offered)).toBeNull();
  });
  it("accepts only a probability for a noul answer", () => {
    expect(validateNoulAnswer({ type: "noul", noul: 0.8 })).toBe(0.8);
    expect(validateNoulAnswer({ type: "noul", noul: 1.2 })).toBeNull();
    expect(validateNoulAnswer({ type: "choice", noul: 0.8 })).toBeNull();
  });
});
