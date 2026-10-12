// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { genericFictivEnvelope } from "../test-support/genericDispatchResponse";
import { fingerprintProviderDispatchEnvelope } from "./providerDispatchEnvelope";
import type { ProviderDispatchEnvelope } from "./providerDispatchTypes";
import {
  createProviderAuthorizationConsumer,
  executeWithProviderAuthorization,
  PROVIDER_EXECUTION_LEASE_OUTCOME,
  PROVIDER_EXECUTION_TERMINAL_OUTCOMES,
  providerExecutionTerminalOutcomeForError,
  type ProviderExecutionGuard,
  type ProviderExecutionOptions,
  providerExecutionDenialFromError,
  ProviderExecutionTerminalError,
  type ProviderExecutionAdapter,
  type ProviderExecutionLogEvent,
  type ProviderExecutionRequest,
} from "./providerExecutionSeam";
import { ProviderDispatchAuthorizationError } from "./providerDispatchPreflight";
import { VendorAutomationError } from "./types";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const CAD = new TextEncoder().encode("step-bytes");
const DRAWING = new TextEncoder().encode("pdf-bytes");
const NOW = Date.parse("2026-10-03T12:05:00.000Z");

function envelopeFor(): ProviderDispatchEnvelope {
  const base = genericFictivEnvelope();
  const outbound = (role: "cad" | "drawing", bytes: Uint8Array) => ({
    role,
    sourceSha256: sha(bytes),
    sha256: sha(bytes),
    derivation: "identity" as const,
  });
  return {
    ...base,
    sourceFiles: [
      { role: "cad", fileId: base.sourceFiles[0].fileId, sha256: sha(CAD) },
      { role: "drawing", fileId: base.sourceFiles[1].fileId, sha256: sha(DRAWING) },
    ],
    outboundFiles: [outbound("cad", CAD), outbound("drawing", DRAWING)],
  };
}

function build(change: (request: ProviderExecutionRequest) => void = () => {}): ProviderExecutionRequest {
  const envelope = envelopeFor();
  const fingerprint = fingerprintProviderDispatchEnvelope(envelope);
  const request: ProviderExecutionRequest = {
    authorization: {
      permitId: envelope.permit.permitId,
      provider: envelope.provider,
      envelopeFingerprint: fingerprint,
      expiresAt: envelope.expiresAt,
      sessionBindingId: envelope.sessionBindingId,
      envelope,
    },
    expected: {
      provider: "fictiv",
      accountRef: "acct_" + "a".repeat(32),
      environment: "test",
      sessionBindingRef: "sb_" + "1".repeat(32),
      organizationId: envelope.subject.organizationId,
      envelope: { ...envelope.envelope },
      envelopeFingerprint: fingerprint,
      permitId: envelope.permit.permitId,
      sessionBindingId: envelope.sessionBindingId,
      task: { ...envelope.task },
      scope: { fingerprint: envelope.scope.fingerprint, requestedQuantity: envelope.scope.requestedQuantity },
      rolloutRevision: envelope.rollout.revision,
    },
    session: { provider: "fictiv", accountRef: "acct_" + "a".repeat(32), environment: "test", sessionBindingRef: "sb_" + "1".repeat(32) },
    files: [
      { role: "cad", bytes: Uint8Array.from(CAD) },
      { role: "drawing", bytes: Uint8Array.from(DRAWING) },
    ],
    nowMs: NOW,
  };
  change(request);
  return request;
}

function spyAdapter<T>(impl: () => Promise<T>, provider: "fictiv" | "weerg" = "fictiv") {
  const execute = vi.fn(impl);
  const adapter: ProviderExecutionAdapter<T> = { provider, execute };
  return { adapter, execute };
}

function run(
  request: ProviderExecutionRequest,
  adapter: ProviderExecutionAdapter<string>,
  options: ProviderExecutionOptions = {},
) {
  const events: ProviderExecutionLogEvent[] = [];
  return executeWithProviderAuthorization(request, adapter, {
    consumer: createProviderAuthorizationConsumer(),
    log: (e) => events.push(e),
    ...options,
  }).then((result) => ({
    result,
    events,
  }));
}

