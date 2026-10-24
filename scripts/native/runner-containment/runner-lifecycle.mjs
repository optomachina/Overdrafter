import { createHash } from "node:crypto";
import { types } from "node:util";

export const LIFECYCLE_SCHEMA = "overdrafter.runner-containment-lifecycle.v1";
export const JOURNAL_SCHEMA = "overdrafter.native-attempt-journal-record.v1";
export const JOURNAL_EVENTS = Object.freeze([
  "launch_intent", "child_identity", "assignment_verified", "child_resumed", "terminal_observed", "job_empty",
]);
const SUCCESS_HISTORY = Object.freeze(["prepared", "intent_durable", "job_configured",
  "child_created_suspended_and_assigned", "child_identity_durable", "assignment_verified_durable",
  "child_resumed", "terminal_observed", "job_empty_proved", "finalized"]);
export const CAPABILITY_KEYS = Object.freeze([
  "suspendedCreation", "creationTimeJobAssignment", "descendantContainment", "retainedProcessHandle",
  "retainedJobHandle", "killOnOwnerClose", "wholeJobTermination", "membershipQuery", "creationTimeIdentity",
  "durableJournal", "filesystemIsolation", "networkIsolation", "uiIsolation", "credentialIsolation",
  "malwareScanning", "solidWorksQualified", "productionAdmitted", "runtimeQualified",
]);
export const WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES = Object.freeze({
  schema: "overdrafter.runner-containment-capabilities.v1", backend: "windows-job-object-source-v1",
  platform: "win32", sourceOnly: true, suspendedCreation: true, creationTimeJobAssignment: true,
  descendantContainment: true, retainedProcessHandle: true, retainedJobHandle: true, killOnOwnerClose: true,
  wholeJobTermination: true, membershipQuery: true, creationTimeIdentity: true, durableJournal: true,
  filesystemIsolation: false, networkIsolation: false, uiIsolation: false, credentialIsolation: false,
  malwareScanning: false, solidWorksQualified: false, productionAdmitted: false, runtimeQualified: false,
});
const transitions = Object.freeze({
  prepared: ["intent_durable"], intent_durable: ["job_configured"],
  job_configured: ["child_created_suspended_and_assigned", "failed_before_creation"],
  child_created_suspended_and_assigned: ["child_identity_durable", "cleanup_required"],
  child_identity_durable: ["assignment_verified_durable", "cleanup_required"],
  assignment_verified_durable: ["child_resumed", "cleanup_required"], child_resumed: ["terminal_observed", "cleanup_required"],
  terminal_observed: ["job_empty_proved", "cleanup_required"], job_empty_proved: ["finalized"],
  failed_before_creation: ["finalized"], cleanup_required: ["job_empty_proved", "process_uncertain"],
  finalized: [], process_uncertain: [],
});
const evidenceKeys = Object.freeze({
  launch_intent: ["creationTimeJobAssignment", "executablePath", "executableSha256", "workingDirectory", "workingDirectorySha256"],
  child_identity: ["creationTicks", "executableSha256", "pid", "role", "session"],
  assignment_verified: ["breakawayAllowed", "memberCount", "rootPresent"], child_resumed: ["resumed"],
  terminal_observed: ["creationTicks", "exitCode", "pid", "terminationRequested"], job_empty: ["memberCount", "proved"],
  failure: ["cleanup", "code", "jobEmpty"],
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{64}$/;
const token = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function dataObject(value, code = "invalid_evidence") {
  if (!value || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")
    || Object.values(descriptors).some((item) => !item.enumerable || item.get || item.set)) fail(code);
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]));
}
function dataArray(value, code) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") || descriptors.length.value > 128) fail(code);
  if (Object.keys(descriptors).length !== descriptors.length.value + 1) fail(code);
  const result = [];
  for (let index = 0; index < descriptors.length.value; index++) {
    const item = descriptors[index];
    if (!item || !item.enumerable || item.get || item.set) fail(code);
    result.push(item.value);
  }
  return result;
}
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("invalid_evidence"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${dataArray(value, "invalid_evidence").map(canonical).join(",")}]`;
  const safe = dataObject(value);
  return `{${Object.keys(safe).sort().map((key) => `${JSON.stringify(key)}:${canonical(safe[key])}`).join(",")}}`;
}
function snapshotEvidence(event, value) {
  if (typeof event !== "string") fail("invalid_evidence_schema");
  const values = dataObject(value);
  const keys = Object.keys(values).sort();
  if (keys.length > 8 || keys.some((key) => typeof values[key] !== "string" || Buffer.byteLength(values[key]) > 512)) fail("invalid_evidence");
  const allowed = evidenceKeys[event];
  if (!allowed || keys.join("\0") !== [...allowed].sort().join("\0")) fail("invalid_evidence_schema");
  const snapshot = Object.fromEntries(keys.map((key) => [key, values[key]]));
  const unsigned = /^\d+$/;
  if ((event === "launch_intent" && (snapshot.creationTimeJobAssignment !== "true" || !sha.test(snapshot.executableSha256)))
    || (event === "child_identity" && (!unsigned.test(snapshot.pid) || !unsigned.test(snapshot.creationTicks)
      || !unsigned.test(snapshot.session) || snapshot.role !== "root" || !sha.test(snapshot.executableSha256)))
    || (event === "assignment_verified" && (snapshot.breakawayAllowed !== "false" || snapshot.rootPresent !== "true"
      || !unsigned.test(snapshot.memberCount) || Number(snapshot.memberCount) < 1))
    || (event === "child_resumed" && snapshot.resumed !== "true")
    || (event === "terminal_observed" && (!unsigned.test(snapshot.pid) || !unsigned.test(snapshot.creationTicks)
      || !unsigned.test(snapshot.exitCode) || !["true", "false"].includes(snapshot.terminationRequested)))
    || (event === "job_empty" && (snapshot.proved !== "true" || snapshot.memberCount !== "0"))
    || (event === "failure" && (!["not_needed", "proved", "unproved"].includes(snapshot.cleanup)
      || !["true", "false"].includes(snapshot.jobEmpty) || !token.test(snapshot.code)))) fail("invalid_evidence_value");
  return Object.freeze(snapshot);
}
function validateIdentity(input) {
  input = dataObject(input, "invalid_identity");
  if (typeof input.attemptId !== "string" || !uuid.test(input.attemptId)
    || !Number.isSafeInteger(input.fence) || input.fence < 1
    || typeof input.workerId !== "string" || !token.test(input.workerId)
    || typeof input.bootId !== "string" || !token.test(input.bootId)
    || typeof input.runtimeDigest !== "string" || !sha.test(input.runtimeDigest)
    || typeof input.jobDigest !== "string" || !sha.test(input.jobDigest)) fail("invalid_identity");
  return input;
}
export function validateCapabilities(value) {
  value = dataObject(value, "invalid_capabilities");
  if (value.schema !== "overdrafter.runner-containment-capabilities.v1"
    || Object.entries(WINDOWS_JOB_OBJECT_SOURCE_CAPABILITIES).some(([key, expected]) => value[key] !== expected)
    || CAPABILITY_KEYS.some((key) => typeof value[key] !== "boolean")
    || Object.keys(value).some((key) => !["schema", "backend", "platform", "sourceOnly", ...CAPABILITY_KEYS].includes(key))) fail("invalid_capabilities");
  if (value.sourceOnly && (value.runtimeQualified || value.productionAdmitted || value.solidWorksQualified)) fail("capability_overclaim");
  if (value.descendantContainment && (!value.creationTimeJobAssignment || !value.retainedJobHandle
    || !value.wholeJobTermination || !value.membershipQuery)) fail("capability_dependency_missing");
  return Object.freeze({ ...value });
}
export function createLifecycle(input) {
  input = dataObject(input, "invalid_identity");
  const { attemptId, fence, backend } = input;
  const safeBackend = validateCapabilities(backend);
  if (typeof attemptId !== "string" || !uuid.test(attemptId) || !Number.isSafeInteger(fence) || fence < 1) fail("invalid_identity");
  return { schema: LIFECYCLE_SCHEMA, attemptId, fence, backend: safeBackend.backend,
    state: "prepared", history: ["prepared"], processUncertain: false };
}
export function advanceLifecycle(current, next) {
  const safe = dataObject(current, "invalid_lifecycle");
  const history = dataArray(safe.history, "invalid_lifecycle");
  if (safe.schema !== LIFECYCLE_SCHEMA || !transitions[safe.state] || safe.processUncertain) fail("invalid_lifecycle");
  if (!transitions[safe.state].includes(next)) {
    current.state = "process_uncertain"; current.processUncertain = true; history.push("process_uncertain"); current.history = history; return current;
  }
  current.state = next; current.processUncertain = next === "process_uncertain"; history.push(next); current.history = history; return current;
}
function journalBytes(records) {
  const prefix = '{"schema":"overdrafter.native-attempt-journal.v1","records":[';
  return Buffer.byteLength(prefix + records.map(canonical).join(",") + "]}");
}
export function journalRecordDigest(body) { return createHash("sha256").update(canonical(body)).digest("hex"); }
export function appendJournalRecord(records, input) {
  input = validateIdentity(input);
  records = dataArray(records, "invalid_evidence");
  if (records.length >= 128 || typeof input.observedUtc !== "string" || !utc.test(input.observedUtc)) fail("invalid_evidence");
  const sequence = records.length + 1;
  const priorDigest = sequence === 1 ? "0".repeat(64) : dataObject(records.at(-1), "invalid_evidence_chain").digest;
  if (typeof priorDigest !== "string" || !sha.test(priorDigest)) fail("invalid_evidence_chain");
  const evidence = snapshotEvidence(input.event, input.evidence);
  const body = { attemptId: input.attemptId, bootId: input.bootId, event: input.event, evidence,
    fence: input.fence, jobDigest: input.jobDigest, observedUtc: input.observedUtc, priorDigest,
    runtimeDigest: input.runtimeDigest, schema: JOURNAL_SCHEMA, sequence, workerId: input.workerId };
  const encoded = canonical(body);
  if (Buffer.byteLength(encoded) > 64 * 1024) fail("evidence_limit");
  const next = [...records, Object.freeze({ ...body, digest: journalRecordDigest(body) })];
  if (journalBytes(next) > 64 * 1024) fail("evidence_limit");
  return Object.freeze(next);
}
export function validateJournal(records, expectedIdentity) {
  expectedIdentity = validateIdentity(expectedIdentity);
  records = dataArray(records, "invalid_evidence_chain");
  if (records.length < 1) fail("invalid_evidence_chain");
  let expected = "0".repeat(64); const events = [], normalized = [];
  records.forEach((record, index) => {
    record = dataObject(record, "invalid_evidence_chain");
    const expectedKeys = ["attemptId", "bootId", "digest", "event", "evidence", "fence", "jobDigest",
      "observedUtc", "priorDigest", "runtimeDigest", "schema", "sequence", "workerId"];
    if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0")) fail("invalid_evidence_chain");
    const evidence = snapshotEvidence(record.event, record.evidence);
    const body = { attemptId: record.attemptId, bootId: record.bootId, event: record.event, evidence,
      fence: record.fence, jobDigest: record.jobDigest, observedUtc: record.observedUtc, priorDigest: record.priorDigest,
      runtimeDigest: record.runtimeDigest, schema: record.schema, sequence: record.sequence, workerId: record.workerId };
    if (record.schema !== JOURNAL_SCHEMA || record.sequence !== index + 1 || record.priorDigest !== expected
      || ["attemptId", "fence", "workerId", "bootId", "runtimeDigest", "jobDigest"].some((key) => record[key] !== expectedIdentity[key])
      || typeof record.observedUtc !== "string" || !utc.test(record.observedUtc)
      || typeof record.digest !== "string" || record.digest !== journalRecordDigest(body)) fail("invalid_evidence_chain");
    expected = record.digest; events.push(record.event); normalized.push(Object.freeze({ ...body, digest: record.digest }));
  });
  if (journalBytes(normalized) > 64 * 1024) fail("evidence_limit");
  const child = normalized.find((record) => record.event === "child_identity")?.evidence;
  const launch = normalized.find((record) => record.event === "launch_intent")?.evidence;
  const terminal = normalized.find((record) => record.event === "terminal_observed")?.evidence;
  if (child && terminal && (child.pid !== terminal.pid || child.creationTicks !== terminal.creationTicks)) fail("invalid_evidence_chain");
  if (launch && child && launch.executableSha256 !== child.executableSha256) fail("invalid_evidence_chain");
  const terminalCompleted = terminal?.exitCode === "0" && terminal?.terminationRequested === "false";
  return Object.freeze({ ...expectedIdentity, recordCount: records.length, journalDigest: expected,
    events: Object.freeze(events), terminalCompleted });
}
export function publicContainmentResult(input) {
  input = dataObject(input, "invalid_result");
  let { lifecycle, journal, operation, persistence, cleanup, evidenceEligible } = input;
  lifecycle = dataObject(lifecycle, "invalid_result"); journal = dataObject(journal, "invalid_result");
  const history = dataArray(lifecycle.history, "invalid_result");
  const events = dataArray(journal.events, "invalid_result");
  if (lifecycle.schema !== LIFECYCLE_SCHEMA || typeof lifecycle.attemptId !== "string"
    || !Number.isSafeInteger(lifecycle.fence) || typeof lifecycle.state !== "string"
    || typeof lifecycle.processUncertain !== "boolean" || history.some((item) => typeof item !== "string")
    || typeof journal.journalDigest !== "string" || !sha.test(journal.journalDigest)
    || typeof journal.attemptId !== "string" || !Number.isSafeInteger(journal.fence)
    || typeof journal.terminalCompleted !== "boolean" || events.some((item) => typeof item !== "string")
    || lifecycle.backend !== "windows-job-object-source-v1" || journal.attemptId !== lifecycle.attemptId || journal.fence !== lifecycle.fence
    || !["not_started", "completed", "failed"].includes(operation) || !["durable", "failed"].includes(persistence)
    || !["not_needed", "proved", "unproved"].includes(cleanup) || typeof evidenceEligible !== "boolean") fail("invalid_result");
  const eligible = evidenceEligible && operation === "completed" && lifecycle.state === "finalized"
    && history.join("\0") === SUCCESS_HISTORY.join("\0") && persistence === "durable"
    && cleanup !== "unproved" && !lifecycle.processUncertain && journal.terminalCompleted === true
    && events.join("\0") === JOURNAL_EVENTS.join("\0");
  return Object.freeze({ schema: "overdrafter.runner-containment-result.v1", backend: "windows-job-object-source-v1",
    sourceOnly: true, runtimeQualified: false, operation, persistence, cleanup, evidenceEligible: eligible,
    recordCount: journal.recordCount, journalDigest: journal.journalDigest });
}
export function quoteWindowsArgument(value) {
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) fail("invalid_argument");
  if (value.length > 0 && !/[\t "]/.test(value)) return value;
  let result = '"', slashes = 0;
  for (const character of value) {
    if (character === "\\") { slashes++; continue; }
    if (character === '"') result += "\\".repeat(slashes * 2 + 1) + '"';
    else result += "\\".repeat(slashes) + character;
    slashes = 0;
  }
  return result + "\\".repeat(slashes * 2) + '"';
}
