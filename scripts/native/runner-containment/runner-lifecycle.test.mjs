import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  JOURNAL_EVENTS, WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES, advanceLifecycle, appendJournalRecord,
  createLifecycle, journalRecordDigest, publicContainmentResult, quoteWindowsArgument,
  validateCapabilities, validateJournal,
} from "./runner-lifecycle.mjs";

const identity = Object.freeze({ attemptId: "11111111-1111-7111-8111-111111111111", fence: 7,
  workerId: "worker-1", bootId: "boot-1", runtimeDigest: "a".repeat(64), jobDigest: "b".repeat(64) });
const finalPath = ["intent_durable", "job_configured", "child_created_suspended_and_assigned",
  "child_identity_durable", "assignment_verified_durable", "child_resumed", "terminal_observed",
  "job_empty_proved", "finalized"];
const evidence = Object.freeze({
  launch_intent: { creationTimeJobAssignment: "true", executablePath: "C:\\fixed\\SyntheticChildTree.exe",
    executableSha256: "c".repeat(64), workingDirectory: "C:\\attempt", workingDirectorySha256: "d".repeat(64) },
  child_identity: { creationTicks: "1337", executableSha256: "c".repeat(64), pid: "42", role: "root", session: "1" },
  assignment_verified: { breakawayAllowed: "false", memberCount: "1", rootPresent: "true" },
  child_resumed: { resumed: "true" },
  terminal_observed: { creationTicks: "1337", exitCode: "0", pid: "42", terminationRequested: "false" },
  job_empty: { memberCount: "0", proved: "true" },
});
function journal(events = JOURNAL_EVENTS) {
  return events.reduce((records, event, index) => appendJournalRecord(records,
    { ...identity, event, observedUtc: `2026-09-12T12:00:0${index}Z`, evidence: evidence[event] }), []);
}
function completedLifecycle() {
  let state = createLifecycle({ attemptId: identity.attemptId, fence: identity.fence, backend: WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES });
  for (const next of finalPath) state = advanceLifecycle(state, next);
  return state;
}

