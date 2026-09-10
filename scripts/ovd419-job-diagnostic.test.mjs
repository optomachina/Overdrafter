import { afterEach, describe, expect, it, vi } from "vitest";
import {
  digest, validatePacket, approvalSentence, validateApproval,
  projectClassification, runDiagnostic,
} from "./ovd419-job-diagnostic.mjs";

import { packet, harness, NOW } from "./ovd419-diagnostic-test-fixtures.mjs";

afterEach(() => vi.useRealTimers());

describe("diagnostic immutable contract", () => {
  it("accepts complete explicit limits and rejects missing resource facts", () => {
    expect(validatePacket(packet(), NOW)).toBeDefined();
    const p = packet(); delete p.limits.taskSeconds;
    expect(() => validatePacket(p, NOW)).toThrow();
  });
  it.each(["proposalSha256", "ownerTask", "attempts", "retries", "dependencyRiskAccepted"])("rejects substituted %s", (key) => {
    const p = packet(); p[key] = "wrong";
    expect(() => validatePacket(p, NOW)).toThrow();
  });
  it("rejects unknown fields and expired approval", () => {
    const p = packet(); p.extra = true;
    expect(() => validatePacket(p, NOW)).toThrow();
    const h = harness(); expect(() => validateApproval(h.approval, h.p, NOW + 3600000)).toThrow();
  });
  it.each(["assistant", "tool"])("rejects %s supplied approval", (role) => {
    const h = harness(); h.approval.transcript.role = role;
    expect(() => validateApproval(h.approval, h.p, NOW)).toThrow();
  });
  it("rejects generic approval and packet substitution", () => {
    const h = harness(); h.approval.transcript.text = "approved";
    expect(() => validateApproval(h.approval, h.p, NOW)).toThrow();
    const other = harness(); other.p.limits.cpu = "4";
    expect(() => validateApproval(other.approval, other.p, NOW)).toThrow();
  });
});

