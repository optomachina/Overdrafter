// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { genericFictivEnvelope } from "../test-support/genericDispatchResponse";
import { fingerprintProviderDispatchEnvelope } from "./providerDispatchEnvelope";
import { ProviderDispatchAuthorizationError } from "./providerDispatchPreflight";
import type { ProviderDispatchAuthorization, ProviderDispatchEnvelope } from "./providerDispatchTypes";
import {
  createProviderAuthorizationConsumer,
  ProviderExecutionTerminalError,
  PROVIDER_EXECUTION_TERMINAL_OUTCOMES,
  type ProviderExecutionTerminalOutcome,
} from "./providerExecutionSeam";
import { validateProviderResult } from "./providerResultValidation";
import {
  createProviderDaySwitch,
  decideProviderTaskRetry,
  PROVIDER_TASK_MAX_ADAPTER_REQUEUES,
  runProviderTaskPipeline,
  type ProviderTaskLeaseContext,
  type ProviderTaskLeasePort,
  type ProviderTaskLeaseRunResult,
  type ProviderTaskOutcome,
  type ProviderTaskPipelineDeps,
  type ProviderTaskPipelineInput,
} from "./providerTaskPipeline";
import { VendorAutomationError, type VendorQuoteAdapterInput, type VendorQuoteAdapterOutput } from "./types";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const CAD = new TextEncoder().encode("step-bytes");
const DRAWING = new TextEncoder().encode("pdf-bytes");
const NOW = Date.parse("2026-10-03T12:05:00.000Z");

function envelopeFor(change: (envelope: ProviderDispatchEnvelope) => void = () => {}): ProviderDispatchEnvelope {
  const base = genericFictivEnvelope();
  const outbound = (role: "cad" | "drawing", bytes: Uint8Array) => ({
    role,
    sourceSha256: sha(bytes),
    sha256: sha(bytes),
    derivation: "identity" as const,
  });
  const envelope: ProviderDispatchEnvelope = {
    ...base,
    sourceFiles: [
      { role: "cad", fileId: base.sourceFiles[0].fileId, sha256: sha(CAD) },
      { role: "drawing", fileId: base.sourceFiles[1].fileId, sha256: sha(DRAWING) },
    ],
    outboundFiles: [outbound("cad", CAD), outbound("drawing", DRAWING)],
  };
  change(envelope);
  return envelope;
}

function authorizationFor(envelope = envelopeFor()): ProviderDispatchAuthorization {
  return {
    permitId: envelope.permit.permitId,
    provider: envelope.provider,
    envelopeFingerprint: fingerprintProviderDispatchEnvelope(envelope),
    expiresAt: envelope.expiresAt,
    sessionBindingId: envelope.sessionBindingId,
    envelope,
  };
}

const ENVELOPE = envelopeFor();

function input(change: (value: ProviderTaskPipelineInput) => void = () => {}): ProviderTaskPipelineInput {
  const value: ProviderTaskPipelineInput = {
    task: {
      id: ENVELOPE.task.workQueueTaskId,
      attempts: 1,
      organizationId: ENVELOPE.subject.organizationId,
      quoteRunId: ENVELOPE.task.quoteRunId,
    },
    claim: {
      workQueueTaskId: ENVELOPE.task.workQueueTaskId,
      vendorQuoteResultId: ENVELOPE.task.vendorQuoteResultId,
      provider: "fictiv",
      permitId: ENVELOPE.permit.permitId,
      envelopeFingerprint: fingerprintProviderDispatchEnvelope(ENVELOPE),
    },
    requestedQuantity: ENVELOPE.scope.requestedQuantity,
    environment: "test",
    adapterRevision: "fictiv@test",
    leaseSetting: "off",
    quoteInput: {
      organizationId: ENVELOPE.subject.organizationId,
      quoteRunId: ENVELOPE.task.quoteRunId,
      stagedCadFile: { originalName: "part.step", localPath: "/tmp/part.step", storageBucket: "b", storagePath: "p" },
      stagedDrawingFile: { originalName: "part.pdf", localPath: "/tmp/part.pdf", storageBucket: "b", storagePath: "q" },
      requestedQuantity: ENVELOPE.scope.requestedQuantity,
    } as unknown as VendorQuoteAdapterInput,
  };
  change(value);
  return value;
}