describe("runner containment source contract", () => {
  it("declares source capabilities without runtime or isolation overclaims", () => {
    assert.deepEqual(validateCapabilities(WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES), WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES);
    assert.deepEqual({ creationTimeJobAssignment: WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES.creationTimeJobAssignment,
      descendantContainment: WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES.descendantContainment,
      filesystemIsolation: WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES.filesystemIsolation,
      runtimeQualified: WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES.runtimeQualified },
    { creationTimeJobAssignment: true, descendantContainment: true, filesystemIsolation: false, runtimeQualified: false });
    assert.throws(() => validateCapabilities({ ...WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES, runtimeQualified: true }), /invalid_capabilities/);
    assert.throws(() => validateCapabilities({ ...WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES, membershipQuery: false }), /invalid_capabilities/);
    assert.throws(() => validateCapabilities({ ...WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES, backend: "bad backend" }), /invalid_capabilities/);
    assert.throws(() => validateCapabilities({ ...WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES,
      backend: "11111111-1111-7111-8111-111111111111" }), /invalid_capabilities/);
    assert.throws(() => validateCapabilities({ ...WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES,
      sourceOnly: false, platform: "darwin", filesystemIsolation: true }), /invalid_capabilities/);
  });

  it("latches an invalid transition as irreversible uncertainty", () => {
    const state = createLifecycle({ attemptId: identity.attemptId, fence: identity.fence, backend: WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES });
    assert.equal(advanceLifecycle(state, "child_resumed").state, "process_uncertain");
    assert.equal(state.processUncertain, true);
    assert.throws(() => advanceLifecycle(state, "intent_durable"), /invalid_lifecycle/);
  });

  it("accepts the causal assignment-before-resume lifecycle and cleanup-only failure path", () => {
    const state = completedLifecycle();
    assert.ok(state.history.indexOf("assignment_verified_durable") < state.history.indexOf("child_resumed"));
    let cleanup = createLifecycle({ attemptId: identity.attemptId, fence: identity.fence, backend: WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES });
    for (const next of ["intent_durable", "job_configured", "child_created_suspended_and_assigned",
      "cleanup_required", "job_empty_proved", "finalized"]) cleanup = advanceLifecycle(cleanup, next);
    assert.equal(publicContainmentResult({ lifecycle: cleanup, journal: validateJournal(journal(), identity),
      operation: "failed", persistence: "failed", cleanup: "proved", evidenceEligible: true }).evidenceEligible, false);
  });

  it("chains identity-bound schema-exact immutable records", () => {
    const mutable = { resumed: "true" };
    const immutable = appendJournalRecord([], { ...identity, event: "child_resumed",
      observedUtc: "2026-09-12T12:00:00Z", evidence: mutable });
    mutable.resumed = "false";
    assert.equal(immutable[0].evidence.resumed, "true");
    const records = journal();
    const valid = validateJournal(records, identity);
    assert.equal(valid.recordCount, 6);
    assert.match(valid.journalDigest, /^[0-9a-f]{64}$/);
    assert.throws(() => validateJournal([...records].reverse(), identity), /invalid_evidence_chain/);
    assert.throws(() => validateJournal(records, { ...identity, bootId: "other" }), /invalid_evidence_chain/);
    assert.throws(() => appendJournalRecord([], { ...identity, observedUtc: "2026-09-12T12:00:00Z",
      event: "child_resumed", evidence: { resumed: "true", extra: "x" } }), /invalid_evidence_schema/);
    const accessor = {}; Object.defineProperty(accessor, "resumed", { enumerable: true, get() { throw new Error("read"); } });
    assert.throws(() => appendJournalRecord([], { ...identity, observedUtc: "2026-09-12T12:00:00Z",
      event: "child_resumed", evidence: accessor }), /invalid_evidence/);
    let hooks = 0;
    const proxy = new Proxy({ resumed: "true" }, { getPrototypeOf() { hooks++; return Object.prototype; } });
    assert.throws(() => appendJournalRecord([], { ...identity, observedUtc: "2026-09-12T12:00:00Z",
      event: "child_resumed", evidence: proxy }), /invalid_evidence/);
    assert.equal(hooks, 0);
    const canary = { [Symbol.toPrimitive]() { throw new Error("canary"); } };
    assert.throws(() => appendJournalRecord([], { ...identity, attemptId: canary,
      observedUtc: "2026-09-12T12:00:00Z", event: "child_resumed", evidence: { resumed: "true" } }), /invalid_identity/);
  });

  it("requires matching identities and the complete causal journal for eligibility", () => {
    const lifecycle = completedLifecycle();
    const valid = validateJournal(journal(), identity);
    assert.equal(publicContainmentResult({ lifecycle, journal: valid, operation: "completed",
      persistence: "durable", cleanup: "not_needed", evidenceEligible: true }).evidenceEligible, true);
    const missing = validateJournal(journal(JOURNAL_EVENTS.slice(0, -1)), identity);
    assert.equal(publicContainmentResult({ lifecycle, journal: missing, operation: "completed",
      persistence: "durable", cleanup: "not_needed", evidenceEligible: true }).evidenceEligible, false);
    const forcedRecords = JOURNAL_EVENTS.reduce((records, event, index) => appendJournalRecord(records,
      { ...identity, event, observedUtc: `2026-09-12T12:00:0${index}Z`, evidence: event === "terminal_observed"
        ? { ...evidence[event], exitCode: "3758096385", terminationRequested: "true" } : evidence[event] }), []);
    assert.equal(publicContainmentResult({ lifecycle, journal: validateJournal(forcedRecords, identity), operation: "completed",
      persistence: "durable", cleanup: "proved", evidenceEligible: true }).evidenceEligible, false);
    assert.throws(() => publicContainmentResult({ lifecycle, journal: { ...valid, fence: 8 }, operation: "completed",
      persistence: "durable", cleanup: "not_needed", evidenceEligible: true }), /invalid_result/);
    assert.throws(() => publicContainmentResult({ lifecycle: { ...lifecycle,
      backend: "11111111-1111-7111-8111-111111111111" }, journal: valid, operation: "completed",
      persistence: "durable", cleanup: "not_needed", evidenceEligible: true }), /invalid_result/);
  });

  it("enforces the 64 KiB complete journal snapshot ceiling", () => {
    let records = [];
    assert.throws(() => {
      for (let index = 0; index < 128; index++) records = appendJournalRecord(records, { ...identity,
        observedUtc: "2026-09-12T12:00:00Z", event: "launch_intent", evidence: {
          creationTimeJobAssignment: "true", executablePath: "x".repeat(512), executableSha256: "c".repeat(64),
          workingDirectory: "y".repeat(512), workingDirectorySha256: "d".repeat(64) } });
    }, /evidence_limit/);
  });

  it("shares a canonical digest golden vector with the Windows source", () => {
    const record = journal(["child_resumed"])[0];
    const { digest, ...body } = record;
    assert.equal(journalRecordDigest(body), digest);
    assert.equal(digest, "e33f359896c8e8cf963c7afda0c4aeff7c374ffe4f5575b064ce255f4443cb03");
  });

  it("implements Windows C runtime argument quoting", () => {
    const cases = [["plain", "plain"], ["", '\"\"'], ["two words", '\"two words\"'],
      ['a"b', '\"a\\\"b\"'], ["C:\\path with space\\", '\"C:\\path with space\\\\\"'],
      ["\\\\server\\share\\", "\\\\server\\share\\"]];
    for (const [value, expected] of cases) assert.equal(quoteWindowsArgument(value), expected);
    assert.throws(() => quoteWindowsArgument("bad\0arg"), /invalid_argument/);
  });
});
