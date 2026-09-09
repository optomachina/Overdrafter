import { createEngineeringSnapshot, type EngineeringArtifact, type EngineeringSnapshot, type EngineeringSnapshotInput } from "@/lib/engineering-domain";
import { createEngineeringState, reduceEngineeringState, type EngineeringState } from "@/lib/engineering-state";

/** File identities are imported claims; this browser model does not inspect native file bytes. */
export type PreparedFile = Readonly<{ path: string; bytes: number; sha256: string }>;
export type PreparedContext = Readonly<{
  schema: "overdrafter.prepared-assembly.v1"; packageId: string;
  scope: Readonly<{ organizationId: string; projectId: string }>; capturedAt: string;
  configuration: "Default"; assemblyPath: string; files: readonly PreparedFile[];
  dimension: Readonly<{ id: string; occurrence: string; feature: string; partPath: string; unit: "mm"; baseline: number; minimum: number; maximum: number }>;
  limitations: readonly string[];
}>;
export type PreparedJob = Readonly<{
  schema: "overdrafter.prepared-dimension-job.v1"; jobId: string; attemptId: string;
  scope: PreparedContext["scope"]; contextSha256: string; inputFiles: readonly PreparedFile[];
  dimensionId: string; depthMm: number; configuration: "Default"; createdAt: string; requiredChecks: readonly string[];
}>;
export type PreparedResult = Readonly<{
  schema: "overdrafter.prepared-dimension-result.v1"; jobId: string; attemptId: string;
  requestSha256: string; contextSha256: string; depthMm: number; outcome: "succeeded" | "failed";
  failureReason: string | null; inputFiles: readonly PreparedFile[]; outputFiles: readonly PreparedFile[];
  checks: readonly Readonly<{ id: string; verdict: "pass" | "fail"; evidenceSha256: string }>[];
  measurements: Readonly<{ beforeDepthMm: number; afterDepthMm: number; beforeVolumeMm3: number; afterVolumeMm3: number }> | null;
  candidateRoot: string | null; completedAt: string; adoption: "unadopted";
}>;
export type WorkbenchRecord = Readonly<{
  job: PreparedJob; jobText: string; requestSha256: string; snapshotKey: string;
  result: PreparedResult | null; resultText: string | null;
  intent: "accepted"; execution: "waiting" | "succeeded" | "failed";
  checks: "unverified" | "passed" | "failed"; adoption: "unadopted";
}>;
/** Local handoff records are separate from worker tasks. No dispatcher, lease, execution authority or adoption is represented. */
export type Workbench = Readonly<{
  context: PreparedContext; contextText: string; contextSha256: string;
  records: readonly WorkbenchRecord[]; engineeringState: EngineeringState;
}>;

const FILES: readonly PreparedFile[] = [
  { path: "synthetic-assembly.SLDASM", bytes: 59987, sha256: "90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a" },
  { path: "parts/baseline-5mm.SLDPRT", bytes: 56144, sha256: "e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa" },
  { path: "parts/candidate-8mm.SLDPRT", bytes: 56171, sha256: "b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898" },
];
const DIMENSION = { id: "baseline-depth", occurrence: "baseline-5mm-1", feature: "OVD_QualificationExtrusion", partPath: FILES[1].path, unit: "mm" as const, baseline: 5, minimum: 6, maximum: 10 };
const SCOPE = { organizationId: "local-engineering", projectId: "prepared-assembly" };
const LIMITATIONS = ["Synthetic fixed assembly; no mates or drawings.", "Imported operator evidence; source freshness is rechecked by the runner."];
const CHECKS = ["input_identity", "native_integrity", "dimension", "assembly_references", "component_placements", "save_reopen", "source_preservation"];
const trusted = new WeakSet<object>();

