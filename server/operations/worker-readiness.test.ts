// @vitest-environment node
import { describe, expect, it } from "vitest";
import { projectWorkerReadiness, type WorkerReadinessPolicy } from "./worker-readiness";

const nowMs = Date.parse("2026-10-02T12:00:00.000Z");
const iso = (age: number) => new Date(nowMs - age).toISOString();
const policy = { nowMs, maxAgeMs: 60_000 };
// Field names and coherence follow worker/src/httpServer.ts getSnapshot.
const healthy = {
  service: "overdrafter-cad-worker", status: "running", ready: true,
  readinessIssues: [] as string[], lastLoopAt: iso(1_000),
};
const project = (payload: unknown = healthy, fetchedAt: unknown = iso(0)) =>
  projectWorkerReadiness({ payload, fetchedAt }, policy);

describe("worker readiness projection", () => {
  it("projects only the fixed safe item from fresh coherent health", () => {
    expect(project()).toEqual({
      key: "worker:readiness", category: "worker", subsystem: "cad-worker",
      severity: "healthy", reasonCode: "worker_ready",
      summary: "The worker reports that it is ready with a fresh heartbeat.",
      freshness: "fresh", lastCheckedAt: iso(0), lastObservedAt: iso(1_000),
      firstSeenAt: null, lastChangedAt: null, occurrenceCount: null,
      versionContext: null, action: null, reference: null,
    });
  });
  it.each([
    { status: "starting", ready: false, readinessIssues: [] },
    { status: "shutting_down", ready: false, readinessIssues: [] },
    { status: "running", ready: false, readinessIssues: ["private diagnostic"] },
  ])("projects fresh coherent not-ready state as blocked: %j", (change) => {
    expect(project({ ...healthy, ...change })).toMatchObject({
      severity: "blocked", reasonCode: "worker_not_ready", freshness: "fresh", occurrenceCount: null,
    });
  });
  it("distinguishes unavailable from malformed without claiming healthy", () => {
    expect(projectWorkerReadiness(null, policy)).toMatchObject({ severity: "unknown", reasonCode: "source_unavailable" });
    expect(project(null)).toMatchObject({ severity: "unknown", reasonCode: "source_malformed" });
  });
  it.each([
    undefined, [], "healthy", {},
    { ...healthy, service: "unrelated-service" },
    { ...healthy, status: "healthy" }, { ...healthy, status: ["running"] },
    { ...healthy, status: ["starting"], ready: false },
    { ...healthy, status: ["shutting_down"], ready: false },
    { ...healthy, ready: "true" }, { ...healthy, ready: false },
    { ...healthy, status: "starting" }, { ...healthy, readinessIssues: ["failure"] },
    { ...healthy, readinessIssues: null }, { ...healthy, readinessIssues: {} },
    { ...healthy, readinessIssues: [1] },
  ])("degrades malformed or contradictory payload to unknown: %j", (payload) => {
    // Pass directly so undefined is not replaced by the helper's default.
    expect(projectWorkerReadiness({ payload, fetchedAt: iso(0) }, policy))
      .toMatchObject({ severity: "unknown", reasonCode: "source_malformed" });
  });
  it.each([null, undefined, "", "yesterday", "2026-02-30T12:00:00.000Z", "2026-10-02", "2026-10-02T12:00:00Z", "2026-10-02T12:00:00.000+00:00", 123, iso(-1)])(
    "does not retain invalid or future receipt metadata: %j", (fetchedAt) => {
      expect(projectWorkerReadiness({ payload: healthy, fetchedAt }, policy)).toMatchObject({
        severity: "unknown", reasonCode: "source_malformed", lastCheckedAt: null, lastObservedAt: null,
      });
    },
  );
  it.each([null, undefined, "", "2026-02-30T12:00:00.000Z", "2026-10-02T12:00:00Z", iso(-1)])(
    "does not retain missing, invalid or future heartbeat: %j", (lastLoopAt) => {
      expect(project({ ...healthy, lastLoopAt })).toMatchObject({
        severity: "unknown", reasonCode: "source_malformed", lastCheckedAt: iso(0), lastObservedAt: null,
      });
    },
  );
  it("rejects a heartbeat newer than receipt even when both precede now", () => {
    expect(project({ ...healthy, lastLoopAt: iso(500) }, iso(1_000)))
      .toMatchObject({ severity: "unknown", lastObservedAt: null });
  });
  it.each([
    { heartbeatAge: 60_000, receiptAge: 60_000, severity: "healthy", freshness: "fresh" },
    { heartbeatAge: 60_001, receiptAge: 0, severity: "unknown", freshness: "stale" },
    { heartbeatAge: 60_002, receiptAge: 60_001, severity: "unknown", freshness: "stale" },
  ])("uses the explicit age boundary: %j", ({ heartbeatAge, receiptAge, severity, freshness }) => {
    expect(project({ ...healthy, lastLoopAt: iso(heartbeatAge) }, iso(receiptAge)))
      .toMatchObject({ severity, freshness });
  });
  it("keeps incomplete or stale blocked evidence unknown", () => {
    const blocked = { ...healthy, ready: false, readinessIssues: ["failure"] };
    expect(project({ ...blocked, lastLoopAt: null }).severity).toBe("unknown");
    expect(project({ ...blocked, lastLoopAt: iso(60_001) }).severity).toBe("unknown");
  });
  it.each([
    { nowMs: Number.NaN }, { nowMs: Infinity }, { nowMs: 0.5 }, { nowMs: 8.65e15 },
    { maxAgeMs: 0 }, { maxAgeMs: -1 }, { maxAgeMs: 0.5 }, { maxAgeMs: Infinity },
  ])("rejects invalid policy without a clock or default budget: %j", (change) => {
    expect(projectWorkerReadiness({ payload: healthy, fetchedAt: iso(0) }, { ...policy, ...change }))
      .toMatchObject({ severity: "unknown", reasonCode: "policy_invalid", lastCheckedAt: null });
  });
  it("defensively degrades null policy", () => {
    expect(projectWorkerReadiness(null, null as unknown as WorkerReadinessPolicy).reasonCode).toBe("policy_invalid");
  });
  it("keeps identity stable across state transitions and changed checks", () => {
    const results = [project(), project(null), project({ ...healthy, lastLoopAt: iso(60_001) }),
      project({ ...healthy, ready: false, readinessIssues: ["failure"] }),
      project({ ...healthy, lastLoopAt: iso(2_000) }, iso(1_000))];
    expect(new Set(results.map((result) => result.key))).toEqual(new Set(["worker:readiness"]));
  });
  it("excludes private data and arbitrary fields instead of trying to redact them", () => {
    const secret = "Bearer synthetic-secret account@example.test customer.step <html>private</html> Error: private stack";
    const payload = {
      ...healthy, ready: false, readinessIssues: [secret.repeat(10_000)],
      workerName: secret, workerBuildVersion: secret, drawingExtractionModel: secret,
      currentTask: { id: secret }, lastError: secret, recentEvents: [{ message: secret }],
      credentials: secret, action: "https://example.test/private", versionContext: secret,
      xometry_session_age_days: 0, fictiv_session_age_days: null,
    };
    const result = project(payload);
    expect(result).toEqual(project({ ...healthy, ready: false, readinessIssues: ["bounded fixture"] }));
    const serialized = JSON.stringify(result);
    for (const token of ["synthetic-secret", "account@", "customer.step", "<html>", "private stack", "example.test"]) {
      expect(serialized).not.toContain(token);
    }
    expect(serialized.length).toBeLessThan(1_000);
  });
});