function quoteOutput(change: Partial<VendorQuoteAdapterOutput> = {}): VendorQuoteAdapterOutput {
  return {
    vendor: "fictiv",
    status: "instant_quote_received",
    unitPriceUsd: 12,
    totalPriceUsd: 12,
    leadTimeBusinessDays: 8,
    quoteUrl: "https://app.fictiv.com/quotes/abc",
    dfmIssues: [],
    notes: [],
    artifacts: [],
    rawPayload: { source: "fictiv-live-adapter", requestedQuantity: 1 },
    ...change,
  };
}

type Calls = string[];

function harness(options: {
  calls?: Calls;
  authorize?: () => Promise<ProviderDispatchAuthorization>;
  quote?: (input: VendorQuoteAdapterInput) => Promise<VendorQuoteAdapterOutput>;
  persist?: ProviderTaskPipelineDeps["persist"];
  lease?: ProviderTaskLeasePort | null;
  adapterProvider?: "fictiv" | "weerg";
  noAdapter?: boolean;
  files?: { role: "cad" | "drawing"; bytes: Uint8Array }[];
  lane?: Partial<{ laneId: string; quoteRequestId: string; quoteRunId: string; vendorQuoteResultId: string; scopeFingerprint: string }>;
  daySwitch?: ReturnType<typeof createProviderDaySwitch>;
  consumer?: ReturnType<typeof createProviderAuthorizationConsumer>;
} = {}) {
  const calls = options.calls ?? [];
  const quote = vi.fn(async (quoteInput: VendorQuoteAdapterInput) => {
    calls.push("adapter");
    return options.quote ? options.quote(quoteInput) : quoteOutput();
  });
  const persist = vi.fn(async (output: VendorQuoteAdapterOutput) => {
    calls.push("persist");
    return options.persist ? options.persist(output) : { artifactCount: 0 };
  });
  const validate = vi.fn((...args: Parameters<typeof validateProviderResult>) => {
    calls.push("validate");
    return validateProviderResult(...args);
  });
  const deps: ProviderTaskPipelineDeps = {
    readLane: vi.fn(async () => {
      calls.push("lane");
      return {
        laneId: ENVELOPE.task.quoteRequestLaneId,
        quoteRequestId: ENVELOPE.task.quoteRequestId,
        quoteRunId: ENVELOPE.task.quoteRunId,
        vendorQuoteResultId: ENVELOPE.task.vendorQuoteResultId,
        scopeFingerprint: ENVELOPE.scope.fingerprint,
        ...options.lane,
      };
    }),
    authorize: vi.fn(async () => {
      calls.push("authorize");
      return options.authorize ? options.authorize() : authorizationFor();
    }),
    readCapturedFiles: vi.fn(async () => {
      calls.push("verify_bytes");
      return (
        options.files ?? [
          { role: "cad" as const, bytes: Uint8Array.from(CAD) },
          { role: "drawing" as const, bytes: Uint8Array.from(DRAWING) },
        ]
      );
    }),
    adapter: options.noAdapter ? null : { provider: options.adapterProvider ?? "fictiv", quote },
    persist,
    lease: options.lease ?? null,
    daySwitch: options.daySwitch ?? createProviderDaySwitch(),
    consumer: options.consumer ?? createProviderAuthorizationConsumer(),
    validate,
    now: () => NOW,
    log: () => {},
  };
  return { deps, calls, quote, persist, validate };
}

// Mirrors OVD-462 runWithLease (PR #675 at 42d5cc6): recognizes only its own
// outcome error class, blocks the binding on it, and releases on every other exit.
class FakeLeaseOutcomeError extends Error {
  constructor(readonly outcome: string) {
    super("lease outcome");
    this.name = "ProviderSessionOutcomeError";
  }
}
const LEASE_OUTCOMES: Record<ProviderExecutionTerminalOutcome, string> = {
  login_required: "login_required",
  challenge_required: "challenge_required",
  blocked: "provider_blocked",
  banned: "account_banned",
};

