import { describe, expect, it, vi } from "vitest";
import { createDecisionSession, type Decision } from "./decision.js";
const question = { state: "synthetic", instructions: "Choose", criteria: { keep: "Keep", drop: "Drop" } };
const answer: Decision = { choice: "drop", confidence: 1, probabilities: { keep: 0, drop: 1 }, model: "jev-1.13.0", inputTokens: 20, outputTokens: 5 };
describe("bounded review decisions", () => {
  it("defaults off and shadow records without applying", async () => {
    const provider = vi.fn(async () => answer);
    expect(await createDecisionSession({ provider }).decide(question, "keep")).toBe("keep");
    expect(provider).not.toHaveBeenCalled();
    const shadow = createDecisionSession({ mode: "shadow", provider });
    expect(await shadow.decide(question, "keep")).toBe("keep");
    expect(shadow.audit[0]).toMatchObject({ proposed: "drop", selected: "keep", reason: "shadow" });
  });
  it("applies validated selections and reserves a shared call budget", async () => {
    const provider = vi.fn(async () => answer);
    const session = createDecisionSession({ mode: "apply", provider, maxCalls: 1 });
    expect(await session.decide(question, "keep")).toBe("drop");
    expect(await session.decide(question, "keep")).toBe("keep");
    expect(session.audit[1].reason).toBe("budget");
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...answer, choice: "invented" }, { ...answer, model: "other" },
    { ...answer, probabilities: { keep: 0, drop: 0.5 } },
    { ...answer, confidence: NaN }, { ...answer, inputTokens: -1 },
  ])("rejects malformed distribution/model/usage", async (response) => {
    const session = createDecisionSession({ mode: "apply", provider: async () => response });
    expect(await session.decide(question, "keep")).toBe("keep");
    expect(session.audit[0].reason).toBe("invalid_response");
  });
  it("fails closed on uncertainty, service errors, and reported budget overrun", async () => {
    for (const [provider, reason] of [
      [async () => ({ ...answer, confidence: 0.5 }), "uncertain"],
      [async () => { throw new Error("secret raw provider payload"); }, "service_error"],
      [async () => ({ ...answer, inputTokens: 999999 }), "usage_budget"],
    ] as const) {
      const session = createDecisionSession({ mode: "apply", provider });
      expect(await session.decide(question, "keep")).toBe("keep");
      expect(session.audit[0].reason).toBe(reason);
      expect(JSON.stringify(session.audit)).not.toContain("secret");
    }
  });
  it("times out even if an injected provider ignores cancellation", async () => {
    const session = createDecisionSession({ mode: "apply", timeoutMs: 5, provider: () => new Promise(() => {}) });
    expect(await session.decide(question, "keep")).toBe("keep");
    expect(session.audit[0].reason).toBe("timeout");
  });
  it("does not call for oversized state/options or exhausted token reservation", async () => {
    const provider = vi.fn(async () => answer);
    for (const options of [{ maxRequestBytes: 10 }, { maxInputTokens: 10 }]) {
      const session = createDecisionSession({ mode: "apply", provider, ...options });
      expect(await session.decide(question, "keep")).toBe("keep");
      expect(session.audit[0].reason).toBe("budget");
    }
    expect(provider).not.toHaveBeenCalled();
  });
});