function requireValue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}
function object(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  requireValue(!!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, `${name}: expected an object.`);
  requireValue(Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)), `${name}: missing or unexpected fields.`);
  return value as Record<string, unknown>;
}
function parse(text: string, name: string): unknown {
  requireValue(typeof text === "string" && text.length > 0 && !text.startsWith("\uFEFF"), `${name}: expected nonempty UTF-8 JSON without a BOM.`);
  requireValue(new TextEncoder().encode(text).byteLength <= 2_000_000, `${name}: exceeds the 2 MB import limit.`);
  try { return JSON.parse(text); } catch { throw new TypeError(`${name}: invalid JSON.`); }
}
function nonempty(value: unknown, name: string): string {
  requireValue(typeof value === "string" && value.trim().length > 0 && value === value.trim(), `${name}: expected nonempty text.`);
  return value;
}
function digest(value: unknown, name: string): string {
  requireValue(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `${name}: expected a lowercase SHA-256 digest.`);
  return value;
}
function timestamp(value: unknown, name: string): string {
  const result = nonempty(value, name);
  requireValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) && Number.isFinite(Date.parse(result)) && new Date(result).toISOString() === result, `${name}: expected a canonical UTC timestamp.`);
  return result;
}
function finite(value: unknown, name: string): number {
  requireValue(typeof value === "number" && Number.isFinite(value), `${name}: expected a finite number.`);
  return value;
}
function uuid(value: unknown, name: string): string {
  const result = nonempty(value, name);
  requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result), `${name}: expected a lowercase UUID v4.`);
  return result;
}
function equal(actual: unknown, expected: unknown, name: string): void {
  requireValue(JSON.stringify(actual) === JSON.stringify(expected), `${name}: does not match the prepared package.`);
}
function fixedObject(value: unknown, expected: Record<string, unknown>, name: string): void {
  const input = object(value, Object.keys(expected), name);
  Object.entries(expected).forEach(([key, expectedValue]) => equal(input[key], expectedValue, `${name}.${key}`));
}
function files(value: unknown, exact: boolean, name: string): PreparedFile[] {
  requireValue(Array.isArray(value), `${name}: expected a file list.`);
  const result = value.map((entry) => {
    const item = object(entry, ["path", "bytes", "sha256"], name);
    const path = nonempty(item.path, `${name}.path`);
    requireValue(FILES.some((file) => file.path === path), `${name}: unsupported file path.`);
    const bytes = finite(item.bytes, `${name}.bytes`);
    requireValue(Number.isSafeInteger(bytes) && bytes > 0, `${name}: file bytes must be a positive safe integer.`);
    return { path, bytes, sha256: digest(item.sha256, `${name}.sha256`) };
  });
  requireValue(new Set(result.map((file) => file.path)).size === result.length, `${name}: duplicate file path.`);
  if (exact) equal(result, FILES, name);
  return result;
}
function context(value: unknown): PreparedContext {
  const input = object(value, ["schema", "packageId", "scope", "capturedAt", "configuration", "assemblyPath", "files", "dimension", "limitations"], "Context");
  fixedObject(input.scope, SCOPE, "Context scope");
  fixedObject(input.dimension, DIMENSION, "Context dimension");
  equal(input.schema, "overdrafter.prepared-assembly.v1", "Context schema");
  equal(input.packageId, "ovd-native04-assembly", "Context package ID");
  equal(input.configuration, "Default", "Context configuration");
  equal(input.assemblyPath, FILES[0].path, "Context assembly path");
  equal(input.limitations, LIMITATIONS, "Context limitations");
  return { schema: "overdrafter.prepared-assembly.v1", packageId: "ovd-native04-assembly", scope: { ...SCOPE }, capturedAt: timestamp(input.capturedAt, "Context capture time"), configuration: "Default", assemblyPath: FILES[0].path, files: files(input.files, true, "Context files"), dimension: { ...DIMENSION }, limitations: [...LIMITATIONS] };
}
function depth(value: unknown): number {
  const result = finite(value, "Depth in mm");
  requireValue(result >= DIMENSION.minimum && result <= DIMENSION.maximum, "Depth must be between 6 and 10 mm.");
  return result;
}
async function sha256(text: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function seal(value: Workbench): Workbench {
  // Check the escaped, aggregate representation before accepting another record.
  requireValue(new TextEncoder().encode(savedText(value)).byteLength <= 2_000_000, "Saved workbench exceeds the 2 MB storage budget. Previous requests and evidence were kept.");
  freeze(value); trusted.add(value); return value;
}
function admit(value: Workbench): void {
  requireValue(trusted.has(value), "Workbench was not validated. Restore saved JSON before using it.");
}

/** Binds imported claims and this handoff protocol; toolchainHash does not assert a measured native installation. */
async function baseline(input: PreparedContext, contextSha256: string): Promise<EngineeringSnapshotInput> {
  const artifacts: EngineeringArtifact[] = input.files.map((file) => ({
    artifactId: file.path, scope: input.scope, kind: "native_cad", contentHash: file.sha256,
    document: { scope: input.scope, documentId: file.path, canonicalPartId: null, partVersionId: null, configurationId: input.configuration, nativeVersion: null, officialRevision: null, observedAt: input.capturedAt, ownerId: "imported-operator-evidence" },
  }));
  const manifest = await sha256(JSON.stringify(input.files));
  return {
    snapshotId: contextSha256,
    binding: { scope: input.scope, baselineSnapshotId: contextSha256, baselineManifestHash: manifest, includedDecisions: [], requirementsHash: await sha256(JSON.stringify(input.dimension)), artifactManifestHash: manifest, toolchainHash: await sha256("Imported prepared-dimension handoff protocol v1; native toolchain not attested"), verificationPolicyHash: await sha256(JSON.stringify({ checks: CHECKS, depthToleranceMm: 1e-7, volumeToleranceMm3: 0.1 })) },
    request: { id: input.packageId, scope: input.scope, text: "Import declared synthetic assembly context.", desiredOutcome: "Prepare independent dimension-change requests.", selectedReferences: artifacts.map((item) => item.document), statements: [] }, artifacts,
  };
}

/** Validates the exact synthetic manifest and retains its original text for hashing and replay. */
export async function importContext(text: string): Promise<Workbench> {
  requireValue(typeof text === "string" && new TextEncoder().encode(text).byteLength <= 65536, "Context: exceeds the Workstation 64 KiB limit.");
  const prepared = context(parse(text, "Context"));
  const contextSha256 = await sha256(text);
  return seal({ context: prepared, contextText: text, contextSha256, records: [], engineeringState: createEngineeringState(await baseline(prepared, contextSha256)) });
}
/** Alias for creating a workbench from an imported prepared context. */
export const create = importContext;

function job(value: unknown, workbench: Workbench): PreparedJob {
  const input = object(value, ["schema", "jobId", "attemptId", "scope", "contextSha256", "inputFiles", "dimensionId", "depthMm", "configuration", "createdAt", "requiredChecks"], "Job");
  equal(input.schema, "overdrafter.prepared-dimension-job.v1", "Job schema");
  fixedObject(input.scope, SCOPE, "Job scope");
  equal(input.contextSha256, workbench.contextSha256, "Job context digest");
  equal(input.dimensionId, DIMENSION.id, "Job dimension ID");
  equal(input.configuration, "Default", "Job configuration");
  equal(input.requiredChecks, CHECKS, "Job required checks");
  const createdAt = timestamp(input.createdAt, "Job creation time");
  requireValue(createdAt >= workbench.context.capturedAt, "Job predates its context.");
  return { schema: "overdrafter.prepared-dimension-job.v1", jobId: uuid(input.jobId, "Job ID"), attemptId: uuid(input.attemptId, "Attempt ID"), scope: { ...SCOPE }, contextSha256: workbench.contextSha256, inputFiles: files(input.inputFiles, true, "Job input files"), dimensionId: DIMENSION.id, depthMm: depth(input.depthMm), configuration: "Default", createdAt, requiredChecks: [...CHECKS] };
}
function acceptDecision(state: EngineeringState, reference: EngineeringSnapshot["binding"]["includedDecisions"][number]): EngineeringState {
  const proposed = reduceEngineeringState(state, { type: "propose", expectedRevision: state.revision, actorId: "local-operator", reference, dependencies: [] });
  requireValue(proposed.ok, "Engineering intent proposal was rejected.");
  const accepted = reduceEngineeringState(proposed.state, { type: "accept", expectedRevision: proposed.state.revision, actorId: "local-operator", reference });
  requireValue(accepted.ok, "Engineering intent acceptance was rejected.");
  return accepted.state;
}
async function appendJob(workbench: Workbench, jobText: string): Promise<Workbench> {
  requireValue(workbench.records.length < 5, "This workbench already has five requests. Import a context to start another workbench.");
  const prepared = job(parse(jobText, "Job"), workbench);
  equal(jobText, JSON.stringify(prepared, null, 2) + "\n", "Exact job text");
  requireValue(!workbench.records.some((item) => item.job.jobId === prepared.jobId || item.job.attemptId === prepared.attemptId), "Duplicate job or attempt ID.");
  const requestSha256 = await sha256(jobText);
  const reference = { decisionId: prepared.jobId, revisionId: prepared.attemptId, contentHash: requestSha256 };
  const base = workbench.engineeringState.baseline;
  const snapshot = createEngineeringSnapshot({
    snapshotId: prepared.jobId, binding: { ...base.binding, includedDecisions: [reference] }, artifacts: base.artifacts,
    request: { ...base.request, id: prepared.jobId, text: `Set baseline extrusion depth to ${prepared.depthMm} mm.`, desiredOutcome: "A separately verified, unadopted private candidate.", statements: [{ id: DIMENSION.id, kind: "objective", knowledgeState: "unknown", text: "Requested candidate depth; execution is not yet observed.", quantity: { value: prepared.depthMm, unit: "mm" }, confidence: null, evidence: [{ kind: "decision", sourceId: prepared.jobId, contentHash: requestSha256 }] }] },
  });
  const record: WorkbenchRecord = { job: prepared, jobText, requestSha256, snapshotKey: snapshot.canonicalKey, result: null, resultText: null, intent: "accepted", execution: "waiting", checks: "unverified", adoption: "unadopted" };
  return seal({ ...workbench, engineeringState: acceptDecision(workbench.engineeringState, reference), records: [...workbench.records, record] });
}
/** Records independent accepted intent; exporting a job never claims native dispatch or a lease. */
export async function queue(workbench: Workbench, depthMm: number): Promise<Workbench> {
  admit(workbench);
  const prepared: PreparedJob = { schema: "overdrafter.prepared-dimension-job.v1", jobId: crypto.randomUUID(), attemptId: crypto.randomUUID(), scope: workbench.context.scope, contextSha256: workbench.contextSha256, inputFiles: workbench.context.files, dimensionId: DIMENSION.id, depthMm: depth(depthMm), configuration: "Default", createdAt: new Date().toISOString(), requiredChecks: [...CHECKS] };
  return appendJob(workbench, JSON.stringify(prepared, null, 2) + "\n");
}
/** Returns the exact job bytes represented as UTF-8 text, including the final newline. */
export function getJobText(record: WorkbenchRecord): string { return record.jobText; }

function checks(value: unknown): PreparedResult["checks"] {
  requireValue(Array.isArray(value), "Result checks: expected a list.");
  const result = value.map((entry) => {
    const item = object(entry, ["id", "verdict", "evidenceSha256"], "Result check");
    const id = nonempty(item.id, "Result check ID");
    requireValue(CHECKS.includes(id), "Result contains an unsupported check.");
    requireValue(item.verdict === "pass" || item.verdict === "fail", "Result check verdict must be pass or fail.");
    return { id, verdict: item.verdict as "pass" | "fail", evidenceSha256: digest(item.evidenceSha256, "Check evidence digest") };
  });
  requireValue(new Set(result.map((item) => item.id)).size === result.length, "Result contains duplicate checks.");
  return result;
}
function measurements(value: unknown): PreparedResult["measurements"] {
  if (value === null) return null;
  const item = object(value, ["beforeDepthMm", "afterDepthMm", "beforeVolumeMm3", "afterVolumeMm3"], "Measurements");
  return { beforeDepthMm: finite(item.beforeDepthMm, "Before depth"), afterDepthMm: finite(item.afterDepthMm, "After depth"), beforeVolumeMm3: finite(item.beforeVolumeMm3, "Before volume"), afterVolumeMm3: finite(item.afterVolumeMm3, "After volume") };
}
function candidateRoot(value: unknown): string | null {
  if (value === null) return null;
  const path = nonempty(value, "Candidate root");
  requireValue(/^[A-Za-z]:[\\/]/.test(path), "Candidate root must be an absolute Windows path.");
  const parts = path.slice(3).split(/[\\/]/);
  requireValue(parts.length > 0 && parts.every(validPathSegment), "Candidate root contains an invalid path segment.");
  return path;
}
function validPathSegment(part: string): boolean {
  return !!part && part !== "." && part !== ".." && !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !Array.from(part).some((character) => character.charCodeAt(0) < 32);
}
function successful(result: PreparedResult, record: WorkbenchRecord): void {
  requireValue(result.failureReason === null, "Successful result cannot include a failure reason.");
  requireValue(result.checks.length === CHECKS.length && result.checks.every((check) => check.verdict === "pass"), "Success requires all seven mandatory checks to pass.");
  requireValue(result.outputFiles.length === FILES.length && result.candidateRoot !== null, "Success requires the complete private output package.");
  const target = result.outputFiles.find((file) => file.path === DIMENSION.partPath)!;
  requireValue(target.sha256 !== FILES[1].sha256, "Successful output did not change the target part.");
  equal(result.outputFiles.find((file) => file.path === FILES[2].path), FILES[2], "Unchanged companion output");
  const measured = result.measurements;
  requireValue(measured !== null, "Success requires measured geometry.");
  requireValue(Math.abs(measured.beforeDepthMm - 5) <= 1e-7 && Math.abs(measured.afterDepthMm - record.job.depthMm) <= 1e-7, "Measured depth does not match the requested dimension.");
  requireValue(Math.abs(measured.beforeVolumeMm3 - Math.PI * 100 * 5) <= 0.1 && Math.abs(measured.afterVolumeMm3 - Math.PI * 100 * record.job.depthMm) <= 0.1, "Measured cylinder volume does not match the requested geometry.");
}
function result(value: unknown, record: WorkbenchRecord): PreparedResult {
  const input = object(value, ["schema", "jobId", "attemptId", "requestSha256", "contextSha256", "depthMm", "outcome", "failureReason", "inputFiles", "outputFiles", "checks", "measurements", "candidateRoot", "completedAt", "adoption"], "Result");
  equal(input.schema, "overdrafter.prepared-dimension-result.v1", "Result schema");
  equal(input.jobId, record.job.jobId, "Result job ID");
  equal(input.attemptId, record.job.attemptId, "Result attempt ID");
  equal(digest(input.requestSha256, "Result request digest"), record.requestSha256, "Result request digest");
  equal(digest(input.contextSha256, "Result context digest"), record.job.contextSha256, "Result context digest");
  equal(input.depthMm, record.job.depthMm, "Result depth");
  equal(input.adoption, "unadopted", "Result adoption");
  requireValue(input.outcome === "succeeded" || input.outcome === "failed", "Result outcome must be succeeded or failed.");
  const completedAt = timestamp(input.completedAt, "Result completion time");
  requireValue(completedAt >= record.job.createdAt, "Result is stale: completion predates this request.");
  let failureReason: string | null = null;
  if (input.failureReason !== null) failureReason = nonempty(input.failureReason, "Failure reason");
  if (input.outcome === "failed") requireValue(failureReason !== null, "Failed result requires a failure reason.");
  const prepared: PreparedResult = { schema: "overdrafter.prepared-dimension-result.v1", jobId: record.job.jobId, attemptId: record.job.attemptId, requestSha256: record.requestSha256, contextSha256: record.job.contextSha256, depthMm: record.job.depthMm, outcome: input.outcome, failureReason, inputFiles: files(input.inputFiles, input.outcome === "succeeded", "Result input files"), outputFiles: files(input.outputFiles, false, "Result output files"), checks: checks(input.checks), measurements: measurements(input.measurements), candidateRoot: candidateRoot(input.candidateRoot), completedAt, adoption: "unadopted" };
  if (prepared.outcome === "succeeded") successful(prepared, record);
  return prepared;
}

/** Imports operator evidence, not authenticated native authority. Identical receipts are idempotent; contradictions are rejected. */
export async function importResult(workbench: Workbench, text: string): Promise<Workbench> {
  admit(workbench);
  const input = parse(text, "Result");
  requireValue(!!input && typeof input === "object" && "jobId" in input, "Result is missing its job ID.");
  const record = workbench.records.find((item) => item.job.jobId === input.jobId);
  requireValue(!!record, "Result belongs to an unknown request.");
  const prepared = result(input, record);
  if (record.resultText !== null) {
    requireValue(record.resultText === text, "A different result is already recorded for this attempt.");
    return workbench;
  }
  let checkState: WorkbenchRecord["checks"] = "failed";
  if (prepared.outcome === "succeeded") checkState = "passed";
  const updated: WorkbenchRecord = { ...record, result: prepared, resultText: text, execution: prepared.outcome, checks: checkState };
  return seal({ ...workbench, records: workbench.records.map((item) => item === record ? updated : item) });
}

/** Saves replay inputs and binding checksums only; browser storage errors remain the caller's responsibility. */
export function serialize(workbench: Workbench): string {
  admit(workbench);
  return savedText(workbench);
}
function savedText(workbench: Workbench): string {
  return JSON.stringify({ schema: "overdrafter.prepared-workbench.v1", context: workbench.context, contextText: workbench.contextText, contextSha256: workbench.contextSha256, records: workbench.records.map((record) => ({ jobText: record.jobText, requestSha256: record.requestSha256, snapshotKey: record.snapshotKey, resultText: record.resultText })) });
}
/** Revalidates and replays saved text; supplied statuses, altered snapshots and unverifiable result claims are never trusted. */
export async function restore(text: string): Promise<Workbench> {
  const input = object(parse(text, "Saved workbench"), ["schema", "context", "contextText", "contextSha256", "records"], "Saved workbench");
  equal(input.schema, "overdrafter.prepared-workbench.v1", "Saved workbench schema");
  requireValue(typeof input.contextText === "string", "Saved context text must be a string.");
  let workbench = await importContext(input.contextText);
  equal(context(input.context), workbench.context, "Saved normalized context");
  equal(input.contextSha256, workbench.contextSha256, "Saved context digest");
  requireValue(Array.isArray(input.records) && input.records.length <= 5, "Saved workbench permits at most five requests.");
  for (const entry of input.records) {
    const saved = object(entry, ["jobText", "requestSha256", "snapshotKey", "resultText"], "Saved request");
    requireValue(typeof saved.jobText === "string", "Saved job text must be a string.");
    workbench = await appendJob(workbench, saved.jobText);
    const appended = workbench.records[workbench.records.length - 1];
    equal(saved.requestSha256, appended.requestSha256, "Saved request digest");
    equal(saved.snapshotKey, appended.snapshotKey, "Saved snapshot binding");
    if (saved.resultText !== null) {
      requireValue(typeof saved.resultText === "string", "Saved result text must be a string or null.");
      workbench = await importResult(workbench, saved.resultText);
    }
  }
  return workbench;
}
