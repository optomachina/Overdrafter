import { describe, expect, it } from "vitest";
import {
  digest, validatePacket, approvalSentence, validateApproval,
  projectClassification, runDiagnostic,
} from "./ovd419-job-diagnostic.mjs";

import { packet, harness, NOW } from "./ovd419-diagnostic-test-fixtures.mjs";

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
  it("mandatory aggregate read budget stops perpetual activity", async () => {
    const h = harness(); h.p.limits.maxReads = 6;
    h.approval.packetSha256 = digest(h.p); h.approval.transcript.text = approvalSentence(h.p);
    const execute = h.ops.executeJob;
    h.ops.executeJob = async () => { const v = await execute(); h.current().activeExecutions = 1; return v; };
    expect((await h.run()).status).toBe("containment_unproved");
    expect(h.calls.filter((c) => c === "execute")).toHaveLength(1);
    expect(h.calls).not.toContain("restore");
  });
  it("unsettled dispatch times out finitely without racing a restoration", async () => {
    const h = harness(); h.p.limits.taskSeconds = 1; h.p.limits.executionMs = 1000;
    h.approval.packetSha256 = digest(h.p); h.approval.transcript.text = approvalSentence(h.p);
    h.current().resources.taskSeconds = 1;
    const replace = h.ops.replaceJob;
    h.ops.replaceJob = async (input) => { const v = await replace(input); h.current().resources.taskSeconds = 1; return v; };
    h.ops.executeJob = async () => { h.calls.push("execute"); return new Promise(() => {}); };
    expect((await h.run()).status).toBe("containment_unproved");
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
