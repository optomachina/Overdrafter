import { createHash } from "node:crypto";

// Schema consistency is not authenticity, freshness, durability, containment, or runtime evidence.
export const LIMITS = Object.freeze({ journalBytes: 65536, contextBytes: 4096,
  records: 128, predecessorSteps: 128, evidenceFields: 8, evidenceValueBytes: 512 });
const JOURNAL_SCHEMA = "overdrafter.native-attempt-journal.v1";
const RECORD_SCHEMA = "overdrafter.native-attempt-journal-record.v1";
const RESULT_SCHEMA = "overdrafter.closed-journal-result.v1";
const EVENTS = Object.freeze(["launch_intent", "child_identity", "assignment_verified",
  "child_resumed", "terminal_observed", "job_empty"]);
const EVIDENCE_KEYS = Object.freeze([
  ["creationTimeJobAssignment", "executablePath", "executableSha256", "workingDirectory", "workingDirectorySha256"],
  ["creationTicks", "executableSha256", "pid", "role", "session"],
  ["breakawayAllowed", "memberCount", "rootPresent"], ["resumed"],
  ["creationTicks", "exitCode", "pid", "terminationRequested"], ["memberCount", "proved"],
]);
const CKEYS = ["attemptId", "bootId", "fence", "jobDigest", "runtimeDigest", "workerId"];
const RKEYS = ["attemptId", "bootId", "digest", "event", "evidence", "fence", "jobDigest",
  "observedUtc", "priorDigest", "runtimeDigest", "schema", "sequence", "workerId"];
