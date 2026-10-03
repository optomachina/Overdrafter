// @vitest-environment node
// Independent source-only repros: fake clocks, ledger, audit and transport; no runtime services.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationalJevSession, OperationalJevObservations, observeBoundOperationalFailure,
  type OperationalJevCapabilities } from "./operationalSession";

const scope = { organizationId: "synthetic-org", taskId: "synthetic-task", quoteRunId: "synthetic-run",
  provider: "xometry" as const, sourceRevision: "8cba2772636b51578dbc82507df5350244145258" };
function fixture() {
  const caps = {
    authorize: vi.fn(async () => true),
    reserve: vi.fn(async () => ({ reservationId: "reservation-a", estimatedUsd: 0.25 })),
    settle: vi.fn(async () => undefined), audit: vi.fn(async () => true),
    decide: vi.fn(async (question) => ({ model: "jev-1.13.0", choice: "expired_session", confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === "expired_session" ? 1 : 0])),
      inputTokens: 10, outputTokens: 10 })),
  } satisfies OperationalJevCapabilities;
  const makeSession = () => new OperationalJevSession({ mode: "shadow", capabilities: caps, admission: {
    scope, expiresAt: Date.now() + 60_000, uses: ["exception_routing"], evidenceProfiles: ["failure_words.v1"],
  } });
  return { caps, makeSession };
}
afterEach(() => vi.restoreAllMocks());

describe("independent 8cba operational review regression assertions", () => {
  it.each(["authorize", "reserve", "audit"] as const)("does not begin inference after synchronously late %s", async (key) => {
    let monotonic = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const { caps, makeSession } = fixture();
    const original = caps[key];
    let first = true;
    caps[key] = vi.fn(async (...args: unknown[]) => {
      if (first) { monotonic += 5_001; first = false; }
      return original(...args as never[]);
    }) as never;
    const result = await makeSession().failure(scope, "session expired");
    expect(result.outcome).toBe("unavailable");
    expect(caps.decide).not.toHaveBeenCalled();
  });

  it("rejects a synchronous dependency result beyond its own one-second bound", async () => {
    let monotonic = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const { caps, makeSession } = fixture();
    caps.authorize.mockImplementationOnce(async () => { monotonic += 1_001; return true; });
    const result = await makeSession().failure(scope, "session expired");
    expect(result.outcome).toBe("unavailable");
    expect(caps.decide).not.toHaveBeenCalled();
  });

  it("settles the reservation captured before the audit await, despite external mutation", async () => {
    const { caps, makeSession } = fixture();
    const reserved = { reservationId: "reservation-a", estimatedUsd: 0.25 };
    caps.reserve.mockResolvedValue(reserved);
    caps.audit.mockImplementation(async () => {
      reserved.reservationId = "unrelated-held-reservation-b";
      reserved.estimatedUsd = 100;
      return false;
    });
    await makeSession().failure(scope, "session expired");
    expect(caps.decide).not.toHaveBeenCalled();
    expect(caps.settle).toHaveBeenCalledWith({ reservationId: "reservation-a", estimatedUsd: 0.25 }, 0, expect.anything());
  });

  it("does not return a caller-mutated cached receipt to the next observer", async () => {
    const { caps, makeSession } = fixture();
    const session = makeSession();
    const first = await session.failure(scope, "session expired");
    expect(first.reason).toBe("observed");
    try { Object.assign(first, { reason: "forged", category: "engineering_review" }); } catch { /* Frozen is acceptable. */ }
    const next = await session.failure(scope, "session expired");
    expect(caps.decide).toHaveBeenCalledOnce();
    expect(next.reason).toBe("observed");
    expect(next.category).toBe("expired_session");
  });

  it("keeps the method selected when an exception observation is queued", async () => {
    const { caps, makeSession } = fixture();
    const session = makeSession();
    const observations = new OperationalJevObservations();
    await observeBoundOperationalFailure({ session, scope, observations }, scope, "session expired");
    const replacement = vi.fn(async () => { throw new Error("replacement method"); });
    session.failure = replacement;
    await observations.drain();
    expect(replacement).not.toHaveBeenCalled();
    expect(caps.decide).toHaveBeenCalledOnce();
  });
});
