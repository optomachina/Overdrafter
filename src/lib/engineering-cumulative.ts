/**
 * Prepared native v2 protocol. These pure checks establish consistency, not
 * authority. Callers must authenticate scope, lock the eligible attempt/fence,
 * and measure stored artifact bytes before admitting a successor transaction.
 * V1 operator imports deliberately cannot enter this protocol.
 */
export type NativeFile = Readonly<{ path: string; bytes: number; sha256: string }>;
export type NativeScope = Readonly<{ organizationId: string; projectId: string }>;
export type NativeCheck = Readonly<{ id: string; verdict: "pass"; evidenceSha256: string }>;
export type NativeProducer = Readonly<{
  jobId: string; attemptId: string; fence: number; inputSnapshotId: string;
  inputContextSha256: string; requestSha256: string; resultSha256: string;
}>;
export type NativeContext = Readonly<{
  schema: "overdrafter.prepared-assembly.v2"; packageId: "ovd-native04-assembly";
  scope: NativeScope; snapshotId: string; seedSnapshotId: string; sequence: number;
  producer: NativeProducer | null; createdAt: string; configuration: "Default";
  assemblyPath: "synthetic-assembly.SLDASM"; files: readonly NativeFile[];
  depthMm: number; checks: readonly NativeCheck[];
}>;
export type NativeJob = Readonly<{
  schema: "overdrafter.prepared-dimension-job.v2"; scope: NativeScope;
  jobId: string; attemptId: string; fence: number; inputSnapshotId: string;
  outputSnapshotId: string; seedSnapshotId: string; sequence: number;
  contextSha256: string; inputFiles: readonly NativeFile[]; expectedDepthMm: number;
  dimensionId: "baseline-depth"; depthMm: number; configuration: "Default";
  createdAt: string; requiredChecks: readonly string[];
}>;
export type NativeResult = Readonly<{
  schema: "overdrafter.prepared-dimension-result.v2"; scope: NativeScope;
  jobId: string; attemptId: string; fence: number; inputSnapshotId: string;
  outputSnapshotId: string; requestSha256: string; contextSha256: string;
  depthMm: number; outcome: "succeeded"; failureReason: null;
  inputFiles: readonly NativeFile[]; outputFiles: readonly NativeFile[];
  checks: readonly NativeCheck[];
  measurements: Readonly<{ beforeDepthMm: number; afterDepthMm: number; beforeVolumeMm3: number; afterVolumeMm3: number }>;
  candidateRoot: string; completedAt: string; adoption: "unadopted";
}>;