describe("single Job attempt", () => {
  it.each(["authenticated_dashboard", "login_required", "captcha", "anonymous_quote_home", "provider_error", "authenticated_dashboard_not_confirmed"])("contains %s without release qualification", async (reason) => {
    const h = harness(reason); const result = await h.run();
    expect(result.status).toBe("diagnostic_succeeded");
    expect(result.authenticated).toBe(reason === "authenticated_dashboard");
    expect(result.releaseQualified).toBe(false);
    expect(h.calls.filter((c) => c === "execute")).toHaveLength(1);
    expect(h.calls.filter((c) => c === "restore")).toHaveLength(1);
    expect(h.calls.slice(-2)).toEqual(["release", "persist"]);
  });
  it("unknown classification is inconclusive and never retries", async () => {
    const h = harness("private unexpected reason");
    expect((await h.run()).status).toBe("inconclusive");
    expect(h.calls.filter((c) => c === "execute")).toHaveLength(1);
  });
  it("ambiguous dispatch is independently attributed without another dispatch", async () => {
    const h = harness(); const execute = h.ops.executeJob;
    h.ops.executeJob = async () => { await execute(); throw Error("private response"); };
    expect((await h.run()).status).toBe("diagnostic_succeeded");
    expect(h.calls.filter((c) => c === "execute")).toHaveLength(1);
  });
  it("unknown dispatch acceptance with no added execution retains the sentinel", async () => {
    const h = harness(); h.ops.executeJob = async () => { h.calls.push("execute"); throw Error("private"); };
    expect((await h.run()).status).toBe("containment_unproved");
    expect(h.calls).not.toContain("restore"); expect(h.calls).not.toContain("release");
  });
  it("a proven local pre-dispatch rejection can restore without inventing server rejection", async () => {
    const h = harness(); h.ops.executeJob = async () => { h.calls.push("execute"); return { submission: "not_submitted" }; };
    const result = await h.run();
    expect(result.status).toBe("inconclusive"); expect(result.submission).toBe("not_submitted");
    expect(h.calls).toContain("restore"); expect(h.calls).toContain("release");
  });
  it("a singleton foreign execution is not proof of our lost response", async () => {
    const h = harness();
    h.ops.executeJob = async () => { h.calls.push("execute"); h.current().inventory.push("foreign-execution"); throw Error("lost response"); };
    expect((await h.run()).status).toBe("containment_unproved");
    expect(h.calls).not.toContain("restore"); expect(h.calls).not.toContain("release");
  });
  it("waits for a delayed matching Execution without premature restoration or redispatch", async () => {
    const h = harness(); let dispatchAttempted = false, observations = 0;
    const observe = h.ops.observe;
    h.ops.executeJob = async () => { h.calls.push("execute"); dispatchAttempted = true; throw Error("lost response"); };
    h.ops.observe = async () => {
      if (dispatchAttempted && ++observations === 3) h.current().inventory.push("new-execution");
      if (dispatchAttempted && observations < 3) expect(h.calls).not.toContain("restore");
      return observe();
    };
    expect((await h.run()).status).toBe("diagnostic_succeeded");
    expect(observations).toBeGreaterThanOrEqual(3);
    expect(h.calls.filter((c) => c === "execute")).toHaveLength(1);
  });
  it("records observed containment counts, timestamps and fingerprints", async () => {
    const h = harness(); const result = await h.run();
    expect(result.finalObservation).toMatchObject({ activeQueues: 0, activeExecutions: 0, natMappings: 0, executionCount: 2, snapshotFingerprint: h.p.baseline.snapshot, jobConfigurationFingerprint: h.p.baseline.job.configuration });
    expect(result.finalObservation.completedAt).toBe(new Date(NOW).toISOString());
    expect(result.finalObservation.inventoryFingerprint).toBe(digest(["new-execution", "old-execution"]));
  });
  it("replay cannot make a second mutation", async () => {
    const h = harness(); await h.run();
    await expect(h.run()).rejects.toThrow();
    expect(h.calls.filter((c) => c === "replace")).toHaveLength(1);
  });
  it("binding failure precedes acquisition and mutation", async () => {
    const h = harness(); h.ops.verifyBindings = async () => { throw Error("changed"); };
    await expect(h.run()).rejects.toThrow(); expect(h.calls).toEqual([]);
  });
  it("Service drift prevents dispatch and cannot be overwritten", async () => {
    const h = harness(); const replace = h.ops.replaceJob;
    h.ops.replaceJob = async (input) => { const value = await replace(input); h.current().service.configuration = "e".repeat(64); return value; };
    const result = await h.run();
    expect(result.status).toBe("containment_unproved");
    expect(h.calls).not.toContain("execute"); expect(h.calls).not.toContain("release");
  });
  it("restore failure retains sentinel and fixed error only", async () => {
    const h = harness(); h.ops.restoreJob = async () => { throw Error("secret-token"); };
    const result = await h.run(); expect(result.status).toBe("containment_unproved");
    expect(h.calls).not.toContain("release"); expect(JSON.stringify(result)).not.toContain("secret-token");
  });
  it("persists fixed evidence before release and retains ownership on persistence failure", async () => {
    const h = harness(); await h.run();
    expect(h.calls.indexOf("persist")).toBeLessThan(h.calls.indexOf("release"));
    const failed = harness(); failed.ops.persist = async () => { throw Error("disk failure"); };
    expect((await failed.run()).status).toBe("containment_unproved");
    expect(failed.calls).not.toContain("release");
  });
  it("records owner-release failure separately from the already captured observation", async () => {
    const h = harness(), records = [];
    h.ops.persist = async (value) => records.push(value);
    h.gate.release = async () => { throw Error("owner failure"); };
    expect((await h.run()).status).toBe("containment_unproved");
    expect(records[0].evidenceStage).toBe("before_owner_release");
    expect(records[1].ownerRelease).toBe("unproved");
  });
  it("reports a missing final ownership receipt without losing the first record", async () => {
    const h = harness(), records = [];
    h.ops.persist = async (value) => { if (records.length) throw Error("disk failure"); records.push(value); };
    expect((await h.run()).status).toBe("owner_receipt_unwritten");
    expect(records).toHaveLength(1); expect(records[0].evidenceStage).toBe("before_owner_release");
  });
  it("missing prior executions cannot be concealed by a new execution", async () => {
    const h = harness(); const execute = h.ops.executeJob;
    h.ops.executeJob = async () => { const v = await execute(); h.current().inventory = ["new-execution"]; return v; };
    expect((await h.run()).status).toBe("containment_unproved");
    expect(h.calls).not.toContain("restore");
  });
  it("a competing extra execution prevents rollback overwrite", async () => {
    const h = harness(); const execute = h.ops.executeJob;
    h.ops.executeJob = async () => { const v = await execute(); h.current().inventory.push("competing-execution"); return v; };
    expect((await h.run()).status).toBe("containment_unproved"); expect(h.calls).not.toContain("restore");
  });
  it("source substitution after replacement prevents dispatch", async () => {
    const h = harness(); const replace = h.ops.replaceJob;
    h.ops.replaceJob = async (input) => { const v = await replace(input); h.ops.verifyBindings = async () => { throw Error("changed"); }; return v; };
    expect((await h.run()).status).toBe("containment_unproved"); expect(h.calls).not.toContain("execute");
  });
  it("mandatory aggregate observation budget stops perpetual activity", async () => {
    const h = harness(); h.p.limits.maxObservations = 6;
    h.approval.packetSha256 = digest(h.p); h.approval.transcript.text = approvalSentence(h.p);
    const execute = h.ops.executeJob;
    h.ops.executeJob = async () => { const v = await execute(); h.current().activeExecutions = 1; return v; };
    expect((await h.run()).status).toBe("containment_unproved");
    expect(h.calls.filter((c) => c === "execute")).toHaveLength(1);
    expect(h.calls).not.toContain("restore");
  });
  it("unsettled dispatch times out finitely without racing a restoration", async () => {
    vi.useFakeTimers();
    const h = harness(); h.p.limits.taskSeconds = 1; h.p.limits.executionMs = 1000;
    h.approval.packetSha256 = digest(h.p); h.approval.transcript.text = approvalSentence(h.p);
    h.current().resources.taskSeconds = 1;
    const replace = h.ops.replaceJob;
    h.ops.replaceJob = async (input) => { const v = await replace(input); h.current().resources.taskSeconds = 1; return v; };
    h.ops.executeJob = async () => { h.calls.push("execute"); return new Promise(() => {}); };
    const pending = h.run(); await vi.advanceTimersByTimeAsync(h.p.limits.preparationMs + h.p.limits.executionMs);
    expect((await pending).status).toBe("containment_unproved");
    expect(h.calls).not.toContain("restore"); expect(h.calls).not.toContain("release");
  });
  it("interruption after replacement prevents dispatch but still restores", async () => {
    const h = harness(); let stopped = false;
    const replace = h.ops.replaceJob;
    h.ops.replaceJob = async (input) => { const v = await replace(input); stopped = true; return v; };
    const result = await runDiagnostic({ packet: h.p, approval: h.approval, operations: h.ops, admission: h.gate, now: () => NOW, wait: async () => {}, interrupted: () => stopped });
    expect(result.status).toBe("inconclusive"); expect(h.calls).not.toContain("execute"); expect(h.calls).toContain("restore");
  });
});