function fakeLease(
  calls: Calls,
  options: { acquire?: Exclude<ProviderTaskLeaseRunResult<never>, { kind: "completed" | "lease_lost" }>; loseBeforePersist?: boolean } = {},
) {
  let blocked: string | null = null;
  const released = vi.fn();
  const port: ProviderTaskLeasePort = {
    identity: (provider, environment) => ({
      provider,
      environment,
      accountRef: "acct_" + "a".repeat(32),
      sessionBindingRef: "sb_" + "1".repeat(32),
    }),
    toLeaseError: (outcome) => new FakeLeaseOutcomeError(LEASE_OUTCOMES[outcome]),
    async runWithLease<T>(
      _request: unknown,
      operation: (context: ProviderTaskLeaseContext) => Promise<T>,
    ): Promise<ProviderTaskLeaseRunResult<T>> {
      calls.push("lease_acquire");
      if (options.acquire) return options.acquire;
      if (blocked) return { kind: "manual_follow_up", outcome: blocked };
      let held = true;
      const controller = new AbortController();
      const context: ProviderTaskLeaseContext = {
        signal: controller.signal,
        assertHeld: () => {
          if (options.loseBeforePersist && calls.includes("validate")) held = false;
          if (!held) throw new Error("lease lost");
        },
      };
      try {
        const value = await operation(context);
        calls.push("lease_release");
        released();
        if (!held) return { kind: "lease_lost", outcome: "lease_lost" };
        return { kind: "completed", value };
      } catch (error) {
        if (error instanceof FakeLeaseOutcomeError) {
          blocked = error.outcome;
          calls.push("lease_block");
          return { kind: "manual_follow_up", outcome: error.outcome };
        }
        calls.push("lease_release");
        released();
        throw error;
      }
    },
  };
  return { port, released, isBlocked: () => blocked };
}

function expectNoAdapter(outcome: ProviderTaskOutcome, quote: ReturnType<typeof vi.fn>) {
  expect(quote).not.toHaveBeenCalled();
  expect(outcome.adapterStarted).toBe(false);
  expect(outcome.disposition).not.toBe("persisted");
}

describe("ordered pipeline", () => {
  it("runs lane, authorization, byte check, adapter, validation and persistence in order with the lease setting off", async () => {
    const h = harness();
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({ disposition: "persisted", adapterStarted: true, retryAt: null });
    expect(h.calls).toEqual(["lane", "authorize", "verify_bytes", "adapter", "validate", "persist"]);
    expect(h.quote).toHaveBeenCalledTimes(1);
    expect(h.quote.mock.calls[0][0].providerDispatchAuthorization?.permitId).toBe(ENVELOPE.permit.permitId);
  });

  it("acquires the lease after the byte check and releases it after persistence when the setting is on", async () => {
    const calls: Calls = [];
    const lease = fakeLease(calls);
    const h = harness({ calls, lease: lease.port });
    const outcome = await runProviderTaskPipeline(input((v) => (v.leaseSetting = "on")), h.deps);
    expect(outcome.disposition).toBe("persisted");
    expect(calls).toEqual(["lane", "authorize", "verify_bytes", "lease_acquire", "adapter", "validate", "persist", "lease_release"]);
  });

  it("never touches a lease port while the setting is off", async () => {
    const calls: Calls = [];
    const lease = fakeLease(calls);
    const spy = vi.spyOn(lease.port, "runWithLease");
    const h = harness({ calls, lease: lease.port });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome.disposition).toBe("persisted");
    expect(spy).not.toHaveBeenCalled();
  });

  it("persists only the validated result: credential like keys and unknown offer keys never reach persistence", async () => {
    const h = harness({
      quote: async () =>
        quoteOutput({
          rawPayload: { source: "fictiv-live-adapter", requestedQuantity: 1, html: "<html>bulk</html>" },
        }),
    });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome.disposition).toBe("persisted");
    const persisted = h.persist.mock.calls[0][0];
    expect(persisted.rawPayload.html).toBeUndefined();
    expect(persisted.rawPayload.providerResultContract).toBe("ovd-463.provider-result.v1");
  });

  it("hands the adapter only the authorized file roles", async () => {
    const envelope = envelopeFor((e) => {
      e.sourceFiles = e.sourceFiles.slice(0, 1);
      e.outboundFiles = e.outboundFiles.slice(0, 1);
    });
    const h = harness({ authorize: async () => authorizationFor(envelope), files: [{ role: "cad", bytes: Uint8Array.from(CAD) }] });
    const outcome = await runProviderTaskPipeline(
      input((v) => (v.claim.envelopeFingerprint = fingerprintProviderDispatchEnvelope(envelope))),
      h.deps,
    );
    // Package identity differs from ENVELOPE, but the binding is to this envelope.
    expect(outcome.disposition).toBe("persisted");
    expect(h.deps.readCapturedFiles).toHaveBeenCalledWith(["cad"]);
    expect(h.quote.mock.calls[0][0].stagedDrawingFile).toBeNull();
    expect(h.quote.mock.calls[0][0].stagedCadFile).not.toBeNull();
  });
});

