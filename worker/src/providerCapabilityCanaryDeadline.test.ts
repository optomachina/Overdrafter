// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createCanaryFencedAttempt } from "./providerCapabilityCanaryFenced.js";

const now = Date.parse("2026-10-02T12:00:00.000Z");
function fixture(deadline: string, leaseSeconds = 2, windowMs = 10_000) {
  const request = { windowKey: "canary:" + "a".repeat(64), resourceKey: "b".repeat(64), configDigest: "c".repeat(64),
    requestKey: "11111111-1111-4111-8111-111111111111", provider: "xometry", route: "quote_home", surface: "account_quote_modal",
    surfaceRevision: "surface.v1", windowStart: new Date(now).toISOString(), windowEnd: new Date(now + windowMs).toISOString(), leaseSeconds };
  const receipt = { status: "claimed", windowKey: request.windowKey, fence: "22222222-2222-4222-8222-222222222222",
    generation: 1, owner: request.requestKey, observationRevision: 17, deadline };
  const transport = { claim: vi.fn().mockResolvedValue(receipt), get: vi.fn().mockResolvedValue({ ...receipt, status: "completed" }), complete: vi.fn() };
  return { request, transport, receipt, attempt: createCanaryFencedAttempt({ request, transport, completionKey: "33333333-3333-4333-8333-333333333333" }) };
}
const signal = () => new AbortController().signal;

describe("canonical persistence deadline wire contract", () => {
  it.each(["", ".1", ".12", ".123", ".1234", ".12345", ".123456"].flatMap(fraction =>
    ["Z", "+00:00"].map(zone => `2026-10-02T12:00:01${fraction}${zone}`)))("accepts strict UTC deadline %s without rewriting retained evidence", async deadline => {
    const f = fixture(deadline);
    expect(await f.attempt.claim(now, signal())).toMatchObject({ state: "claimed", claim: { deadline } });
    expect(f.attempt.recovery().claim?.deadline).toBe(deadline);
    expect(await f.attempt.reconcile(now + 20_000, signal())).toEqual({ state: "completion_known" });
    expect(f.attempt.recovery().completion).toBeNull();
    expect((await f.attempt.claim(now, signal())).state).not.toBe("claimed");
    expect(f.transport.claim).toHaveBeenCalledTimes(1); expect(f.transport.complete).not.toHaveBeenCalled();
  });
  it("accepts a server lease started 1ms after the client sent the request", async () => {
    const f = fixture("2026-10-02T12:00:02.001Z");
    expect(await f.attempt.claim(now, signal())).toMatchObject({ state: "claimed" });
  });
  it.each(["2026-10-02T12:00:09.999999Z", "2026-10-02T12:00:10.000000+00:00"])("accepts an exact within-window server deadline %s", async deadline => {
    expect(await fixture(deadline).attempt.claim(now, signal())).toMatchObject({ state: "claimed" });
  });
  it.each([
    "2026-10-02T12:00:10.000001Z", "2026-10-02T12:00:10.000001+00:00",
    "2026-02-30T12:00:01Z", "2026-10-02T24:00:01Z", "2026-10-02T12:00:60Z",
    "2026-10-02T12:00:01.1234567Z", "2026-10-02T12:00:01.Z", "2026-10-02T12:00:01",
    "2026-10-02 12:00:01Z", "2026-10-02T12:00:01+01:00", "2026-10-02T12:00:01-00:00",
    "2026-10-02T12:00:01z", " 2026-10-02T12:00:01Z", "2026-10-02T12:00:01Z\n", "2026-10-02T12:00:01Z\r\n",
  ])("rejects out-of-window or noncanonical deadline %s", async deadline => {
    const f = fixture(deadline);
    expect((await f.attempt.claim(now, signal())).state).not.toBe("claimed");
    expect(f.attempt.recovery().claim).toBeNull(); expect(f.transport.complete).not.toHaveBeenCalled();
  });
});


it.each(["2026-10-02T12:00:30.000Z", "2026-10-02T12:00:30.001Z", "2026-10-02T12:00:30.100Z",
  "2026-10-02T12:00:30.000+00:00", "2026-10-02T12:00:30.000000+00:00"])(
  "matches the release transport's 30s server-lease reproduction: %s", async deadline => {
    const f = fixture(deadline, 30, 3600_000);
    expect(await f.attempt.claim(now, signal())).toMatchObject({ state: "claimed" });
    expect(f.transport.claim).toHaveBeenCalledTimes(1);
  },
);


it("does not widen canonical request or candidate timestamp acceptance", async () => {
  const f = fixture("2026-10-02T12:00:02+00:00");
  const invalidRequest = createCanaryFencedAttempt({ request: { ...f.request, windowStart: "2026-10-02T12:00:00+00:00" },
    transport: f.transport, completionKey: "33333333-3333-4333-8333-333333333333" });
  expect(await invalidRequest.claim(now, signal())).toEqual({ state: "rejected" });
  expect(f.transport.claim).not.toHaveBeenCalled();
  expect(await f.attempt.claim(now, signal())).toMatchObject({ state: "claimed" });
  expect(f.attempt.prepareCompletion({ provider: "xometry", route: f.request.route, surface: f.request.surface,
    revision: f.request.surfaceRevision, state: "fresh", extensions: ["step"], mimeTypes: [], acceptAttributePresent: true,
    observedAt: "2026-10-02T12:00:00+00:00", expiresAt: "2026-10-02T12:00:10.000Z", actorKind: "scheduled_canary",
    sourceKind: "scheduled_canary", sourceVersion: "capability-canary-offline.v1", evidenceReference: "issue:OVD-415", idempotencyKey: f.request.windowKey }, true)).toBe(false);
  expect(f.transport.complete).not.toHaveBeenCalled();
});