describe("executeWithProviderAuthorization", () => {
  it("runs the adapter exactly once for an exact, current authorization", async () => {
    const { adapter, execute } = spyAdapter(async () => "ok");
    const { result } = await run(build(), adapter);
    expect(result).toEqual({ kind: "completed", value: "ok" });
    expect(execute).toHaveBeenCalledTimes(1);
    const context = execute.mock.calls[0][0];
    expect(Object.isFrozen(context)).toBe(true);
    expect(context.files.map((f) => f.role)).toEqual(["cad", "drawing"]);
    expect(Object.keys(context)).not.toContain("accountRef");
  });

  it("denies with zero adapter calls when there is no authorization", async () => {
    for (const authorization of [null, undefined]) {
      const { adapter, execute } = spyAdapter(async () => "ok");
      const { result } = await run(build((r) => (r.authorization = authorization)), adapter);
      expect(result).toEqual({ kind: "denied", denial: "authorization_missing", retryable: false });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  const cases: [string, string, (r: ProviderExecutionRequest) => void][] = [
    ["session provider", "provider_mismatch", (r) => (r.session.provider = "weerg")],
    ["expected provider", "provider_mismatch", (r) => (r.expected.provider = "weerg")],
    ["account", "account_mismatch", (r) => (r.session.accountRef = "acct_" + "b".repeat(32))],
    ["environment", "environment_mismatch", (r) => (r.session.environment = "production")],
    ["envelope id", "provider_envelope_mismatch", (r) => (r.expected.envelope.id = "other-quote-envelope")],
    ["envelope version", "provider_envelope_mismatch", (r) => (r.expected.envelope.version = 2)],
    ["envelope fingerprint", "permit_mismatch", (r) => (r.expected.envelopeFingerprint = "c".repeat(64))],
    ["permit", "permit_mismatch", (r) => (r.expected.permitId = "00000000-0000-4000-8000-0000000000ff")],
    ["task", "task_lane_mismatch", (r) => (r.expected.task.workQueueTaskId = "00000000-0000-4000-8000-0000000000fe")],
    ["lane", "task_lane_mismatch", (r) => (r.expected.task.quoteRequestLaneId = "00000000-0000-4000-8000-0000000000fd")],
    ["organization", "organization_mismatch", (r) => (r.expected.organizationId = "00000000-0000-4000-8000-0000000000fc")],
    ["scope fingerprint", "scope_mismatch", (r) => (r.expected.scope.fingerprint = "d".repeat(64))],
    ["quantity", "scope_mismatch", (r) => (r.expected.scope.requestedQuantity = 50)],
    ["session binding", "session_binding_mismatch", (r) => (r.expected.sessionBindingId = "lease:other")],
    ["capability revision", "rollout_binding_mismatch", (r) => (r.expected.rolloutRevision = 4)],
    ["authorization expiry", "expiry_mismatch", (r) => (r.authorization!.expiresAt = "2026-10-03T13:00:00.000Z")],
    ["authorization provider", "provider_mismatch", (r) => (r.authorization!.provider = "weerg")],
    ["not yet valid", "permit_not_yet_valid", (r) => (r.nowMs = NOW - 10 * 60_000)],
    ["expired", "permit_expired", (r) => (r.nowMs = Date.parse("2026-10-03T12:15:00.000Z"))],
    ["tampered fingerprint", "envelope_malformed", (r) => (r.authorization!.envelopeFingerprint = "e".repeat(64))],
    ["session binding ref", "session_binding_mismatch", (r) => (r.session.sessionBindingRef = "sb_" + "2".repeat(32))],
    ["authorization permit", "permit_mismatch", (r) => (r.authorization!.permitId = "00000000-0000-4000-8000-0000000000aa")],
    ["authorization session binding", "session_binding_mismatch", (r) => (r.authorization!.sessionBindingId = "lease:other")],
    ["NaN clock", "permit_not_yet_valid", (r) => (r.nowMs = Number.NaN)],
    ["malformed account ref", "execution_request_malformed", (r) => (r.expected.accountRef = "raw-login@example.com")],
    ["malformed environment", "execution_request_malformed", (r) => ((r.session as { environment: string }).environment = "prod")],
  ];
  it.each(cases)("rejects a %s mismatch with zero adapter calls", async (_name, denial, change) => {
    const { adapter, execute } = spyAdapter(async () => "ok");
    const { result, events } = await run(build(change), adapter);
    expect(result).toEqual({ kind: "denied", denial, retryable: false });
    expect(execute).not.toHaveBeenCalled();
    expect(events).toEqual([{ event: "provider_execution.denied", provider: expect.any(String), denial }]);
  });

  it("rejects an envelope that is internally inconsistent or in the wrong time order", async () => {
    const edits: ((e: Record<string, unknown>) => void)[] = [
      (e) => (e.expiresAt = e.issuedAt),
      (e) => (e.schema = "provider-dispatch-envelope.v2"),
      (e) => (e.extra = true),
      (e) => delete e.rollout,
    ];
    for (const edit of edits) {
      const { adapter, execute } = spyAdapter(async () => "ok");
      const request = build((r) => edit(r.authorization!.envelope as unknown as Record<string, unknown>));
      const { result } = await run(request, adapter);
      expect(result.kind).toBe("denied");
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("rejects an adapter without execute", async () => {
    const { result } = await run(build(), { provider: "fictiv" } as ProviderExecutionAdapter<string>);
    expect(result).toMatchObject({ kind: "denied", denial: "adapter_mismatch" });
  });

  it("rejects an adapter for another provider", async () => {
    const { adapter, execute } = spyAdapter(async () => "ok", "weerg");
    const { result } = await run(build(), adapter);
    expect(result).toMatchObject({ kind: "denied", denial: "adapter_mismatch" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects captured bytes that differ from the authorized hashes, or missing, extra and duplicate files", async () => {
    const mutations: ((r: ProviderExecutionRequest) => void)[] = [
      (r) => (r.files = [{ role: "cad", bytes: new TextEncoder().encode("swapped") }, r.files[1]]),
      (r) => (r.files = [r.files[0]]),
      (r) => (r.files = [r.files[0], r.files[0]]),
      (r) => (r.files = [r.files[0], r.files[1], r.files[1]]),
      (r) => (r.files = [r.files[0], { role: "other" as "cad", bytes: DRAWING }]),
    ];
    for (const change of mutations) {
      const { adapter, execute } = spyAdapter(async () => "ok");
      const { result } = await run(build(change), adapter);
      expect(result).toMatchObject({ kind: "denied", denial: "captured_file_mismatch" });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("hands the adapter captured bytes that later mutation of the caller's buffer cannot change", async () => {
    const request = build();
    const original = request.files[0].bytes;
    const seen: string[] = [];
    const { adapter } = spyAdapter(async () => "ok");
    adapter.execute = vi.fn(async (context) => {
      original.fill(0);
      const first = context.files[0].bytes();
      first.fill(1);
      seen.push(sha(context.files[0].bytes()), context.files[0].sha256);
      return "ok";
    });
    await run(request, adapter);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBe(sha(CAD));
  });

  it("never retries terminal provider outcomes", async () => {
    const terminals: [() => unknown, string][] = [
      [() => new ProviderExecutionTerminalError("login_required"), "login_required"],
      [() => new ProviderExecutionTerminalError("challenge_required"), "challenge_required"],
      [() => new ProviderExecutionTerminalError("blocked"), "blocked"],
      [() => new ProviderExecutionTerminalError("banned"), "banned"],
      [() => new VendorAutomationError("x", "login_required"), "login_required"],
      [() => new VendorAutomationError("x", "captcha"), "challenge_required"],
      [() => new VendorAutomationError("x", "anti_detection_block"), "challenge_required"],
      [() => Object.assign(new Error("x"), { name: "ProviderSessionOutcomeError", outcome: "corrupt_state" }), "corrupt_state"],
    ];
    for (const [make, outcome] of terminals) {
      const { adapter, execute } = spyAdapter<string>(async () => {
        throw make();
      });
      const { result } = await run(build(), adapter);
      expect(result).toEqual({ kind: "terminal", outcome, disposition: "manual_follow_up", retryable: false });
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it("does not retry ordinary adapter failures either", async () => {
    const { adapter, execute } = spyAdapter<string>(async () => {
      throw new Error("boom");
    });
    const { result } = await run(build(), adapter);
    expect(result).toEqual({ kind: "adapter_failed", retryable: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps secrets out of results and logs", async () => {
    const secret = "cookie=SESSION_SECRET_123 token=sk_live_abc customer-step-bytes";
    const request = build();
    for (const error of [
      new Error(secret),
      new VendorAutomationError(secret, "captcha", { storageState: secret }),
      new ProviderExecutionTerminalError("banned"),
    ]) {
      const { adapter } = spyAdapter<string>(async () => {
        throw error;
      });
      const { result, events } = await run(request, adapter);
      const text = JSON.stringify({ result, events });
      expect(text).not.toContain("SESSION_SECRET");
      expect(text).not.toContain("sk_live");
      expect(text).not.toContain(request.expected.accountRef);
      expect(text).not.toContain(request.expected.sessionBindingId);
      expect(text).not.toContain("customer-step");
    }
  });
});

describe("replay, guards, lease composition and expiry", () => {
  it("runs the adapter once when the same authorization is presented twice", async () => {
    const consumer = createProviderAuthorizationConsumer();
    const { adapter, execute } = spyAdapter(async () => "ok");
    const first = await run(build(), adapter, { consumer });
    const second = await run(build(), adapter, { consumer });
    expect(first.result.kind).toBe("completed");
    expect(second.result).toEqual({ kind: "denied", denial: "authorization_replayed", retryable: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not replay after adapter failure or a terminal outcome", async () => {
    for (const fail of [new Error("boom"), new ProviderExecutionTerminalError("blocked")]) {
      const consumer = createProviderAuthorizationConsumer();
      const { adapter, execute } = spyAdapter<string>(async () => {
        throw fail;
      });
      await run(build(), adapter, { consumer });
      const again = await run(build(), adapter, { consumer });
      expect(again.result).toMatchObject({ kind: "denied", denial: "authorization_replayed" });
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it("does not consume the authorization when a denial happens first", async () => {
    const consumer = createProviderAuthorizationConsumer();
    const { adapter, execute } = spyAdapter(async () => "ok");
    await run(build((r) => (r.files = [])), adapter, { consumer });
    const { result } = await run(build(), adapter, { consumer });
    expect(result.kind).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("forgets consumed entries once they have expired", () => {
    const consumer = createProviderAuthorizationConsumer();
    expect(consumer.consume("k", 100, 0)).toBe(true);
    expect(consumer.consume("k", 100, 50)).toBe(false);
    expect(consumer.consume("k", 300, 100)).toBe(true);
  });

  it.each(["provider_disabled", "export_control_blocked", "provider_daily_cap_reached"] as const)(
    "denies on guard code %s with zero adapter calls",
    async (code) => {
      const { adapter, execute } = spyAdapter(async () => "ok");
      const guard: ProviderExecutionGuard = vi.fn(() => code);
      const { result } = await run(build(), adapter, { guards: [guard] });
      expect(result).toEqual({ kind: "denied", denial: code, retryable: false });
      expect(execute).not.toHaveBeenCalled();
      expect(guard).toHaveBeenCalledWith(expect.objectContaining({ provider: "fictiv", requestedQuantity: 1 }));
    },
  );

  it("fails closed when a guard throws or returns an unknown value, and skips later guards", async () => {
    for (const guard of [
      (() => {
        throw new Error("db down secret");
      }) as ProviderExecutionGuard,
      (() => "made_up") as unknown as ProviderExecutionGuard,
    ]) {
      const later = vi.fn(() => null);
      const { adapter, execute } = spyAdapter(async () => "ok");
      const { result } = await run(build(), adapter, { guards: [guard, later] });
      expect(result).toEqual({ kind: "denied", denial: "guard_failed", retryable: false });
      expect(later).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("runs guards only after authorization passes", async () => {
    const guard = vi.fn(() => null);
    const { adapter } = spyAdapter(async () => "ok");
    await run(build((r) => (r.authorization = null)), adapter, { guards: [guard] });
    expect(guard).not.toHaveBeenCalled();
    const ok = await run(build(), adapter, { guards: [guard] });
    expect(ok.result.kind).toBe("completed");
  });

  it("rethrows terminal errors on request so a lease records them", async () => {
    const error = new VendorAutomationError("x", "captcha");
    const { adapter } = spyAdapter<string>(async () => {
      throw error;
    });
    await expect(run(build(), adapter, { rethrowTerminal: true })).rejects.toBe(error);
    const { adapter: other } = spyAdapter<string>(async () => {
      throw new Error("plain");
    });
    const { result } = await run(build(), other, { rethrowTerminal: true });
    expect(result).toEqual({ kind: "adapter_failed", retryable: false });
  });

  it("maps every seam outcome to a lease blocking outcome", () => {
    const lease = new Set(["missing_session", "login_required", "challenge_required", "owner_revoked", "corrupt_state"]);
    for (const outcome of PROVIDER_EXECUTION_TERMINAL_OUTCOMES) {
      expect(lease.has(PROVIDER_EXECUTION_LEASE_OUTCOME[outcome])).toBe(true);
    }
    expect(providerExecutionTerminalOutcomeForError(Object.assign(new Error("x"), { name: "ProviderSessionOutcomeError", outcome: "nope" }))).toBeNull();
  });

  it("gives the adapter the expiry and aborts its signal at expiry", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const { adapter } = spyAdapter(async () => "ok");
      adapter.execute = vi.fn(async (context) => {
        expect(context.expiresAtMs).toBe(Date.parse("2026-10-03T12:15:00.000Z"));
        context.signal.addEventListener("abort", () => (aborted = true));
        await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
        return "ok";
      });
      const { result } = await run(build(), adapter);
      expect(result.kind).toBe("completed");
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("providerExecutionDenialFromError", () => {
  it("treats only preflight_unavailable as retryable", () => {
    expect(providerExecutionDenialFromError(new ProviderDispatchAuthorizationError("preflight_unavailable"))).toEqual({
      kind: "denied",
      denial: "preflight_unavailable",
      retryable: true,
    });
    expect(providerExecutionDenialFromError(new ProviderDispatchAuthorizationError("permit_revoked"))).toEqual({
      kind: "denied",
      denial: "permit_revoked",
      retryable: false,
    });
    expect(providerExecutionDenialFromError(new Error("x"))).toBeNull();
  });
});
