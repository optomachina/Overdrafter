// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { genericFictivEnvelope } from "../test-support/genericDispatchResponse";
import { fingerprintProviderDispatchEnvelope } from "./providerDispatchEnvelope";
import type { ProviderDispatchEnvelope } from "./providerDispatchTypes";
import {
  executeWithProviderAuthorization,
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

function build(
  mutate: (envelope: ProviderDispatchEnvelope) => void = () => {},
  change: (request: ProviderExecutionRequest) => void = () => {},
): ProviderExecutionRequest {
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
      organizationId: envelope.subject.organizationId,
      envelope: { ...envelope.envelope },
      envelopeFingerprint: fingerprint,
      permitId: envelope.permit.permitId,
      sessionBindingId: envelope.sessionBindingId,
      task: { ...envelope.task },
      scope: { fingerprint: envelope.scope.fingerprint, requestedQuantity: envelope.scope.requestedQuantity },
      rolloutRevision: envelope.rollout.revision,
    },
    session: { provider: "fictiv", accountRef: "acct_" + "a".repeat(32), environment: "test" },
    files: [
      { role: "cad", bytes: Uint8Array.from(CAD) },
      { role: "drawing", bytes: Uint8Array.from(DRAWING) },
    ],
    nowMs: NOW,
  };
  // Mutations that should look like an authorization the service signed over
  // the changed envelope (so the fingerprint still matches) go through `mutate`.
  mutate(envelope);
  if (envelope !== request.authorization!.envelope) return request;
  request.authorization!.envelopeFingerprint = fingerprintProviderDispatchEnvelope(envelope);
  change(request);
  return request;
}

function spyAdapter<T>(impl: () => Promise<T>, provider: "fictiv" | "weerg" = "fictiv") {
  const execute = vi.fn(impl);
  const adapter: ProviderExecutionAdapter<T> = { provider, execute };
  return { adapter, execute };
}

function run(request: ProviderExecutionRequest, adapter: ProviderExecutionAdapter<string>) {
  const events: ProviderExecutionLogEvent[] = [];
  return executeWithProviderAuthorization(request, adapter, { log: (e) => events.push(e) }).then((result) => ({
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
      const { result } = await run(build((_e) => {}, (r) => (r.authorization = authorization)), adapter);
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
    ["malformed environment", "execution_request_malformed", (r) => ((r.session as { environment: string }).environment = "prod")],
  ];
  it.each(cases)("rejects a %s mismatch with zero adapter calls", async (_name, denial, change) => {
    const { adapter, execute } = spyAdapter(async () => "ok");
    const { result, events } = await run(build((_e) => {}, change), adapter);
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
      const request = build((_e) => {}, (r) => edit(r.authorization!.envelope as unknown as Record<string, unknown>));
      const { result } = await run(request, adapter);
      expect(result.kind).toBe("denied");
      expect(execute).not.toHaveBeenCalled();
    }
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
      const { result } = await run(build((_e) => {}, change), adapter);
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
      [() => new VendorAutomationError("x", "anti_detection_block"), "blocked"],
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