describe("evidence projection", () => {
  it("drops private fields and rejects contradictory classification", () => {
    expect(projectClassification({ reason: "login_required", authenticated: false, url: "secret", cookie: "secret" })).toEqual({ reason: "login_required", authenticated: false });
    expect(projectClassification({ reason: "captcha", authenticated: true })).toBeNull();
  });
});


describe("v2 complete phase bounds", () => {
  function rebind(h) { h.approval.packetSha256 = digest(h.p); h.approval.transcript.text = approvalSentence(h.p); }
  it("rejects v1 and incomplete or inconsistent new budgets", () => {
    const old = packet(); old.schema = "ovd419-job-diagnostic-v1";
    expect(() => validatePacket(old, NOW)).toThrow();
    for (const field of ["observationMs", "preparationMs", "maxObservations"]) {
      const missing = packet(); delete missing.limits[field]; expect(() => validatePacket(missing, NOW)).toThrow();
    }
    const inconsistent = packet(); inconsistent.limits.preparationMs = inconsistent.limits.observationMs - 1;
    expect(() => validatePacket(inconsistent, NOW)).toThrow();
  });
  it("allows a full observation longer than an individual read", async () => {
    vi.useFakeTimers(); const h = harness(); h.p.limits.readMs = 10; h.p.limits.observationMs = 100; rebind(h);
    const observe = h.ops.observe;
    h.ops.observe = async () => { await new Promise((r) => setTimeout(r, 40)); return observe(); };
    const pending = h.run(); await vi.runAllTimersAsync();
    expect((await pending).status).toBe("diagnostic_succeeded");
    expect(h.calls.filter((c) => c === "execute")).toHaveLength(1);
  });
  it("clips initial observation to the remaining preflight deadline", async () => {
    vi.useFakeTimers(); const h = harness(); h.p.limits.readMs = 10; h.p.limits.preflightMs = 25; h.p.limits.observationMs = 100; rebind(h);
    let signal; h.ops.observe = async (input) => { signal = input.signal; return new Promise(() => {}); };
    const pending = h.run().catch((e) => e.message); await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toBe("diagnostic_rejected_before_mutation"); expect(signal.aborted).toBe(true);
    expect(h.calls).not.toContain("replace"); expect(h.calls).not.toContain("release");
  });
  it("clips recovery observation and retains ownership when it remains unsettled", async () => {
    vi.useFakeTimers(); const h = harness(); h.p.limits.readMs = 10; h.p.limits.observationMs = 100; h.p.limits.recoveryMs = 25; rebind(h);
    const observe = h.ops.observe;
    h.ops.observe = async () => { if (h.calls.includes("execute")) return new Promise(() => {}); return observe(); };
    const pending = h.run(); await vi.advanceTimersByTimeAsync(25);
    expect((await pending).status).toBe("containment_unproved"); expect(h.calls).not.toContain("restore"); expect(h.calls).not.toContain("release");
  });
  it("includes restoration preparation in the recovery deadline", async () => {
    vi.useFakeTimers(); const h = harness(); h.p.limits.readMs = 10; h.p.limits.recoveryMs = 25; rebind(h);
    let signal; h.ops.restoreJob = async (input) => { signal = input.signal; h.calls.push("restore"); return new Promise(() => {}); };
    const pending = h.run(); await vi.advanceTimersByTimeAsync(25);
    expect((await pending).status).toBe("containment_unproved"); expect(signal.aborted).toBe(true); expect(h.calls).not.toContain("release");
  });
});


