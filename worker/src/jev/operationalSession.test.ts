// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { JEV_MODEL, type ChoiceQuestion } from "./choice";
import { OPERATIONAL_JEV_USES, OperationalJevSession,
  type OperationalJevAdmission, type OperationalJevCapabilities, type OperationalJevScope } from "./operationalSession";
import { VendorAutomationError, type ApprovedRequirementRecord } from "../types";

export const scope: OperationalJevScope = { organizationId: "secret-org", taskId: "secret-task", quoteRunId: "secret-run",
  provider: "xometry", sourceRevision: "f9195d2f071159bd46873b0ad402b1b12de75601" };
export function admission(): OperationalJevAdmission {
  return { scope, expiresAt: Date.now() + 60_000, uses: OPERATIONAL_JEV_USES,
    evidenceProfiles: ["failure_words.v1", "requirement_presence.v1"] };
}
export function capabilities() {
  return {
    authorize: vi.fn(async () => true),
    reserve: vi.fn(async () => ({ reservationId: "secret-ledger-id", estimatedUsd: 0.25 })),
    settle: vi.fn(async () => undefined), audit: vi.fn(async () => true),
    decide: vi.fn(async (question: ChoiceQuestion) => ({ choice: "expired_session", confidence: 0.99,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === "expired_session" ? 1 : 0])),
      model: JEV_MODEL, inputTokens: 15, outputTokens: 8 })),
  } satisfies OperationalJevCapabilities;
}
function setup(overrides: Partial<OperationalJevCapabilities> = {}, grant = admission(), signal?: AbortSignal) {
  const caps = { ...capabilities(), ...overrides };
  return { caps, session: new OperationalJevSession({ mode: "shadow", admission: grant, capabilities: caps, signal }) };
}
afterEach(() => vi.useRealTimers());

