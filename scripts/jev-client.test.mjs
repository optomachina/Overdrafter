// @vitest-environment node
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { askJev, gatedChoice, isValidAnswer, JEV_MODEL, smoke } from "./jev-client.mjs";

const criteria = { implementer: "Writes code.", verifier: "Runs checks." };
const choiceQ = { role: { type: "choice", instructions: "Which role?", criteria } };
const noulQ = { keep: { type: "noul", instructions: "Keep it?" } };

function stubFetch(status, text) {
  const fetchMock = vi.fn(async () => new Response(text, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const body = (answers, model = JEV_MODEL) => JSON.stringify({ model, answers, usage: { input_tokens: 10, output_tokens: 2 } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("askJev", () => {
  it("returns ok with answers and usage for a well-formed response", async () => {
    stubFetch(200, body({ role: { type: "choice", choice: "verifier", confidence: 0.9 } }));
    const result = await askJev({ task: "synthetic" }, choiceQ);
    expect(result).toMatchObject({ ok: true, model: JEV_MODEL, usage: { input_tokens: 10, output_tokens: 2 } });
    expect(result.answers.role.choice).toBe("verifier");
  });

  it("sends no Authorization header even when a key-like variable is set", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-placeholder");
    const fetchMock = stubFetch(200, body({ role: { type: "choice", choice: "verifier", confidence: 0.9 } }));
    await askJev({}, choiceQ);
    const [, init] = fetchMock.mock.calls[0];
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    expect(JSON.stringify(init)).not.toContain("synthetic-placeholder");
  });

  it("returns invalid_request without calling fetch when the state cannot be serialized", async () => {
    const fetchMock = stubFetch(200, "{}");
    const circular = {};
    circular.self = circular;
    expect(await askJev({ n: 1n }, choiceQ)).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(await askJev(circular, choiceQ)).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [500, "http_500"],
    [422, "http_422"],
    [400, "http_400"],
  ])("maps HTTP %i to %s", async (status, reason) => {
    stubFetch(status, "{}");
    expect(await askJev({}, choiceQ)).toMatchObject({ ok: false, reason });
  });

  it.each([
    ["non-JSON body", "not json"],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["missing answers", JSON.stringify({ model: JEV_MODEL })],
    ["wrong answer type", body({ role: { type: "noul", noul: 0.4 } })],
    ["choice without confidence", body({ role: { type: "choice", choice: "verifier" } })],
    ["string confidence", body({ role: { type: "choice", choice: "verifier", confidence: "0.9" } })],
    ["confidence above 1", body({ role: { type: "choice", choice: "verifier", confidence: 1.5 } })],
    ["choice outside criteria", body({ role: { type: "choice", choice: "zzz_not_a_criterion", confidence: 0.9 } })],
  ])("returns malformed_response for %s", async (_label, text) => {
    stubFetch(200, text);
    expect(await askJev({}, choiceQ)).toMatchObject({ ok: false, reason: "malformed_response" });
  });

  it("returns malformed_response for a noul answer without a numeric probability", async () => {
    stubFetch(200, body({ keep: { type: "noul" } }));
    expect(await askJev({}, noulQ)).toMatchObject({ ok: false, reason: "malformed_response" });
  });

  it("returns unexpected_model_version when another model answers", async () => {
    stubFetch(200, body({ role: { type: "choice", choice: "verifier", confidence: 0.9 } }, "jev-9.9.9"));
    expect(await askJev({}, choiceQ)).toMatchObject({ ok: false, reason: "unexpected_model_version", model: "jev-9.9.9" });
  });

  it("returns timeout when the call is aborted by its timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }));
    expect(await askJev({}, choiceQ, { timeoutMs: 1 })).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("reports the network cause code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }));
    expect(await askJev({}, choiceQ)).toMatchObject({ ok: false, reason: "network_ECONNREFUSED" });
  });

  it("never throws for null options or null questions", async () => {
    stubFetch(200, body({}));
    await expect(askJev({}, null, null)).resolves.toMatchObject({ ok: true });
  });
});

describe("askJev against a local HTTP stub (real socket, no outbound traffic)", () => {
  let server;
  let base;
  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url === "/malformed") return res.end("not json");
        return res.end(JSON.stringify({ model: "jev-9.9.9-stub", answers: {} }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("returns malformed_response for a non-JSON body", async () => {
    expect(await askJev({}, choiceQ, { endpoint: `${base}/malformed` })).toMatchObject({ ok: false, reason: "malformed_response" });
  });

  it("returns unexpected_model_version for another model", async () => {
    expect(await askJev({}, choiceQ, { endpoint: `${base}/wrong-model` })).toMatchObject({ ok: false, reason: "unexpected_model_version" });
  });
});

describe("isValidAnswer", () => {
  it("accepts a choice named in the criteria with a numeric confidence", () => {
    expect(isValidAnswer(choiceQ.role, { type: "choice", choice: "implementer", confidence: 0 })).toBe(true);
  });
  it("rejects a non-object answer", () => {
    expect(isValidAnswer(choiceQ.role, null)).toBe(false);
  });
});

describe("gatedChoice", () => {
  const ok = (answer) => ({ ok: true, answers: { role: answer } });

  it("accepts at or above the floor", () => {
    expect(gatedChoice(ok({ choice: "verifier", confidence: 0.5 }), "role")).toEqual({ status: "accepted", choice: "verifier", confidence: 0.5 });
  });
  it("reports uncertain below the floor", () => {
    expect(gatedChoice(ok({ choice: "verifier", confidence: 0.69 }), "role", 0.7)).toMatchObject({ status: "uncertain" });
  });
  it("passes a failed result through", () => {
    expect(gatedChoice({ ok: false, reason: "timeout" }, "role")).toEqual({ status: "failed", reason: "timeout" });
  });
  it.each([
    ["a missing answer", { ok: true, answers: {} }],
    ["missing answers", { ok: true }],
    ["no confidence", ok({ choice: "verifier" })],
    ["a string confidence", ok({ choice: "verifier", confidence: "0.9" })],
  ])("fails closed for %s", (_label, result) => {
    expect(gatedChoice(result, "role")).toEqual({ status: "failed", reason: "malformed_answer" });
  });
});

describe("smoke", () => {
  it("prints only sanitized fields for a successful call", async () => {
    stubFetch(200, JSON.stringify({ model: JEV_MODEL, answers: { role: { type: "choice", choice: "verifier", confidence: 1 } }, usage: { input_tokens: 9, output_tokens: 3 }, extra: "ignored\ninjected" }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const summary = await smoke();
    expect(summary).toEqual({ ok: true, reason: null, model: JEV_MODEL, latencyMs: expect.any(Number), usage: { input_tokens: 9, output_tokens: 3 }, gate: { status: "accepted", choice: "verifier", confidence: 1 } });
    expect(log.mock.calls[0][0]).not.toContain("injected");
    log.mockRestore();
  });

  it("strips control characters from a failure reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "E\nFAKE log line" } });
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const summary = await smoke();
    expect(summary).toMatchObject({ ok: false, reason: "network_E_FAKE_log_line", model: null, gate: { status: "failed", choice: null } });
    log.mockRestore();
  });
});