describe("absolute deadlines across sequential capabilities", () => {
  it("does not reset the preflight clock for the second complete observation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const h = harness(); h.p.limits.readMs = 10; h.p.limits.observationMs = 100; h.p.limits.preflightMs = 70;
    h.approval.packetSha256 = digest(h.p); h.approval.transcript.text = approvalSentence(h.p);
    const observe = h.ops.observe; let count = 0;
    h.ops.observe = async () => {
      count += 1; const startedAt = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ...await observe(), startedAt, completedAt: new Date().toISOString() };
    };
    const pending = runDiagnostic({ packet: h.p, approval: h.approval, operations: h.ops, admission: h.gate, now: Date.now, wait: async () => {}, interrupted: () => false }).catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(70);
    expect(await pending).toBe("diagnostic_rejected_before_mutation"); expect(count).toBe(2);
    expect(h.calls).not.toContain("replace"); expect(h.calls).not.toContain("release");
  });
  it("rejects a capability that returns after a synchronous clock jump past its deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const h = harness(); h.p.limits.readMs = 10;
    h.approval.packetSha256 = digest(h.p); h.approval.transcript.text = approvalSentence(h.p);
    h.ops.verifyBindings = async () => { vi.setSystemTime(NOW + 11); };
    await expect(runDiagnostic({ packet: h.p, approval: h.approval, operations: h.ops, admission: h.gate, now: Date.now, wait: async () => {}, interrupted: () => false })).rejects.toThrow("diagnostic_rejected_before_mutation");
    expect(h.calls).not.toContain("acquire"); expect(h.calls).not.toContain("replace");
  });
});