describe("denial matrix: zero adapter calls and a finite visible state", () => {
  const authorizationDenial = (denial: ConstructorParameters<typeof ProviderDispatchAuthorizationError>[0]) => async () => {
    throw new ProviderDispatchAuthorizationError(denial);
  };

  const cases: [string, () => { h: ReturnType<typeof harness>; value: ProviderTaskPipelineInput }, ProviderTaskOutcome["disposition"], string][] = [
    ["unknown provider", () => ({ h: harness(), value: input((v) => (v.claim.provider = "sendcutsend")) }), "manual_follow_up", "provider_envelope_unknown"],
    ["xometry on the generic route", () => ({ h: harness(), value: input((v) => (v.claim.provider = "xometry")) }), "failed", "execution_request_malformed"],
    ["adapter not registered", () => ({ h: harness({ noAdapter: true }), value: input() }), "manual_follow_up", "adapter_not_enabled"],
    ["adapter for another provider", () => ({ h: harness({ adapterProvider: "weerg" }), value: input() }), "manual_follow_up", "adapter_not_enabled"],
    ["lease on without a lease", () => ({ h: harness(), value: input((v) => (v.leaseSetting = "on")) }), "manual_follow_up", "session_lease_unavailable"],
    ["unknown lease setting", () => ({ h: harness(), value: input((v) => ((v as { leaseSetting: string }).leaseSetting = "maybe")) }), "failed", "lease_setting_invalid"],
    ["bad environment", () => ({ h: harness(), value: input((v) => ((v as { environment: string }).environment = "prod")) }), "failed", "execution_request_malformed"],
    ["lane unreadable", () => {
      const h = harness();
      h.deps.readLane = async () => { throw new Error("db"); };
      return { h, value: input() };
    }, "failed", "lane_unavailable"],
    ["lane for another result", () => ({ h: harness({ lane: { vendorQuoteResultId: "00000000-0000-4000-8000-0000000000ff" } }), value: input() }), "failed", "lane_mismatch"],
    ["preflight unavailable", () => ({ h: harness({ authorize: authorizationDenial("preflight_unavailable") }), value: input() }), "requeue", "preflight_unavailable"],
    ["preflight rejected", () => ({ h: harness({ authorize: authorizationDenial("preflight_rejected") }), value: input() }), "manual_follow_up", "preflight_rejected"],
    ["permit expired", () => ({ h: harness({ authorize: authorizationDenial("permit_expired") }), value: input() }), "manual_follow_up", "permit_expired"],
    ["permit revoked", () => ({ h: harness({ authorize: authorizationDenial("permit_revoked") }), value: input() }), "manual_follow_up", "permit_revoked"],
    ["capability denied", () => ({ h: harness({ authorize: authorizationDenial("provider_not_admitted") }), value: input() }), "manual_follow_up", "provider_not_admitted"],
    ["unknown envelope", () => ({ h: harness({ authorize: authorizationDenial("provider_envelope_unknown") }), value: input() }), "manual_follow_up", "provider_envelope_unknown"],
    ["unknown authorization error", () => ({ h: harness({ authorize: async () => { throw new Error("boom"); } }), value: input() }), "failed", "authorization_failed"],
    ["malformed authorization", () => ({ h: harness({ authorize: async () => ({}) as ProviderDispatchAuthorization }), value: input() }), "failed", "authorization_malformed"],
    ["captured bytes changed", () => ({ h: harness({ files: [{ role: "cad", bytes: new Uint8Array([1]) }, { role: "drawing", bytes: Uint8Array.from(DRAWING) }] }), value: input() }), "manual_follow_up", "captured_file_mismatch"],
    ["captured file missing", () => ({ h: harness({ files: [{ role: "cad", bytes: Uint8Array.from(CAD) }] }), value: input() }), "manual_follow_up", "captured_file_mismatch"],
    ["staged file unreadable", () => {
      const h = harness();
      h.deps.readCapturedFiles = async () => { throw new Error("enoent"); };
      return { h, value: input() };
    }, "failed", "captured_file_unreadable"],
    ["authorization for another task", () => ({ h: harness({ authorize: async () => authorizationFor(envelopeFor((e) => (e.task = { ...e.task, workQueueTaskId: "00000000-0000-4000-8000-0000000000aa" }))) }), value: input() }), "manual_follow_up", "permit_mismatch"],
    ["authorization for another organization", () => ({ h: harness(), value: input((v) => (v.task.organizationId = "00000000-0000-4000-8000-0000000000bb")) }), "manual_follow_up", "organization_mismatch"],
    ["scope mismatch", () => ({ h: harness({ lane: { scopeFingerprint: "d".repeat(64) } }), value: input() }), "manual_follow_up", "scope_mismatch"],
    ["claimed permit differs", () => ({ h: harness(), value: input((v) => (v.claim.envelopeFingerprint = "e".repeat(64))) }), "manual_follow_up", "permit_mismatch"],
  ];

  it.each(cases)("%s", async (_name, setup, disposition, code) => {
    const { h, value } = setup();
    const outcome = await runProviderTaskPipeline(value, h.deps);
    expectNoAdapter(outcome, h.quote);
    expect(h.persist).not.toHaveBeenCalled();
    expect(outcome.disposition).toBe(disposition);
    expect(outcome.code).toBe(code);
  });

  it.each([
    [{ kind: "contended", retryAfterMs: 10 } as const, "requeue", "lease_contended"],
    [{ kind: "unavailable" } as const, "requeue", "lease_unavailable"],
    [{ kind: "manual_follow_up", outcome: "owner_revoked" } as const, "manual_follow_up", "owner_revoked"],
    [{ kind: "rejected", reason: "binding_mismatch" } as const, "manual_follow_up", "lease_rejected"],
  ])("lease denial %o", async (acquire, disposition, code) => {
    const calls: Calls = [];
    const lease = fakeLease(calls, { acquire });
    const h = harness({ calls, lease: lease.port });
    const outcome = await runProviderTaskPipeline(input((v) => (v.leaseSetting = "on")), h.deps);
    expectNoAdapter(outcome, h.quote);
    expect(outcome).toMatchObject({ disposition, code });
  });

  it("fails closed on a malformed lease result", async () => {
    const calls: Calls = [];
    const lease = fakeLease(calls);
    lease.port.runWithLease = (async () => ({ kind: "surprise" })) as unknown as ProviderTaskLeasePort["runWithLease"];
    const h = harness({ calls, lease: lease.port });
    const outcome = await runProviderTaskPipeline(input((v) => (v.leaseSetting = "on")), h.deps);
    expectNoAdapter(outcome, h.quote);
    expect(outcome).toMatchObject({ disposition: "failed", code: "lease_result_malformed" });
  });

  it("refuses a replay of the same claim in this process", async () => {
    const consumer = createProviderAuthorizationConsumer();
    const first = harness({ consumer });
    expect((await runProviderTaskPipeline(input(), first.deps)).disposition).toBe("persisted");
    const second = harness({ consumer });
    const outcome = await runProviderTaskPipeline(input(), second.deps);
    expectNoAdapter(outcome, second.quote);
    expect(outcome).toMatchObject({ disposition: "manual_follow_up", code: "authorization_replayed" });
  });

  it("refuses a provider switched off for the day", async () => {
    const daySwitch = createProviderDaySwitch();
    daySwitch.disable("fictiv", NOW);
    const h = harness({ daySwitch });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expectNoAdapter(outcome, h.quote);
    expect(outcome).toMatchObject({ disposition: "manual_follow_up", code: "provider_disabled" });
    expect(h.deps.authorize).not.toHaveBeenCalled();
  });
});

