// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { genericFictivEnvelope } from "../test-support/genericDispatchResponse";
import { fingerprintProviderDispatchEnvelope } from "./providerDispatchEnvelope";
import { ProviderDispatchAuthorizationError } from "./providerDispatchPreflight";
import { ProviderAbortedError } from "./providerAbort";
import { ProviderKillSwitchError } from "./providerKillSwitch";
import { createProviderSessionLeaseManager } from "./providerSessionLease";
import { createProviderSessionLeaseMemoryStore } from "./providerSessionLeaseMemoryStore";
import type { ProviderDispatchAuthorization, ProviderDispatchEnvelope } from "./providerDispatchTypes";
import {
  createProviderAuthorizationConsumer,
  ProviderExecutionTerminalError,
  PROVIDER_EXECUTION_TERMINAL_OUTCOMES,
  type ProviderExecutionTerminalOutcome,
} from "./providerExecutionSeam";
import { validateProviderResult } from "./providerResultValidation";
import { preserveDerivedValiditySource, providerTaskFailureRecord, providerTaskOutcomeNote } from "./providerTaskRoute";
import {
  createProviderMutationPhase,
  markProviderMutationStarted,
  runInProviderMutationPhase,
} from "./providerMutationPhase";
import {
  createProviderDaySwitch,
  decideProviderTaskRetry,
  deriveProviderResultValidUntil,
  isPersistableSortRank,
  MAX_PERSISTED_SORT_RANK,
  PROVIDER_RESULT_VALID_UNTIL_DERIVED,
  PROVIDER_TASK_MAX_CLAIMS,
  PROVIDER_TASK_MAX_ADAPTER_REQUEUES,
  runProviderTaskPipeline,
  type ProviderTaskLeaseContext,
  type ProviderTaskLeasePort,
  type ProviderTaskLeaseRunResult,
  type ProviderTaskOutcome,
  type ProviderTaskPipelineDeps,
  type ProviderTaskPipelineInput,
} from "./providerTaskPipeline";
import {
  VendorAutomationError,
  type VendorAutomationErrorCode,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOffer,
  type VendorQuoteAdapterOutput,
} from "./types";

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
  const persist = vi.fn(async (output: VendorQuoteAdapterOutput, metadata: { offerCount: number }) => {
    calls.push("persist");
    return options.persist ? options.persist(output, metadata) : { artifactCount: 0, acceptance: { outcome: "accepted" as const } };
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
  options: {
    acquire?: Exclude<ProviderTaskLeaseRunResult<never>, { kind: "completed" | "lease_lost" }>;
    loseBeforePersist?: boolean;
    onContext?: (controller: AbortController) => void;
  } = {},
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
      options.onContext?.(controller);
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
      input((v) => {
        v.claim.envelopeFingerprint = fingerprintProviderDispatchEnvelope(envelope);
        v.quoteInput = { ...v.quoteInput, cadFile: { id: "cad" }, drawingFile: { id: "drawing" } } as unknown as VendorQuoteAdapterInput;
      }),
      h.deps,
    );
    // Package identity differs from ENVELOPE, but the binding is to this envelope.
    expect(outcome.disposition).toBe("persisted");
    expect(h.deps.readCapturedFiles).toHaveBeenCalledWith(["cad"]);
    expect(h.quote.mock.calls[0][0].stagedDrawingFile).toBeNull();
    expect(h.quote.mock.calls[0][0].stagedCadFile).not.toBeNull();
    // Metadata follows the same roles, so a kernel never sees a drawing it may not upload.
    expect(h.quote.mock.calls[0][0].drawingFile).toBeNull();
    expect(h.quote.mock.calls[0][0].cadFile).toEqual({ id: "cad" });
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
    expect(decideProviderTaskRetry({ failureClass: "pre_dispatch_transient", attempts: 1, now }).action).toBe("requeue");
    // The next claim would be past PROVIDER_TASK_MAX_CLAIMS, so requeueing it would only settle it later.
    expect(decideProviderTaskRetry({ failureClass: "pre_dispatch_transient", attempts: 2, now })).toEqual({ action: "fail" });
    expect(decideProviderTaskRetry({ failureClass: "pre_dispatch_transient", attempts: 4, now })).toEqual({ action: "fail" });
    expect(decideProviderTaskRetry({ failureClass: "manual_follow_up", attempts: 1, now })).toEqual({ action: "manual_follow_up" });
    expect(decideProviderTaskRetry({ failureClass: "failed", attempts: 1, now })).toEqual({ action: "fail" });
  });

  it("settles a pre mutation transient adapter failure for an operator instead of requeueing (fail closed until OVD-734)", async () => {
    const failing = async () => {
      throw new VendorAutomationError("nav", "navigation_failure");
    };
    const first = harness({ quote: failing });
    const one = await runProviderTaskPipeline(input(), first.deps);
    expect(one).toMatchObject({ disposition: "manual_follow_up", code: "adapter_failed", adapterStarted: true, retryAt: null });
    expect(first.quote).toHaveBeenCalledTimes(1);
    const record = providerTaskFailureRecord("fictiv", one, { retryCount: 0, requestedQuantity: 2 });
    expect(record.status).toBe("manual_vendor_followup");
    expect(record.raw_payload).toMatchObject({ adapterStarted: true, providerMutationPossible: true, retryScheduledFor: null });
  });

  it("never leaves a same process retry that could only end authorization_replayed", async () => {
    const consumer = createProviderAuthorizationConsumer();
    const quote = vi.fn(async () => {
      throw new VendorAutomationError("nav", "navigation_failure");
    });
    const first = harness({ consumer, quote });
    const one = await runProviderTaskPipeline(input(), first.deps);
    // Not requeued, so no later claim can overwrite this lane's adapterStarted true with false.
    expect(one).toMatchObject({ disposition: "manual_follow_up", code: "adapter_failed", adapterStarted: true, retryAt: null });
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it("calls the adapter exactly once across two claims when the first failure follows a provider mutation", async () => {
    const consumer = createProviderAuthorizationConsumer();
    const quote = vi.fn(async () => {
      markProviderMutationStarted();
      throw new VendorAutomationError("nav", "navigation_failure");
    });
    const first = harness({ consumer, quote });
    const one = await runProviderTaskPipeline(input(), first.deps);
    expect(one).toMatchObject({ disposition: "manual_follow_up", code: "adapter_failed_after_mutation", retryAt: null });
    // Even if the task were claimed again, the permit cannot dispatch a second time here.
    const second = harness({ consumer, quote });
    const two = await runProviderTaskPipeline(input((v) => (v.task.attempts = 2)), second.deps);
    expect(two).toMatchObject({ disposition: "manual_follow_up", code: "authorization_replayed", adapterStarted: false });
    expect(quote).toHaveBeenCalledTimes(1);
  });

  describe("adapter failure disposition for every VendorAutomationErrorCode", () => {
    // Exhaustive by type: adding a code without a row fails the typecheck.
    const PRE_MUTATION: Record<VendorAutomationErrorCode, { disposition: ProviderTaskOutcome["disposition"]; code: string }> = {
      login_required: { disposition: "manual_follow_up", code: "login_required" },
      captcha: { disposition: "manual_follow_up", code: "challenge_required" },
      anti_detection_block: { disposition: "manual_follow_up", code: "challenge_required" },
      selector_failure: { disposition: "manual_follow_up", code: "adapter_selector_failure" },
      unexpected_ui_state: { disposition: "manual_follow_up", code: "adapter_unexpected_ui_state" },
      profile_in_use: { disposition: "manual_follow_up", code: "adapter_profile_in_use" },
      not_implemented: { disposition: "manual_follow_up", code: "adapter_not_implemented" },
      upload_failure: { disposition: "manual_follow_up", code: "adapter_failed" },
      navigation_failure: { disposition: "manual_follow_up", code: "adapter_failed" },
      persistence_failure: { disposition: "manual_follow_up", code: "adapter_failed" },
    };
    const TERMINAL = new Set<VendorAutomationErrorCode>(["login_required", "captcha", "anti_detection_block"]);
    const cases = (Object.keys(PRE_MUTATION) as VendorAutomationErrorCode[]).flatMap((code) =>
      [false, true].flatMap((mutationPossible) => [false, true].map((phaseStarted) => ({ code, mutationPossible, phaseStarted }))),
    );

    it.each(cases)("$code, providerMutationPossible $mutationPossible, phase started $phaseStarted", async ({ code, mutationPossible, phaseStarted }) => {
      const h = harness({
        quote: async () => {
          if (phaseStarted) markProviderMutationStarted();
          throw new VendorAutomationError("adapter text", code, mutationPossible ? { providerMutationPossible: true } : {});
        },
      });
      const outcome = await runProviderTaskPipeline(input(), h.deps);
      let expected = PRE_MUTATION[code];
      if (!TERMINAL.has(code) && (mutationPossible || phaseStarted)) {
        expected = { disposition: "manual_follow_up", code: "adapter_failed_after_mutation" };
      }
      expect(outcome).toMatchObject({ ...expected, stage: "adapter", adapterStarted: true });
      expect(outcome.retryAt === null).toBe(expected.disposition !== "requeue");
      expect(h.quote).toHaveBeenCalledTimes(1);
    });

    it("never requeues an upload failure for missing or unsupported input", async () => {
      for (const reason of ["missing_cad_file", "unsupported_file_type"]) {
        const h = harness({ quote: async () => { throw new VendorAutomationError("upload", "upload_failure", { reason }); } });
        expect(await runProviderTaskPipeline(input(), h.deps)).toMatchObject({ disposition: "manual_follow_up", code: "adapter_upload_failure" });
      }
    });

    it.each(["unsupported", "selector_drift"])("never requeues the deterministic terminal state %s", async (terminalState) => {
      const h = harness({ quote: async () => { throw new VendorAutomationError("stop", "navigation_failure", { terminalState }); } });
      expect(await runProviderTaskPipeline(input(), h.deps)).toMatchObject({
        disposition: "manual_follow_up",
        code: `adapter_${terminalState}`,
        retryAt: null,
      });
    });

    it("never requeues the portal kernel's ambiguous post upload mutation", async () => {
      const h = harness({
        quote: async () => {
          throw new VendorAutomationError("stop", "selector_failure", {
            terminalState: "selector_drift",
            reason: "ambiguous_provider_mutation",
            providerMutationPossible: true,
          });
        },
      });
      expect(await runProviderTaskPipeline(input(), h.deps)).toMatchObject({ disposition: "manual_follow_up", code: "adapter_failed_after_mutation" });
    });

    it.each([
      { name: "a plain crash", error: () => new Error("crash"), phaseStarted: false, expected: { disposition: "failed", code: "adapter_failed" } },
      { name: "a plain transient error", error: () => new Error("ECONNRESET"), phaseStarted: false, expected: { disposition: "manual_follow_up", code: "adapter_failed", retryAt: null } },
      { name: "a plain transient error after a mutation", error: () => new Error("ECONNRESET"), phaseStarted: true, expected: { disposition: "manual_follow_up", code: "adapter_failed_after_mutation" } },
      { name: "a non error value", error: () => "boom", phaseStarted: false, expected: { disposition: "failed", code: "adapter_failed" } },
    ])("classes $name", async ({ error, phaseStarted, expected }) => {
      const h = harness({
        quote: async () => {
          if (phaseStarted) markProviderMutationStarted();
          throw error();
        },
      });
      expect(await runProviderTaskPipeline(input(), h.deps)).toMatchObject(expected);
    });

    it("keeps the mutation phase to the adapter: onAdapterStart and the caller's phase never see it", async () => {
      const outer = createProviderMutationPhase();
      const h = harness({
        quote: async () => {
          markProviderMutationStarted();
          throw new VendorAutomationError("nav", "navigation_failure");
        },
      });
      const outcome = await runInProviderMutationPhase(outer, () => runProviderTaskPipeline(input(), h.deps));
      expect(outcome.code).toBe("adapter_failed_after_mutation");
      expect(outer.started).toBe(false);
    });

    it("keeps the adapter error and every failure artifact as evidence", async () => {
      const artifact = { kind: "json" as const, label: "state", localPath: "/tmp/evidence/a/state.json", contentType: "application/json" };
      const error = new VendorAutomationError("selector", "selector_failure", {}, [artifact]);
      const h = harness({ quote: async () => { throw error; } });
      const outcome = await runProviderTaskPipeline(input(), h.deps);
      expect(outcome.evidence.adapterError).toBe(error);
      expect(outcome.evidence.artifacts).toEqual([artifact]);
    });
  });

  it("never requeues an adapter failure on a claim that followed a pre dispatch requeue", async () => {
    const h = harness({ quote: async () => { throw new Error("ECONNRESET"); } });
    const outcome = await runProviderTaskPipeline(input((v) => (v.task.attempts = 2)), h.deps);
    expect(outcome).toMatchObject({ disposition: "manual_follow_up", code: "adapter_failed", retryAt: null });
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

  it("never requeues a validate stage stop after a completed adapter run, even a validator bounded code", async () => {
    const artifact = { kind: "json" as const, label: "page", localPath: "/tmp/evidence/b/page.json", contentType: "application/json" };
    const empty = async () =>
      quoteOutput({ status: "instant_quote_received", unitPriceUsd: null, totalPriceUsd: null, offers: [], artifacts: [artifact] });
    const first = harness({ quote: empty });
    const bounded = await runProviderTaskPipeline(input(), first.deps);
    // The provider already holds a quote, so an operator looks instead of a rerun.
    expect(bounded).toMatchObject({ disposition: "manual_follow_up", stage: "validate", retryAt: null, adapterStarted: true });
    expect(bounded.rejection?.retry).toBe("bounded");
    expect(bounded.evidence.artifacts).toEqual([artifact]);
    expect(first.persist).not.toHaveBeenCalled();

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

describe("provider kill switch (OVD-722)", () => {
  const engaged = (checkpoint: "before_launch" | "before_upload" | "before_configure") =>
    new ProviderKillSwitchError("provider_kill_switch_engaged", "fictiv", checkpoint);

  it("a server preflight denial for the switch ends cancelled_provider_disabled with zero adapter calls", async () => {
    const h = harness({
      authorize: async () => {
        throw new ProviderDispatchAuthorizationError("provider_kill_switch_engaged");
      },
    });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({
      disposition: "cancelled_provider_disabled",
      code: "cancelled_provider_disabled",
      stage: "authorize",
      adapterStarted: false,
      retryAt: null,
      killSwitch: { providerMutationPossible: false },
    });
    expect(outcome.killSwitch?.error.checkpoint).toBe("server_preflight");
    expect(h.quote).not.toHaveBeenCalled();
  });

  it("an engaged checkpoint before any mutation: cancelled, no mutation possible, never requeued", async () => {
    const h = harness({ quote: async () => { throw engaged("before_launch"); } });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({
      disposition: "cancelled_provider_disabled",
      stage: "adapter",
      retryAt: null,
      killSwitch: { providerMutationPossible: false },
    });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("a before_launch refusal records adapterStarted false on the outcome and the lane", async () => {
    const h = harness({ quote: async () => { throw engaged("before_launch"); } });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({ disposition: "cancelled_provider_disabled", adapterStarted: false });
    const record = providerTaskFailureRecord("fictiv", outcome, { retryCount: 0, requestedQuantity: 1 });
    expect(record.raw_payload).toMatchObject({
      adapterStarted: false,
      providerMutationPossible: false,
      killSwitchCheckpoint: "before_launch",
    });
  });

  it("an engaged checkpoint after the upload started: cancelled with providerMutationPossible, never manual or requeued", async () => {
    const h = harness({
      quote: async () => {
        markProviderMutationStarted();
        throw engaged("before_configure");
      },
    });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({ disposition: "cancelled_provider_disabled", retryAt: null, killSwitch: { providerMutationPossible: true } });
    expect(outcome.killSwitch?.error.checkpoint).toBe("before_configure");
    const record = providerTaskFailureRecord("fictiv", outcome, { retryCount: 0, requestedQuantity: 1 });
    expect(record).toMatchObject({
      status: "failed",
      notes: ["Provider temporarily unavailable."],
      raw_payload: {
        failureCode: "cancelled_provider_disabled",
        killSwitchCheckpoint: "before_configure",
        providerMutationPossible: true,
        requiresManualVendorFollowUp: false,
        retryScheduledFor: null,
      },
    });
  });

  it("an unreadable switch is failed before a mutation and manual follow up after one, never requeued", async () => {
    const unavailable = () => new ProviderKillSwitchError("provider_kill_switch_unavailable", "fictiv", "before_upload");
    const before = await runProviderTaskPipeline(input(), harness({ quote: async () => { throw unavailable(); } }).deps);
    expect(before).toMatchObject({ disposition: "failed", code: "provider_kill_switch_unavailable", retryAt: null, killSwitch: null });
    const after = await runProviderTaskPipeline(
      input(),
      harness({ quote: async () => { markProviderMutationStarted(); throw unavailable(); } }).deps,
    );
    expect(after).toMatchObject({ disposition: "manual_follow_up", code: "provider_kill_switch_unavailable", retryAt: null });
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
    expect(outcome).toMatchObject({ disposition: "failed", code: "adapter_failed" });
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

describe("abort signal into the adapter (OVD-748)", () => {
  const leaseOn = (v: ProviderTaskPipelineInput) => {
    v.leaseSetting = "on";
  };

  it("passes the adapter a live signal and leaves a run with no abort unchanged", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const h = harness({ quote: async (quoteInput) => { seen.push(quoteInput.signal); return quoteOutput(); } });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({ disposition: "persisted", code: "persisted" });
    expect(seen[0]?.aborted).toBe(false);
    expect(h.quote).toHaveBeenCalledTimes(1);
  });

  it("a lease aborted before the adapter starts never launches it and is not a provider failure", async () => {
    const calls: Calls = [];
    const lease = fakeLease(calls, { onContext: (controller) => controller.abort() });
    const h = harness({ calls, lease: lease.port });
    const day = h.deps.daySwitch;
    const outcome = await runProviderTaskPipeline(input(leaseOn), h.deps);
    expect(h.quote).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ disposition: "failed", code: "provider_aborted", adapterStarted: false, retryAt: null, providerDisabledForDay: false });
    expect(day.isDisabled("fictiv", NOW)).toBe(false);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("an abort mid run stops at the next checkpoint, persists nothing, and is not retried or counted as a block", async () => {
    const calls: Calls = [];
    let abort: () => void = () => {};
    const lease = fakeLease(calls, { onContext: (controller) => { abort = () => controller.abort(); } });
    const reached: string[] = [];
    const h = harness({
      calls,
      lease: lease.port,
      quote: async (quoteInput) => {
        await quoteInput.providerKillSwitchCheckpoint?.("before_navigation");
        reached.push("navigation");
        abort();
        await quoteInput.providerKillSwitchCheckpoint?.("before_upload");
        reached.push("upload");
        return quoteOutput();
      },
    });
    const outcome = await runProviderTaskPipeline(input(leaseOn), h.deps);
    expect(reached).toEqual(["navigation"]);
    expect(outcome).toMatchObject({ disposition: "failed", code: "provider_aborted", adapterStarted: true, retryAt: null, providerDisabledForDay: false });
    expect(h.persist).not.toHaveBeenCalled();
    expect(lease.isBlocked()).toBeNull();
  });

  it("an abort after a provider mutation began goes to an operator, never a retry", async () => {
    const h = harness({
      quote: async () => {
        markProviderMutationStarted();
        throw new ProviderAbortedError("before_save");
      },
    });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({ disposition: "manual_follow_up", code: "provider_aborted", retryAt: null });
  });
});

describe("abort under the real lease manager (OVD-748)", () => {
  function realLeasePort(calls: Calls): ProviderTaskLeasePort {
    const memory = createProviderSessionLeaseMemoryStore();
    const manager = createProviderSessionLeaseManager({
      store: { ...memory, renew: async () => ({ status: "lost", reason: "expired", outcome: null }) },
      policy: { ttlSeconds: 30, maxRenewals: 5, maxDurationSeconds: 600, safetyMarginMs: 5_000, heartbeatIntervalMs: 5 },
      log: () => undefined,
    });
    const base = fakeLease(calls).port;
    return { ...base, runWithLease: (request, operation) => manager.runWithLease(request, operation) };
  }

  async function runUntilLeaseLost(mutate: boolean) {
    const calls: Calls = [];
    const h = harness({
      calls,
      lease: realLeasePort(calls),
      quote: async (quoteInput) => {
        if (mutate) markProviderMutationStarted();
        await new Promise<void>((resolve) => {
          const poll = () => (quoteInput.signal?.aborted ? resolve() : void setTimeout(poll, 2));
          poll();
        });
        await quoteInput.providerKillSwitchCheckpoint?.("before_save");
        return quoteOutput();
      },
    });
    const outcome = await runProviderTaskPipeline(input((v) => (v.leaseSetting = "on")), h.deps);
    return { outcome, h };
  }

  it("keeps manual follow up when the lease is lost after a provider mutation began", async () => {
    const { outcome, h } = await runUntilLeaseLost(true);
    expect(outcome).toMatchObject({ disposition: "manual_follow_up", code: "provider_aborted", retryAt: null, adapterStarted: true });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("fails a lease lost before any provider mutation without a retry", async () => {
    const { outcome, h } = await runUntilLeaseLost(false);
    expect(outcome).toMatchObject({ disposition: "failed", code: "provider_aborted", retryAt: null });
    expect(h.persist).not.toHaveBeenCalled();
  });
});

function offerFor(change: Partial<VendorQuoteAdapterOffer> = {}): VendorQuoteAdapterOffer {
  return {
    providerOptionId: "standard",
    providerLabel: "Standard",
    quoteRef: "Q-1",
    quoteUrl: "https://app.fictiv.com/quotes/abc",
    quantity: 1,
    unitPriceUsd: 12,
    totalPriceUsd: 12,
    leadTimeBusinessDays: 8,
    shipReceiveBy: null,
    tier: "Standard",
    sourcing: null,
    geographicOrigin: "unknown",
    sortRank: 0,
    provenance: {
      containerSelector: ".option",
      providerOptionIdSource: "attribute",
      priceSource: "selector",
      leadTimeSource: "selector",
      geographicOriginSource: "none",
    },
    rawPayload: { normalizationRevision: "provider-offer-evidence.v1" },
    ...change,
  };
}

describe("persistence boundary (lead review of #698)", () => {
  it("accepts only sort ranks that fit the int4 column", () => {
    expect(isPersistableSortRank(0)).toBe(true);
    expect(isPersistableSortRank(MAX_PERSISTED_SORT_RANK)).toBe(true);
    for (const rank of [-1, MAX_PERSISTED_SORT_RANK + 1, 1e21, 0.5, Number.NaN]) {
      expect(isPersistableSortRank(rank)).toBe(false);
    }
  });

  it.each([-1, 1e21])("refuses an offer set with sort rank %s before the insert, in a visible state", async (sortRank) => {
    const h = harness({
      quote: async () =>
        quoteOutput({ offers: [offerFor(), offerFor({ providerOptionId: "rush", providerLabel: "Rush", sortRank })] }),
    });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({ disposition: "manual_follow_up", code: "sort_rank_out_of_range", stage: "validate" });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("persists a valid multi offer set with its ranks unchanged", async () => {
    const h = harness({
      quote: async () =>
        quoteOutput({ offers: [offerFor(), offerFor({ providerOptionId: "rush", providerLabel: "Rush", sortRank: 1 })] }),
    });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome.disposition).toBe("persisted");
    expect(h.persist.mock.calls[0][0].offers?.map((offer) => offer.sortRank)).toEqual([0, 1]);
  });

  it("derives a duration expiry in one place: quote time first, else collection time, inclusive end", () => {
    const provenance = { collectedAt: "2026-10-03T12:04:00.000Z" } as Parameters<typeof deriveProviderResultValidUntil>[1]["provenance"];
    const duration = { validitySource: "vendor_duration" as const, validityDurationDays: 7 };
    expect(deriveProviderResultValidUntil(duration, { validUntil: null, quotedAt: "2026-10-03T10:00:00.000Z", provenance })).toBe(
      "2026-10-10T10:00:00.000Z",
    );
    expect(deriveProviderResultValidUntil(duration, { validUntil: null, quotedAt: null, provenance })).toBe(
      "2026-10-10T12:04:00.000Z",
    );
    expect(
      deriveProviderResultValidUntil(duration, { validUntil: "2026-10-05T00:00:00.000Z", quotedAt: null, provenance }),
    ).toBe("2026-10-05T00:00:00.000Z");
    expect(
      deriveProviderResultValidUntil({ validitySource: "vendor_duration", validityDurationDays: 0 }, { validUntil: null, quotedAt: null, provenance }),
    ).toBeNull();
    expect(
      deriveProviderResultValidUntil({ validitySource: null, validityDurationDays: 7 }, { validUntil: null, quotedAt: null, provenance }),
    ).toBeNull();
  });

  it("persists the derived duration expiry", async () => {
    const h = harness({
      quote: async () =>
        quoteOutput({ quotedAt: "2026-10-03T12:00:00.000Z", validitySource: "vendor_duration", validityDurationDays: 30 }),
    });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome.disposition).toBe("persisted");
    const persisted = h.persist.mock.calls[0][0];
    expect(persisted.validUntil).toBe("2026-11-02T12:00:00.000Z");
    expect(persisted.validitySource).toBe("vendor_duration");
    expect(persisted.validityDurationDays).toBe(30);
    expect(persisted.rawPayload[PROVIDER_RESULT_VALID_UNTIL_DERIVED]).toBe(true);
    // The offer rows keep the derived column but no raw vendor date, so the
    // database trigger keeps vendor_duration instead of relabeling it vendor_date.
    const rows = preserveDerivedValiditySource(persisted, [{ valid_until: persisted.validUntil, raw_payload: { validUntil: persisted.validUntil, x: 1 } }]);
    expect(rows).toEqual([{ valid_until: "2026-11-02T12:00:00.000Z", raw_payload: { validUntil: null, x: 1 } }]);
  });

  it("leaves a vendor stated date untouched in the offer rows", async () => {
    const h = harness({ quote: async () => quoteOutput({ validUntil: "2026-11-30T00:00:00.000Z", validitySource: "vendor_date" }) });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome.disposition).toBe("persisted");
    const persisted = h.persist.mock.calls[0][0];
    expect(persisted.rawPayload[PROVIDER_RESULT_VALID_UNTIL_DERIVED]).toBeUndefined();
    const rows = [{ raw_payload: { validUntil: persisted.validUntil } }];
    expect(preserveDerivedValiditySource(persisted, rows)).toBe(rows);
  });

  it("never persists a duration that has already run out", async () => {
    const h = harness({
      quote: async () =>
        quoteOutput({ quotedAt: "2026-09-01T12:00:00.000Z", validitySource: "vendor_duration", validityDurationDays: 7 }),
    });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({ disposition: "manual_follow_up", code: "expired_validity", stage: "validate", retryAt: null });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("records a credential like quote URL query as a visible terminal failure, never a silent drop", async () => {
    const h = harness({ quote: async () => quoteOutput({ quoteUrl: "https://app.fictiv.com/quotes/abc?session=abc123" }) });
    const outcome = await runProviderTaskPipeline(input(), h.deps);
    expect(outcome).toMatchObject({ disposition: "failed", code: "invalid_destination", stage: "validate", retryAt: null });
    expect(outcome.rejection).toMatchObject({ kind: "provider_result_rejected", code: "invalid_destination", retry: "none" });
    expect(h.persist).not.toHaveBeenCalled();
    const record = providerTaskFailureRecord("fictiv", outcome, { retryCount: 0, requestedQuantity: 1 });
    expect(record.status).toBe("failed");
    expect(record.notes[0]).toContain("invalid_destination");
    expect(record.raw_payload).toMatchObject({
      failureCode: "invalid_destination",
      failureStage: "validate",
      adapterStarted: true,
      providerResultRejection: expect.objectContaining({ code: "invalid_destination" }),
    });
    expect(JSON.stringify(record)).not.toContain("abc123");
  });
});

describe("database claim cap (lead decision)", () => {
  it("bounds adapter starts at two claims", () => {
    expect(PROVIDER_TASK_MAX_CLAIMS).toBe(2);
  });

  it.each([3, 4, 10])("settles a claim with attempts %s to a visible failed state without starting anything", async (attempts) => {
    const h = harness();
    const outcome = await runProviderTaskPipeline(input((v) => (v.task.attempts = attempts)), h.deps);
    expectNoAdapter(outcome, h.quote);
    expect(outcome).toMatchObject({ disposition: "failed", code: "attempts_exhausted", stage: "authorize", retryAt: null });
    expect(h.deps.readLane).not.toHaveBeenCalled();
    expect(h.deps.authorize).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    // Claims spent before the pipeline (spend cap or staging retries) count too; the note says so.
    expect(providerTaskOutcomeNote("fictiv", outcome)).toContain("requeued before the provider pipeline ran");
  });

  it.each([0, -1, 1.5, Number.NaN])("fails closed on a malformed claim counter %s", async (attempts) => {
    const h = harness();
    const outcome = await runProviderTaskPipeline(input((v) => (v.task.attempts = attempts)), h.deps);
    expectNoAdapter(outcome, h.quote);
    expect(outcome).toMatchObject({ disposition: "failed", code: "execution_request_malformed" });
  });

  it("starts the adapter at most once per task, even when each claim runs in a fresh process", async () => {
    const failing = async () => {
      throw new Error("ECONNRESET");
    };
    const starts = vi.fn();
    const outcomes: ProviderTaskOutcome[] = [];
    for (let attempts = 1; attempts <= 4; attempts += 1) {
      // A fresh replay record per claim is the cross process case durable permit tracking (OVD-734) will close.
      const h = harness({ quote: failing });
      h.deps.onAdapterStart = starts;
      const outcome = await runProviderTaskPipeline(input((v) => (v.task.attempts = attempts)), h.deps);
      outcomes.push(outcome);
      if (outcome.disposition !== "requeue") break;
    }
    expect(starts).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.disposition)).toEqual(["manual_follow_up"]);
    expect(outcomes[0]).toMatchObject({ code: "adapter_failed", retryAt: null });
  });

});