export const NATIVE_CHECKS: readonly string[] = Object.freeze([
  "input_identity", "native_integrity", "dimension", "assembly_references",
  "component_placements", "save_reopen", "source_preservation",
]);
export const NATIVE_SEED_FILES: readonly NativeFile[] = Object.freeze([
  Object.freeze({ path: "synthetic-assembly.SLDASM", bytes: 59987, sha256: "90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a" }),
  Object.freeze({ path: "parts/baseline-5mm.SLDPRT", bytes: 56144, sha256: "e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa" }),
  Object.freeze({ path: "parts/candidate-8mm.SLDPRT", bytes: 56171, sha256: "b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898" }),
]);
function need(value: boolean, reason: string): asserts value {
  if (!value) throw new TypeError(reason);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  need(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, "Expected a protocol object.");
  const record = value as Record<string, unknown>;
  need(Object.keys(record).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key)), "Missing or unexpected protocol fields.");
  return record;
}
function uuid(value: unknown): string {
  need(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) && value !== "00000000-0000-0000-0000-000000000000", "Expected a nonzero canonical UUID.");
  return value;
}
function digest(value: unknown): string {
  need(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "Expected a SHA-256 digest.");
  return value;
}
function number(value: unknown): number {
  need(typeof value === "number" && Number.isFinite(value), "Expected a finite number.");
  return value;
}
function integer(value: unknown, minimum: number): number {
  const result = number(value);
  need(Number.isSafeInteger(result) && result >= minimum, "Expected a bounded integer.");
  return result;
}
function depth(value: unknown): number {
  const result = number(value);
  need(result >= 6 && result <= 10, "Depth must be 6–10 mm.");
  return result;
}
function time(value: unknown): string {
  need(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "Expected a canonical UTC timestamp.");
  return value;
}
function scope(value: unknown): NativeScope {
  const item = object(value, ["organizationId", "projectId"]);
  return { organizationId: uuid(item.organizationId), projectId: uuid(item.projectId) };
}
function same(actual: unknown, expected: unknown, label: string): void {
  need(JSON.stringify(actual) === JSON.stringify(expected), `${label} mismatch.`);
}
function files(value: unknown): NativeFile[] {
  need(Array.isArray(value) && value.length === 3, "Exactly three native files required.");
  return value.map((entry, index) => {
    const item = object(entry, ["path", "bytes", "sha256"]);
    same(item.path, NATIVE_SEED_FILES[index].path, "Native path/order");
    const result = { path: NATIVE_SEED_FILES[index].path, bytes: integer(item.bytes, 1), sha256: digest(item.sha256) };
    need(result.bytes <= 16_000_000, "Native file exceeds prepared envelope.");
    if (index === 2) same(result, NATIVE_SEED_FILES[2], "Fixed companion identity");
    return result;
  });
}
function checks(value: unknown): NativeCheck[] {
  need(Array.isArray(value) && value.length === NATIVE_CHECKS.length, "All seven checks are mandatory.");
  return value.map((entry, index) => {
    const item = object(entry, ["id", "verdict", "evidenceSha256"]);
    same(item.id, NATIVE_CHECKS[index], "Check identity/order");
    same(item.verdict, "pass", "Check verdict");
    return { id: NATIVE_CHECKS[index], verdict: "pass", evidenceSha256: digest(item.evidenceSha256) };
  });
}
function producer(value: unknown): NativeProducer {
  const item = object(value, ["jobId", "attemptId", "fence", "inputSnapshotId", "inputContextSha256", "requestSha256", "resultSha256"]);
  return { jobId: uuid(item.jobId), attemptId: uuid(item.attemptId), fence: integer(item.fence, 1),
    inputSnapshotId: uuid(item.inputSnapshotId), inputContextSha256: digest(item.inputContextSha256),
    requestSha256: digest(item.requestSha256), resultSha256: digest(item.resultSha256) };
}
function parse(text: string): unknown {
  need(typeof text === "string" && text.length > 0 && !text.startsWith("\uFEFF") && new TextEncoder().encode(text).byteLength <= 65536, "Expected UTF-8 JSON without BOM, at most 64 KiB.");
  return JSON.parse(text);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Hash the exact wire bytes; serialization changes create a distinct subject. */
export async function nativeDigest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Validate snapshot claims. A claimed pass is not authenticated worker evidence. */
export function readNativeContext(text: string): NativeContext {
  const item = object(parse(text), ["schema", "packageId", "scope", "snapshotId", "seedSnapshotId", "sequence", "producer", "createdAt", "configuration", "assemblyPath", "files", "depthMm", "checks"]);
  same(item.schema, "overdrafter.prepared-assembly.v2", "Context schema");
  same(item.packageId, "ovd-native04-assembly", "Package");
  same(item.configuration, "Default", "Configuration");
  same(item.assemblyPath, "synthetic-assembly.SLDASM", "Assembly");
  const sequence = integer(item.sequence, 0), snapshotId = uuid(item.snapshotId), seedSnapshotId = uuid(item.seedSnapshotId);
  const inputFiles = files(item.files);
  let origin: NativeProducer | null = null, passed: NativeCheck[] = [];
  let expectedDepth = 5;
  if (sequence === 0) {
    same(snapshotId, seedSnapshotId, "Seed snapshot"); same(item.depthMm, 5, "Seed depth");
    same(item.producer, null, "Seed producer"); same(item.checks, [], "Seed checks");
    same(inputFiles, NATIVE_SEED_FILES, "Seed files");
  } else {
    origin = producer(item.producer); passed = checks(item.checks); expectedDepth = depth(item.depthMm);
    need(snapshotId !== seedSnapshotId && snapshotId !== origin.inputSnapshotId, "Snapshot lineage cannot self-reference.");
    need((sequence === 1) === (origin.inputSnapshotId === seedSnapshotId), "Seed lineage mismatch.");
  }
  return freeze({ schema: "overdrafter.prepared-assembly.v2", packageId: "ovd-native04-assembly", scope: scope(item.scope),
    snapshotId, seedSnapshotId, sequence, producer: origin, createdAt: time(item.createdAt), configuration: "Default",
    assemblyPath: "synthetic-assembly.SLDASM", files: inputFiles, depthMm: expectedDepth, checks: passed });
}
/** Bind a request to an exact context. Eligibility/authentication is a caller responsibility. */
export async function readNativeJob(text: string, contextText: string): Promise<NativeJob> {
  const context = readNativeContext(contextText);
  const item = object(parse(text), ["schema", "scope", "jobId", "attemptId", "fence", "inputSnapshotId", "outputSnapshotId", "seedSnapshotId", "sequence", "contextSha256", "inputFiles", "expectedDepthMm", "dimensionId", "depthMm", "configuration", "createdAt", "requiredChecks"]);
  same(item.schema, "overdrafter.prepared-dimension-job.v2", "Job schema");
  const jobScope = scope(item.scope), inputFiles = files(item.inputFiles);
  same(jobScope, context.scope, "Scope"); same(inputFiles, context.files, "Predecessor files");
  same(item.contextSha256, await nativeDigest(contextText), "Exact context bytes");
  same(item.inputSnapshotId, context.snapshotId, "Input snapshot"); same(item.seedSnapshotId, context.seedSnapshotId, "Seed lineage");
  same(item.sequence, context.sequence + 1, "Sequence"); same(item.expectedDepthMm, context.depthMm, "Starting depth");
  same(item.dimensionId, "baseline-depth", "Dimension"); same(item.configuration, "Default", "Configuration");
  same(item.requiredChecks, NATIVE_CHECKS, "Mandatory checks");
  const jobId = uuid(item.jobId), attemptId = uuid(item.attemptId), outputSnapshotId = uuid(item.outputSnapshotId);
  need(outputSnapshotId !== context.snapshotId && outputSnapshotId !== context.seedSnapshotId, "Output snapshot must be new.");
  if (context.producer) need(jobId !== context.producer.jobId && attemptId !== context.producer.attemptId, "Successor must have a new job and attempt.");
  const createdAt = time(item.createdAt);
  need(createdAt >= context.createdAt, "Job precedes its context.");
  return freeze({ schema: "overdrafter.prepared-dimension-job.v2", scope: jobScope, jobId, attemptId,
    fence: integer(item.fence, 1), inputSnapshotId: context.snapshotId, outputSnapshotId, seedSnapshotId: context.seedSnapshotId,
    sequence: integer(item.sequence, 1), contextSha256: digest(item.contextSha256), inputFiles, expectedDepthMm: context.depthMm,
    dimensionId: "baseline-depth", depthMm: depth(item.depthMm), configuration: "Default", createdAt, requiredChecks: [...NATIVE_CHECKS] });
}

/**
 * Construct a successor only from a successful bound receipt and independently
 * measured stored artifacts. `active` must come from the coordinator's locked
 * eligible-attempt record, never the request or worker payload. Persisting the
 * returned context/head still requires the same transaction's eligibility check.
 */
export async function verifiedNativeSuccessor(input: {
  contextText: string; jobText: string; resultText: string;
  active: { scope: NativeScope; inputSnapshotId: string; contextSha256: string; jobId: string; attemptId: string; fence: number; outputSnapshotId: string };
  storedOutputs: readonly NativeFile[]; storedEvidenceSha256: readonly string[];
}): Promise<NativeContext> {
  const context = readNativeContext(input.contextText), job = await readNativeJob(input.jobText, input.contextText);
  const current = object(input.active, ["scope", "inputSnapshotId", "contextSha256", "jobId", "attemptId", "fence", "outputSnapshotId"]);
  same(scope(current.scope), job.scope, "Active scope");
  for (const key of ["inputSnapshotId", "contextSha256", "jobId", "attemptId", "fence", "outputSnapshotId"] as const) same(current[key], job[key], `Active ${key}`);
  const result = object(parse(input.resultText), ["schema", "scope", "jobId", "attemptId", "fence", "inputSnapshotId", "outputSnapshotId", "requestSha256", "contextSha256", "depthMm", "outcome", "failureReason", "inputFiles", "outputFiles", "checks", "measurements", "candidateRoot", "completedAt", "adoption"]);
  same(result.schema, "overdrafter.prepared-dimension-result.v2", "Result schema");
  same(result.outcome, "succeeded", "Execution outcome"); same(result.failureReason, null, "Failure reason");
  same(result.adoption, "unadopted", "Adoption"); same(scope(result.scope), job.scope, "Result scope");
  for (const key of ["jobId", "attemptId", "fence", "inputSnapshotId", "outputSnapshotId", "contextSha256", "depthMm"] as const) same(result[key], job[key], `Result ${key}`);
  const requestSha256 = await nativeDigest(input.jobText);
  same(result.requestSha256, requestSha256, "Request bytes"); same(files(result.inputFiles), job.inputFiles, "Observed input files");
  const outputFiles = files(result.outputFiles), passed = checks(result.checks);
  same(outputFiles, files(input.storedOutputs), "Stored output identity");
  for (const check of passed) need(input.storedEvidenceSha256.includes(check.evidenceSha256), "Mandatory evidence is not stored.");
  if (job.depthMm !== job.expectedDepthMm) need(outputFiles[1].sha256 !== job.inputFiles[1].sha256, "Changed dimension requires changed native bytes.");
  const measured = object(result.measurements, ["beforeDepthMm", "afterDepthMm", "beforeVolumeMm3", "afterVolumeMm3"]);
  for (const [key, expected, tolerance] of [
    ["beforeDepthMm", job.expectedDepthMm, 1e-7], ["afterDepthMm", job.depthMm, 1e-7],
    ["beforeVolumeMm3", Math.PI * 100 * job.expectedDepthMm, 0.1], ["afterVolumeMm3", Math.PI * 100 * job.depthMm, 0.1],
  ] as const) need(Math.abs(number(measured[key]) - expected) <= tolerance, `Measured ${key} mismatch.`);
  need(typeof result.candidateRoot === "string" && /^[A-Za-z]:\\[^\r\n"]+$/.test(result.candidateRoot), "Expected a native candidate path observation.");
  const completedAt = time(result.completedAt); need(completedAt >= job.createdAt, "Result precedes its request.");
  return readNativeContext(JSON.stringify({ schema: "overdrafter.prepared-assembly.v2", packageId: context.packageId,
    scope: job.scope, snapshotId: job.outputSnapshotId, seedSnapshotId: job.seedSnapshotId, sequence: job.sequence,
    producer: { jobId: job.jobId, attemptId: job.attemptId, fence: job.fence, inputSnapshotId: job.inputSnapshotId,
      inputContextSha256: job.contextSha256, requestSha256, resultSha256: await nativeDigest(input.resultText) },
    createdAt: completedAt, configuration: job.configuration, assemblyPath: context.assemblyPath, files: outputFiles,
    depthMm: job.depthMm, checks: passed }));
}
