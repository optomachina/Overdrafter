import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { evaluateClosedJournal, LIMITS } from "./closed-journal.mjs";

const identity = { attemptId: "11111111-1111-7111-8111-111111111111", bootId: "boot-1", fence: 7,
  jobDigest: "b".repeat(64), runtimeDigest: "a".repeat(64), workerId: "worker-1" };
const eventNames = ["launch_intent", "child_identity", "assignment_verified", "child_resumed", "terminal_observed", "job_empty"];
const baseEvidence = [
  { creationTimeJobAssignment: "true", executablePath: "C:\\fixed\\SyntheticChildTree.exe",
    executableSha256: "c".repeat(64), workingDirectory: "C:\\attempt", workingDirectorySha256: "d".repeat(64) },
  { creationTicks: "1337", executableSha256: "c".repeat(64), pid: "42", role: "root", session: "1" },
  { breakawayAllowed: "false", memberCount: "1", rootPresent: "true" }, { resumed: "true" },
  { creationTicks: "1337", exitCode: "0", pid: "42", terminationRequested: "false" },
  { memberCount: "0", proved: "true" },
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const recordHash = (record) => { const { digest, ...body } = record; return hash(JSON.stringify(body)); };
function rechain(records) {
  let prior = "0".repeat(64);
  return records.map((record, index) => { const next = { ...record, priorDigest: prior, sequence: index + 1 };
    next.digest = recordHash(next); prior = next.digest; return next; });
}
function fixture(change = {}) {
  const expected = { ...identity, ...(change.context ?? {}) };
  const context = JSON.stringify(expected);
  let prior = "0".repeat(64);
  const records = eventNames.map((event, index) => {
    const evidence = { ...baseEvidence[index], ...(change.evidence?.[index] ?? {}) };
    const body = { attemptId: identity.attemptId, bootId: identity.bootId, event, evidence, fence: identity.fence,
      jobDigest: identity.jobDigest, observedUtc: `2026-09-12T12:00:0${index}Z`, priorDigest: prior,
      runtimeDigest: identity.runtimeDigest, schema: "overdrafter.native-attempt-journal-record.v1",
      sequence: index + 1, workerId: identity.workerId };
    const record = { attemptId: body.attemptId, bootId: body.bootId, digest: hash(JSON.stringify(body)), event: body.event,
      evidence: body.evidence, fence: body.fence, jobDigest: body.jobDigest, observedUtc: body.observedUtc,
      priorDigest: body.priorDigest, runtimeDigest: body.runtimeDigest, schema: body.schema,
      sequence: body.sequence, workerId: body.workerId };
    prior = record.digest; return record;
  });
  return { context, journal: JSON.stringify({ records, schema: "overdrafter.native-attempt-journal.v1" }), records };
}
function code(expected, action) {
  assert.throws(action, (error) => error?.code === expected && error.message === expected
    && error.stack === undefined && Object.getPrototypeOf(error) === null && !/canary|11111111|C:\\fixed/.test(error.message));
}

describe("closed journal parser", () => {
  it("derives a frozen value-free result from the complete valid chain", () => {
    const valid = fixture();
    const result = evaluateClosedJournal(valid.journal, valid.context);
    assert.deepEqual(result, { schema: "overdrafter.closed-journal-result.v1", backend: "windows-job-object-source-v1",
      sourceOnly: true, runtimeQualified: false, lifecycle: "finalized", evidenceEligible: true,
      recordCount: 6 });
    assert.equal(Object.isFrozen(result), true);
    assert.doesNotMatch(JSON.stringify(result), /pid|path|command|environment|stdout|stderr|attemptId/i);
  });

  it("rejects hostile values at both arguments without invoking hooks", () => {
    const valid = fixture(); let hooks = 0;
    const hostile = new Proxy({}, { get() { hooks++; throw new Error("canary"); },
      getPrototypeOf() { hooks++; throw new Error("canary"); } });
    const getter = {}; Object.defineProperty(getter, "value", { get() { hooks++; throw new Error("canary"); } });
    const primitive = { [Symbol.toPrimitive]() { hooks++; throw new Error("canary"); } };
    for (const value of [hostile, getter, primitive, new String(valid.journal), Promise.resolve(valid.journal), Symbol("x"), () => valid.journal]) {
      code("invalid_argument_type", () => evaluateClosedJournal(value, valid.context));
      code("invalid_argument_type", () => evaluateClosedJournal(valid.journal, value));
    }
    const cyclic = {}; cyclic.self = cyclic;
    code("invalid_argument_type", () => evaluateClosedJournal(cyclic, valid.context));
    assert.equal(hooks, 0);
  });

  it("rejects invalid, duplicate, alternate and nested JSON deterministically", () => {
    const valid = fixture();
    code("invalid_json", () => evaluateClosedJournal("{", valid.context));
    code("noncanonical_json", () => evaluateClosedJournal(valid.journal, ` ${valid.context}`));
    const duplicate = valid.context.replace('{"attemptId":', '{"attemptId":"ignored","attemptId":');
    code("noncanonical_json", () => evaluateClosedJournal(valid.journal, duplicate));
    const duplicateJournal = valid.journal.replace('{"records":', '{"schema":"overdrafter.native-attempt-journal.v1","records":');
    code("noncanonical_json", () => evaluateClosedJournal(duplicateJournal, valid.context));
    code("noncanonical_json", () => evaluateClosedJournal(valid.journal, valid.context.replace('"fence":7', '"fence":7e0')));
    code("noncanonical_json", () => evaluateClosedJournal(valid.journal, valid.context.replace("worker-1", "\\u0077orker-1")));
    const nested = JSON.stringify({ records: valid.records, schema: "overdrafter.native-attempt-journal.v1", extra: { deep: { value: 1 } } });
    code("invalid_schema", () => evaluateClosedJournal(nested, valid.context));
    const deep = `{"records":[],"schema":"overdrafter.native-attempt-journal.v1","extra":${"[".repeat(1000)}0${"]".repeat(1000)}}`;
    code("invalid_schema", () => evaluateClosedJournal(deep, valid.context));
    code("invalid_event", () => evaluateClosedJournal(valid.journal.replace('"launch_intent"', '"constructor"'), valid.context));
    code("invalid_schema", () => evaluateClosedJournal(valid.journal.replace('"attemptId":', '"__proto__":{},"attemptId":'), valid.context));
  });

  it("enforces byte, record, predecessor and evidence bounds", () => {
    const valid = fixture();
    code("input_limit", () => evaluateClosedJournal(valid.journal + " ".repeat(LIMITS.journalBytes), valid.context));
    code("input_limit", () => evaluateClosedJournal(valid.journal, valid.context + " ".repeat(LIMITS.contextBytes)));
    const many = JSON.stringify({ records: Array.from({ length: LIMITS.records + 1 }, () => null),
      schema: "overdrafter.native-attempt-journal.v1" });
    code("input_limit", () => evaluateClosedJournal(many, valid.context));
    code("invalid_evidence", () => { const item = fixture({ evidence: { 0: { executablePath: "x".repeat(513) } } });
      evaluateClosedJournal(item.journal, item.context); });
    assert.equal(LIMITS.predecessorSteps, LIMITS.records);
  });

  it("binds context, event order, record digest and causal identities", () => {
    const valid = fixture();
    for (const [key, value] of [["attemptId", "22222222-2222-7222-8222-222222222222"], ["bootId", "other"],
      ["fence", 8], ["jobDigest", "e".repeat(64)], ["runtimeDigest", "f".repeat(64)], ["workerId", "other"]])
      code("invalid_identity", () => evaluateClosedJournal(valid.journal, fixture({ context: { [key]: value } }).context));
    code("invalid_event", () => evaluateClosedJournal(valid.journal.replace('"child_identity"', '"constructor"'), valid.context));
    const reordered = fixture(); [reordered.records[1], reordered.records[2]] = [reordered.records[2], reordered.records[1]];
    code("invalid_order", () => evaluateClosedJournal(JSON.stringify({ records: rechain(reordered.records),
      schema: "overdrafter.native-attempt-journal.v1" }), reordered.context));
    code("invalid_chain", () => evaluateClosedJournal(valid.journal.replace(valid.records[0].digest, "e".repeat(64)), valid.context));
    const predecessor = fixture(); predecessor.records[2].priorDigest = "f".repeat(64); predecessor.records[2].digest = recordHash(predecessor.records[2]);
    code("invalid_chain", () => evaluateClosedJournal(JSON.stringify({ records: predecessor.records,
      schema: "overdrafter.native-attempt-journal.v1" }), predecessor.context));
    const executable = fixture({ evidence: { 1: { executableSha256: "e".repeat(64) } } });
    code("invalid_chain", () => evaluateClosedJournal(executable.journal, executable.context));
    const terminal = fixture({ evidence: { 4: { pid: "43" } } });
    code("invalid_chain", () => evaluateClosedJournal(terminal.journal, terminal.context));
    const time = fixture({ evidence: { 4: { creationTicks: "1338" } } });
    code("invalid_chain", () => evaluateClosedJournal(time.journal, time.context));
  });

  it("rejects non-success terminal evidence and malformed primitives", () => {
    for (const evidence of [{ exitCode: "1" }, { terminationRequested: "true" }]) {
      const item = fixture({ evidence: { 4: evidence } });
      code("ineligible_terminal", () => evaluateClosedJournal(item.journal, item.context));
    }
    for (const evidence of [{ memberCount: "1" }, { proved: "false" }]) { const item = fixture({ evidence: { 5: evidence } });
      code("invalid_evidence", () => evaluateClosedJournal(item.journal, item.context)); }
    const valid = fixture();
    code("invalid_identity", () => evaluateClosedJournal(valid.journal, valid.context.replace(identity.attemptId, "\\ud800")));
    code("invalid_evidence", () => evaluateClosedJournal(valid.journal.replace('"resumed":"true"', '"resumed":{}'), valid.context));
    code("invalid_evidence", () => evaluateClosedJournal(valid.journal.replace("C:\\\\fixed", "\\ud800"), valid.context));
  });
});