describe("retry authority", () => {
  it("allows one requeue after an adapter start, only from the first database claim", () => {
    expect(PROVIDER_TASK_MAX_ADAPTER_REQUEUES).toBe(1);
    const now = new Date(NOW);
    expect(decideProviderTaskRetry({ failureClass: "post_start_bounded", attempts: 1, now })).toEqual({
      action: "requeue",
      retryAt: new Date(NOW + 60_000).toISOString(),
    });
    for (const attempts of [2, 3, 4, 0, -1, Number.NaN]) {
      expect(decideProviderTaskRetry({ failureClass: "post_start_bounded", attempts, now })).toEqual({ action: "fail" });
    }
    expect(decideProviderTaskRetry({ failureClass: "post_start_bounded", attempts: 1, retryBudget: 0, now })).toEqual({ action: "fail" });
    expect(decideProviderTaskRetry({ failureClass: "post_start_bounded", attempts: 1, retryBudget: 5, now }).action).toBe("requeue");
  });

  it("keeps pre dispatch transients finite", () => {
    const now = new Date(NOW);
    expect(decideProviderTaskRetry({ failureClass: "pre_dispatch_transient", attempts: 3, now }).action).toBe("requeue");
    expect(decideProviderTaskRetry({ failureClass: "pre_dispatch_transient", attempts: 4, now })).toEqual({ action: "fail" });
    expect(decideProviderTaskRetry({ failureClass: "manual_follow_up", attempts: 1, now })).toEqual({ action: "manual_follow_up" });
    expect(decideProviderTaskRetry({ failureClass: "failed", attempts: 1, now })).toEqual({ action: "fail" });
  });

  it("requeues an adapter failure once and then stops (retry exhaustion)", async () => {
    const consumer = createProviderAuthorizationConsumer();
    const failing = async () => {
      throw new VendorAutomationError("nav", "navigation_failure");
    };
    const first = harness({ consumer, quote: failing });
    const one = await runProviderTaskPipeline(input(), first.deps);
    expect(one).toMatchObject({ disposition: "requeue", code: "adapter_failed", adapterStarted: true });
    // The requeued task is a new database claim (attempts 2): it may start once more, then it is final.
    const second = harness({ consumer, quote: failing });
    const two = await runProviderTaskPipeline(input((v) => (v.task.attempts = 2)), second.deps);
    expect(two).toMatchObject({ disposition: "failed", code: "adapter_failed", retryAt: null });
    expect(first.quote).toHaveBeenCalledTimes(1);
    expect(second.quote).toHaveBeenCalledTimes(1);
  });

  it("never requeues an adapter failure on a claim that followed a pre dispatch requeue", async () => {
    const h = harness({ quote: async () => { throw new Error("crash"); } });
    const outcome = await runProviderTaskPipeline(input((v) => (v.task.attempts = 2)), h.deps);
    expect(outcome).toMatchObject({ disposition: "failed", code: "adapter_failed" });
  });

  it.each(PROVIDER_EXECUTION_TERMINAL_OUTCOMES)("never requeues the terminal outcome %s", async (terminal) => {
    const daySwitch = createProviderDaySwitch();
    const h = harness({ daySwitch, quote: async () => { throw new ProviderExecutionTerminalError(terminal); } });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome.disposition).toBe("manual_follow_up");
    expect(outcome.retryAt).toBeNull();
    expect(outcome.code).toBe(LEASE_OUTCOMES[terminal]);
    const blocksDay = terminal === "blocked" || terminal === "banned";
    expect(outcome.providerDisabledForDay).toBe(blocksDay);
    expect(daySwitch.isDisabled("fictiv", NOW)).toBe(blocksDay);
    expect(daySwitch.isDisabled("weerg", NOW)).toBe(false);
  });

  it("maps a CAPTCHA to a challenge and never retries it", async () => {
    const h = harness({ quote: async () => { throw new VendorAutomationError("captcha", "captcha"); } });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({ disposition: "manual_follow_up", code: "challenge_required", retryAt: null });
  });

  it("turns the provider off until the next UTC midnight after a block, and the next task makes no adapter call", async () => {
    const daySwitch = createProviderDaySwitch();
    const consumer = createProviderAuthorizationConsumer();
    const blocked = harness({ daySwitch, consumer, quote: async () => { throw new ProviderExecutionTerminalError("blocked"); } });
    await runProviderTaskPipeline(input(), blocked.deps);
    const next = harness({ daySwitch, consumer });
    const outcome = await runProviderTaskPipeline(input((v) => (v.task.attempts = 1)), next.deps);
    expectNoAdapter(outcome, next.quote);
    expect(outcome.code).toBe("provider_disabled");
    expect(daySwitch.isDisabled("fictiv", Date.parse("2026-10-03T23:59:59.999Z"))).toBe(true);
    expect(daySwitch.isDisabled("fictiv", Date.parse("2026-10-04T00:00:00.000Z"))).toBe(false);
  });

  it("applies the validator per code budget: bounded codes requeue once, others never", async () => {
    const empty = async () => quoteOutput({ status: "instant_quote_received", unitPriceUsd: null, totalPriceUsd: null, offers: [] });
    const first = harness({ quote: empty });
    const bounded = await runProviderTaskPipeline(input(), first.deps);
    expect(bounded).toMatchObject({ disposition: "requeue", stage: "validate" });
    expect(bounded.rejection?.retry).toBe("bounded");
    expect(first.persist).not.toHaveBeenCalled();

    const again = harness({ quote: empty });
    const exhausted = await runProviderTaskPipeline(input((v) => (v.task.attempts = 2)), again.deps);
    expect(exhausted).toMatchObject({ disposition: "failed", stage: "validate" });

    const offDomain = harness({ quote: async () => quoteOutput({ quoteUrl: "https://evil.example.com/q" }) });
    const refused = await runProviderTaskPipeline(input(), offDomain.deps);
    expect(refused.disposition).not.toBe("requeue");
    expect(refused.disposition).not.toBe("persisted");
    expect(offDomain.persist).not.toHaveBeenCalled();
  });

  it("binds the candidate to worker state, so a result for another quantity is refused", async () => {
    const h = harness();
    const outcome = await runProviderTaskPipeline(input((v) => (v.requestedQuantity = 2)), h.deps);
    // The seam already refuses the scope mismatch before the adapter runs.
    expectNoAdapter(outcome, h.quote);
    expect(outcome.code).toBe("scope_mismatch");
  });

  it("refuses a result whose binding differs from the authorization (adapter revision missing)", async () => {
    const h = harness();
    const outcome = await runProviderTaskPipeline(input((v) => (v.adapterRevision = "")), h.deps);
    expect(outcome).toMatchObject({ stage: "validate", disposition: "manual_follow_up", code: "malformed_candidate" });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("fails closed when the validator throws or answers malformed", async () => {
    for (const validate of [
      () => {
        throw new TypeError("bad");
      },
      () => ({}) as ReturnType<typeof validateProviderResult>,
    ]) {
      const h = harness();
      h.deps.validate = validate;
      const outcome = await runProviderTaskPipeline(input(), h.deps);
      expect(outcome).toMatchObject({ disposition: "failed", code: "result_validation_failed" });
      expect(h.persist).not.toHaveBeenCalled();
    }
  });
});

describe("persistence and cleanup", () => {
  it("never requeues when persistence fails after the adapter ran (partial persistence injection)", async () => {
    const h = harness({
      persist: async () => {
        throw new VendorAutomationError("rpc", "persistence_failure");
      },
    });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({ disposition: "failed", code: "persistence_failure", stage: "persist", adapterStarted: true });
    expect(h.quote).toHaveBeenCalledTimes(1);
  });

  it("releases the lease when persistence fails", async () => {
    const calls: Calls = [];
    const lease = fakeLease(calls);
    const h = harness({ calls, lease: lease.port, persist: async () => { throw new Error("db"); } });
    const outcome = await runProviderTaskPipeline(input((v) => (v.leaseSetting = "on")), h.deps);
    expect(outcome.code).toBe("persistence_failure");
    expect(lease.released).toHaveBeenCalledTimes(1);
  });

  it("releases the lease when the adapter throws", async () => {
    const calls: Calls = [];
    const lease = fakeLease(calls);
    const h = harness({ calls, lease: lease.port, quote: async () => { throw new Error("crash"); } });
    const outcome = await runProviderTaskPipeline(input((v) => (v.leaseSetting = "on")), h.deps);
    expect(outcome).toMatchObject({ disposition: "requeue", code: "adapter_failed" });
    expect(lease.released).toHaveBeenCalledTimes(1);
  });

  it("does not persist after the lease is lost", async () => {
    const calls: Calls = [];
    const lease = fakeLease(calls, { loseBeforePersist: true });
    const h = harness({ calls, lease: lease.port });
    const outcome = await runProviderTaskPipeline(input((v) => (v.leaseSetting = "on")), h.deps);
    expect(outcome).toMatchObject({ disposition: "failed", code: "lease_lost", adapterStarted: true });
    expect(h.persist).not.toHaveBeenCalled();
    expect(lease.released).toHaveBeenCalledTimes(1);
  });

  it("blocks the binding through the lease for every terminal outcome, including one matched by name", async () => {
    for (const terminal of PROVIDER_EXECUTION_TERMINAL_OUTCOMES) {
      const calls: Calls = [];
      const lease = fakeLease(calls);
      const h = harness({ calls, lease: lease.port, quote: async () => { throw new ProviderExecutionTerminalError(terminal); } });
      const outcome = await runProviderTaskPipeline(input((v) => (v.leaseSetting = "on")), h.deps);
      expect(outcome).toMatchObject({ disposition: "manual_follow_up", code: LEASE_OUTCOMES[terminal] });
      expect(lease.isBlocked()).toBe(LEASE_OUTCOMES[terminal]);
    }
    const calls: Calls = [];
    const lease = fakeLease(calls);
    const lookalike = Object.assign(new Error("x"), { name: "ProviderSessionOutcomeError", outcome: "account_banned" });
    const h = harness({ calls, lease: lease.port, quote: async () => { throw lookalike; } });
    const outcome = await runProviderTaskPipeline(input((v) => (v.leaseSetting = "on")), h.deps);
    expect(outcome).toMatchObject({ disposition: "manual_follow_up", code: "account_banned", providerDisabledForDay: true });
    expect(lease.isBlocked()).toBe("account_banned");
  });

  it("fails closed without retry when the lease itself throws", async () => {
    const calls: Calls = [];
    const lease = fakeLease(calls);
    lease.port.runWithLease = async () => {
      throw new Error("store down");
    };
    const h = harness({ calls, lease: lease.port });
    const outcome = await runProviderTaskPipeline(input((v) => (v.leaseSetting = "on")), h.deps);
    expect(outcome).toMatchObject({ disposition: "failed", code: "lease_error" });
  });
});