const ALLOWED = new Set(["invalid_argument_type", "input_limit", "invalid_json", "noncanonical_json",
  "invalid_schema", "invalid_identity", "invalid_event", "invalid_evidence", "invalid_chain",
  "invalid_order", "ineligible_terminal"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{64}$/;
const UINT = /^\d{1,20}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;

function fail(code) {
  const error = Object.assign(Object.create(null), { name: "ClosedJournalError", code, message: code });
  throw Object.freeze(error);
}
function parse(text, limit) {
  if (typeof text !== "string") fail("invalid_argument_type");
  if (Buffer.byteLength(text) > limit) fail("input_limit");
  try { return JSON.parse(text); } catch { fail("invalid_json"); }
}
function exact(value, keys, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const own = Object.keys(value).sort();
  if (own.length !== keys.length || own.some((key, index) => key !== keys[index])) fail(code);
  return value;
}
function dense(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.keys(value).length !== value.length) fail("invalid_schema");
  if (value.length > LIMITS.records) fail("input_limit");
  return value;
}
function wellFormed(value) {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function context(value) {
  exact(value, CKEYS, "invalid_identity");
  if (!wellFormed(value.attemptId) || !UUID.test(value.attemptId) || !Number.isSafeInteger(value.fence) || value.fence < 1
    || !wellFormed(value.workerId) || !TOKEN.test(value.workerId) || !wellFormed(value.bootId) || !TOKEN.test(value.bootId)
    || !wellFormed(value.runtimeDigest) || !SHA.test(value.runtimeDigest)
    || !wellFormed(value.jobDigest) || !SHA.test(value.jobDigest)) fail("invalid_identity");
  return value;
}
function encodeContext(value) {
  return `{"attemptId":${JSON.stringify(value.attemptId)},"bootId":${JSON.stringify(value.bootId)},"fence":${value.fence},`
    + `"jobDigest":${JSON.stringify(value.jobDigest)},"runtimeDigest":${JSON.stringify(value.runtimeDigest)},"workerId":${JSON.stringify(value.workerId)}}`;
}
function evidence(value, eventIndex) {
  const keys = EVIDENCE_KEYS[eventIndex]; exact(value, keys, "invalid_evidence");
  if (keys.length > LIMITS.evidenceFields || keys.some((key) => !wellFormed(value[key])
    || Buffer.byteLength(value[key]) > LIMITS.evidenceValueBytes)) fail("invalid_evidence");
  const sha = (key) => SHA.test(value[key]);
  if ((eventIndex === 0 && (value.creationTimeJobAssignment !== "true" || !sha("executableSha256") || !sha("workingDirectorySha256")))
    || (eventIndex === 1 && (!UINT.test(value.creationTicks) || !UINT.test(value.pid) || !UINT.test(value.session)
      || value.role !== "root" || !sha("executableSha256")))
    || (eventIndex === 2 && (value.breakawayAllowed !== "false" || !/^[1-9]\d{0,2}$/.test(value.memberCount) || value.rootPresent !== "true"))
    || (eventIndex === 3 && value.resumed !== "true")
    || (eventIndex === 4 && (!UINT.test(value.creationTicks) || !UINT.test(value.exitCode) || !UINT.test(value.pid)
      || !["true", "false"].includes(value.terminationRequested)))
    || (eventIndex === 5 && (value.memberCount !== "0" || value.proved !== "true"))) fail("invalid_evidence");
  return value;
}
function encodeEvidence(value, eventIndex) {
  return `{${EVIDENCE_KEYS[eventIndex].map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(",")}}`;
}
function encodeRecord(value, eventIndex, includeDigest) {
  const digest = includeDigest ? `,"digest":${JSON.stringify(value.digest)}` : "";
  return `{"attemptId":${JSON.stringify(value.attemptId)},"bootId":${JSON.stringify(value.bootId)}${digest},`
    + `"event":${JSON.stringify(value.event)},"evidence":${encodeEvidence(value.evidence, eventIndex)},"fence":${value.fence},`
    + `"jobDigest":${JSON.stringify(value.jobDigest)},"observedUtc":${JSON.stringify(value.observedUtc)},`
    + `"priorDigest":${JSON.stringify(value.priorDigest)},"runtimeDigest":${JSON.stringify(value.runtimeDigest)},`
    + `"schema":${JSON.stringify(value.schema)},"sequence":${value.sequence},"workerId":${JSON.stringify(value.workerId)}}`;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function sameIdentity(record, expected) {
  return record.attemptId === expected.attemptId && record.bootId === expected.bootId && record.fence === expected.fence
    && record.jobDigest === expected.jobDigest && record.runtimeDigest === expected.runtimeDigest && record.workerId === expected.workerId;
}
function evaluate(journalText, contextText) {
  const expected = context(parse(contextText, LIMITS.contextBytes));
  if (encodeContext(expected) !== contextText) fail("noncanonical_json");
  const document = exact(parse(journalText, LIMITS.journalBytes), ["records", "schema"], "invalid_schema");
  if (document.schema !== JOURNAL_SCHEMA) fail("invalid_schema");
  const records = dense(document.records);
  if (records.length !== EVENTS.length) fail("invalid_order");
  let prior = "0".repeat(64), child, terminal;
  for (let index = 0; index < records.length; index++) {
    if (index >= LIMITS.predecessorSteps) fail("input_limit");
    const record = exact(records[index], RKEYS, "invalid_schema");
    if (typeof record.event !== "string" || !EVENTS.includes(record.event)) fail("invalid_event");
    if (record.event !== EVENTS[index]) fail("invalid_order");
    if (record.schema !== RECORD_SCHEMA || !Number.isSafeInteger(record.sequence) || record.sequence !== index + 1
      || !wellFormed(record.observedUtc) || !UTC.test(record.observedUtc)) fail("invalid_schema");
    if (!sameIdentity(record, expected)) fail("invalid_identity");
    if (!wellFormed(record.priorDigest) || record.priorDigest !== prior) fail("invalid_chain");
    const fields = evidence(record.evidence, index);
    if (!wellFormed(record.digest) || !SHA.test(record.digest) || record.digest !== sha256(encodeRecord(record, index, false))) fail("invalid_chain");
    prior = record.digest;
    if (index === 1) child = fields;
    if (index === 4) terminal = fields;
  }
  if (records[0].evidence.executableSha256 !== child.executableSha256
    || child.pid !== terminal.pid || child.creationTicks !== terminal.creationTicks) fail("invalid_chain");
  if (terminal.exitCode !== "0" || terminal.terminationRequested !== "false") fail("ineligible_terminal");
  const canonical = `{"records":[${records.map((record, index) => encodeRecord(record, index, true)).join(",")}],"schema":${JSON.stringify(JOURNAL_SCHEMA)}}`;
  if (canonical !== journalText) fail("noncanonical_json");
  return Object.freeze({ schema: RESULT_SCHEMA, backend: "windows-job-object-source-v1", sourceOnly: true,
    runtimeQualified: false, lifecycle: "finalized", evidenceEligible: true, recordCount: records.length });
}

export function evaluateClosedJournal(journalText, contextText) {
  try { return evaluate(journalText, contextText); }
  catch (error) { if (error && ALLOWED.has(error.code)) throw error; fail("invalid_schema"); }
}
