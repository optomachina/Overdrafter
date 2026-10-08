// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createJevChoiceDecider, JEV_MODEL } from "./choice";
afterEach(() => vi.unstubAllGlobals());
const question = { state: { synthetic: true }, instructions: "Choose.", criteria: { yes: "Yes", abstain: "Unknown" } };
it("validates a bounded choice and reports actual usage", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: JEV_MODEL,
    answers: { target: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, abstain: 0 } } },
    usage: { input_tokens: 25, output_tokens: 10 },
  })));
  vi.stubGlobal("fetch", fetch);
  expect(await createJevChoiceDecider("synthetic")(question, new AbortController().signal)).toMatchObject({ choice: "yes", inputTokens: 25 });
  expect(fetch.mock.calls[0][0]).toBe("https://api.typesafe.ai/v1/systemone");
  expect(fetch.mock.calls[0][1].redirect).toBe("error");
});
it("does not send oversized requests or leak invalid service replies", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("secret-private-value"));
  vi.stubGlobal("fetch", fetch);
  const decide = createJevChoiceDecider("synthetic");
  await expect(decide({ ...question, state: "x".repeat(9000) }, new AbortController().signal)).rejects.toThrow("jev_request_budget");
  expect(fetch).not.toHaveBeenCalled();
  await expect(decide(question, new AbortController().signal)).rejects.toThrow(/^jev_request_failed$/);
  expect(fetch).toHaveBeenCalledTimes(1);
});