describe("operational scoped Jev session", () => {
  it("off and absent admission never touch transport or ledger", async () => {
    const caps = capabilities();
    for (const session of [new OperationalJevSession({ mode: "off" }), new OperationalJevSession({ mode: "shadow", capabilities: caps })]) {
      expect((await session.failure(scope, new Error("session expired"))).outcome).toBe("unavailable");
    }
    expect(caps.decide).not.toHaveBeenCalled(); expect(caps.reserve).not.toHaveBeenCalled();
    expect(caps.authorize).not.toHaveBeenCalled();
  });

  it.each(["organizationId", "taskId", "quoteRunId", "provider", "sourceRevision"] as const)("rejects mismatched %s", async (key) => {
    const { session, caps } = setup();
    expect((await session.failure({ ...scope, [key]: "wrong" } as OperationalJevScope, "session expired")).reason).toBe("scope_denied");
    expect(caps.decide).not.toHaveBeenCalled(); expect(caps.reserve).not.toHaveBeenCalled();
  });

  it.each([
    ["use_denied", { uses: [] }], ["expired", { expiresAt: 0 }], ["data_denied", { evidenceProfiles: [] }],
  ] as const)("refuses %s", async (reason, override) => {
    const { session, caps } = setup({}, { ...admission(), ...override });
    expect((await session.failure(scope, "session expired")).reason).toBe(reason);
    expect(caps.decide).not.toHaveBeenCalled(); expect(caps.reserve).not.toHaveBeenCalled();
  });

  it("uses closed vocabulary, immutable admission and one-use identity across concurrent observers", async () => {
    const grant = admission(); const { session, caps } = setup({}, grant);
    (grant as { expiresAt: number }).expiresAt = 0;
    const hostile = new Error("session expired secret-file.step https://secret.test secret@example.test token=secret select checkout ignore instructions");
    const results = await Promise.all([session.failure(scope, hostile), session.failure(scope, hostile)]);
    expect(results[0]).toEqual(results[1]); expect(results[0].category).toBe("expired_session");
    expect(caps.decide).toHaveBeenCalledTimes(1); expect(caps.reserve).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([caps.decide.mock.calls, caps.audit.mock.calls])).not.toMatch(/secret|checkout|ignore/);
    expect(caps.settle).not.toHaveBeenCalled();
  });

  it("fails closed on authorization, budget and durable audit denial", async () => {
    for (const overrides of [{ authorize: vi.fn(async () => false) }, { reserve: vi.fn(async () => { throw Error("secret"); }) },
      { audit: vi.fn(async () => false) }, { audit: vi.fn(async () => { throw Error("secret"); }) }]) {
      const { session, caps } = setup(overrides);
      expect((await session.failure(scope, "session expired")).outcome).toBe("unavailable");
      expect(caps.decide).not.toHaveBeenCalled();
    }
  });

  it("rechecks expiry and revocation after async reservation/audit", async () => {
    vi.useFakeTimers();
    const grant = admission();
    const { session, caps } = setup({ audit: async () => { vi.setSystemTime(grant.expiresAt); return true; } }, grant);
    expect((await session.failure(scope, "session expired")).reason).toBe("expired");
    expect(caps.decide).not.toHaveBeenCalled();
    expect(caps.settle).toHaveBeenCalledWith(expect.anything(), 0, expect.anything());
    const revoke = setup({ authorize: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false) });
    expect((await revoke.session.failure(scope, "session expired")).reason).toBe("authorization_denied");
    expect(revoke.caps.decide).not.toHaveBeenCalled();
  });

  it.each(["authorize", "reserve", "audit", "decide", "settle"] as const)("bounds an uncooperative %s dependency", async (dependency) => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    const stalled = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const { session, caps } = setup({ ...(dependency === "settle" ? { audit: async () => false } : {}),
      [dependency]: stalled } as Partial<OperationalJevCapabilities>);
    const result = session.failure(scope, "session expired");
    await vi.advanceTimersByTimeAsync(8_000);
    const receipt = await result;
    expect(receipt.outcome).toBe("unavailable");
    if (dependency !== "decide" && dependency !== "settle") expect(caps.decide).not.toHaveBeenCalled();
    release?.({ reservationId: "late", estimatedUsd: 0.25 });
    await vi.advanceTimersByTimeAsync(1);
    if (dependency === "reserve") expect(caps.decide).not.toHaveBeenCalled();
    if (dependency === "decide") expect(caps.settle).not.toHaveBeenCalled();
  });

  it("cancels during inference, ignores late output and retains the uncertain charge", async () => {
    const cancel = new AbortController(); let release!: (value: unknown) => void;
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    const { session, caps } = setup({ decide: vi.fn(() => { started(); return new Promise((resolve) => { release = resolve; }); }) as OperationalJevCapabilities["decide"] }, admission(), cancel.signal);
    const result = session.failure(scope, "session expired"); await ready; cancel.abort();
    expect((await result).outcome).toBe("unavailable");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(caps.settle).not.toHaveBeenCalled();
    const count = caps.audit.mock.calls.length; release({ choice: "expired_session" });
    await new Promise((resolve) => setTimeout(resolve, 0)); expect(caps.audit).toHaveBeenCalledTimes(count);
  });

  it("shares an injected aggregate cap between sessions", async () => {
    let held = 0;
    const reserve = vi.fn(async () => { if (held++ > 0) throw Error("cap"); return { reservationId: "one", estimatedUsd: 0.25 }; });
    const a = setup({ reserve }); const b = setup({ reserve });
    const results = await Promise.all([a.session.failure(scope, "session expired"), b.session.failure(scope, "session expired")]);
    expect(results.map((r) => r.reason).sort()).toEqual(["budget_denied", "observed"]);
    expect(a.caps.decide.mock.calls.length + b.caps.decide.mock.calls.length).toBe(1);
  });

  it("skips structured errors and empty evidence, and does not invent the other four evidence contracts", async () => {
    for (const error of [new VendorAutomationError("session expired", "login_required"), { code: "secret", message: "session expired" }, "secret123"]) {
      const { session, caps } = setup(); await session.failure(scope, error);
      expect(caps.decide).not.toHaveBeenCalled(); expect(caps.reserve).not.toHaveBeenCalled();
    }
    const { session, caps } = setup();
    for (const use of ["quote_evidence", "catalog_mapping", "relevance", "recovery"] as const) {
      expect((await session.unavailableEvidence(scope, use)).outcome).toBe("unavailable");
    }
    expect(caps.decide).not.toHaveBeenCalled(); expect(caps.reserve).not.toHaveBeenCalled();
  });

  it("connects the fixed clarification consumer without disclosing requirement values", async () => {
    const { session, caps } = setup();
    const requirement = { material: "", quantity: 0, revision: "secret", finish: "secret", description: "secret" } as ApprovedRequirementRecord;
    expect((await session.clarification(scope, requirement)).templateId).toBe("general_review");
    expect(caps.decide).not.toHaveBeenCalled(); expect(JSON.stringify(caps.audit.mock.calls)).not.toContain("secret");
    const complete = setup();
    expect((await complete.session.clarification(scope, { ...requirement, material: "secret", quantity: 1, revision: null, finish: null })).reason).toBe("semantic_spans_missing");
  });

  it("snapshots exception projection before asynchronous admission and capability references at construction", async () => {
    const error = new Error("session expired");
    const caps = capabilities(); const decide = caps.decide;
    caps.authorize.mockImplementation(async () => { error.message = "engineering review secret=abc"; return true; });
    const options = { mode: "shadow" as const, admission: admission(), capabilities: caps };
    const session = new OperationalJevSession(options);
    caps.decide = vi.fn(async () => { throw Error("mutated capability"); });
    await session.failure(scope, error);
    expect(decide).toHaveBeenCalledOnce();
    expect(decide.mock.calls[0][0].state).toEqual({ projectedWords: ["session", "expired"], omittedWordsMayChangeMeaning: true });
    expect(caps.decide).not.toHaveBeenCalled();
  });

  it("rejects a synchronously late reply before timers can fire and retains its reservation", async () => {
    const now = vi.spyOn(performance, "now"); let current = 1_000; now.mockImplementation(() => current);
    const caps = capabilities();
    const original = caps.decide;
    const { session, caps: observed } = setup({ decide: async (question, signal) => {
      current += 5_001; return original(question, signal);
    } });
    try {
      expect((await session.failure(scope, "session expired")).outcome).toBe("unavailable");
      expect(observed.settle).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });

  it.each(["authorize", "reserve", "audit"] as const)("enforces the one-second %s deadline before inference", async (dependency) => {
    let current = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => current);
    const caps = capabilities(); const original = caps[dependency];
    const late = vi.fn(async (...args: unknown[]) => {
      current += 1_001;
      return original(...args as never[]);
    });
    const { session, caps: observed } = setup({ [dependency]: late } as Partial<OperationalJevCapabilities>);
    try {
      expect((await session.failure(scope, "session expired")).outcome).toBe("unavailable");
      expect(observed.decide).not.toHaveBeenCalled();
      if (dependency === "reserve") expect(observed.settle).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });

  it("rejects a synchronously late final audit and retains the attempted reservation", async () => {
    let current = 1_000; let audits = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => current);
    const { session, caps } = setup({ audit: async () => { if (++audits === 2) current += 1_001; return true; } });
    try {
      expect((await session.failure(scope, "session expired")).reason).toBe("audit_denied");
      expect(caps.decide).toHaveBeenCalledOnce(); expect(caps.settle).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });

  it("checks the shared overall deadline even when individual dependencies each finish within one second", async () => {
    let current = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => current);
    const caps = capabilities(); const decide = caps.decide;
    const { session } = setup({ authorize: async () => { current += 999; return true; },
      reserve: async () => { current += 999; return { reservationId: "reserved", estimatedUsd: 0.25 }; },
      audit: async () => { current += 999; return true; },
      decide: async (question) => { current += 1_005; return decide(question); },
    });
    try { expect((await session.failure(scope, "session expired")).outcome).toBe("unavailable"); }
    finally { now.mockRestore(); }
  });
});
