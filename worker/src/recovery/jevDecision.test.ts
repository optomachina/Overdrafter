// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevRecoveryDecider, JEV_RECOVERY_MODEL, validateRecoveryDecision } from "./jevDecision";
import { simulatedRecoveryDecision } from "./comparison";
const question = { field: "quantity" as const, candidates: [{ id: "c0", label: "quantity", control: "number" as const }] };
afterEach(() => vi.unstubAllGlobals());
describe("Jev closed decision contract", () => {
  it("rejects invented options, invalid probabilities and usage", async () => {
    const good = await simulatedRecoveryDecision(question, new AbortController().signal);
    expect(validateRecoveryDecision(good, question)).toBe(true);
    for (const bad of [
      { ...good, choice: "#purchase" }, { ...good, confidence: NaN },
      { ...good, probabilities: { c0: 0.4, abstain: 0.4 } },
      { ...good, probabilities: { c0: 0.9, abstain: 0.1, invented: 0 } },
      { ...good, inputTokens: -1 }, { ...good, model: "unknown" },
    ]) expect(validateRecoveryDecision(bad, question)).toBe(false);
  });
  it("uses fixed endpoint, pinned model and no redirects with bounded response", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: JEV_RECOVERY_MODEL,
      answers: { target: { type: "choice", choice: "c0", confidence: 1, probabilities: { c0: 1, abstain: 0 } } },
      usage: { input_tokens: 50, output_tokens: 10 },
    })));
    vi.stubGlobal("fetch", fetch);
    expect((await createJevRecoveryDecider("synthetic-key")(question, new AbortController().signal)).inputTokens).toBe(50);
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(request.redirect).toBe("error");
    expect(JSON.parse(request.body).model).toBe(JEV_RECOVERY_MODEL);
    fetch.mockResolvedValue(new Response("x".repeat(17000)));
    await expect(createJevRecoveryDecider("synthetic-key")(question, new AbortController().signal)).rejects.toThrow("jev_request_failed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not retry failures or expose response body", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("secret account data", { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createJevRecoveryDecider("synthetic-key")(question, new AbortController().signal)).rejects.toThrow("jev_request_failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
