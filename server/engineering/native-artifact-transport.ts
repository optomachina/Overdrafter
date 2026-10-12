import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { registerMeasuredNativeResult, type NativeRegistrationRepository } from "./native-result-registration";
import { NATIVE_RESULT_ROLE_LIMITS, type NativeResultRole } from "./native-result-bytes";

export const NATIVE_ARTIFACT_SCHEMA = "overdrafter.native-artifact-transfer.v1";
const PATH = "/functions/v1/engineering-worker-artifact";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX = 16_000_000;
const DEADLINE_MS = 30_000;

export type NativeArtifactScope = Readonly<{
  organizationId: string; projectId: string; workerId: string; installationId: string;
  bootId: string; sessionId: string; taskId: string; attemptId: string; fence: number;
  inputSnapshotId: string; candidateSnapshotId: string; predecessorAttemptId: string | null;
}>;
export type InputArtifact = Readonly<{ id: string; bytes: number; sha256: string }>;
export type ArtifactAdmission = Readonly<{ scope: NativeArtifactScope; input: InputArtifact | null }>;

/** Trusted adapters resolve immutable input IDs, current worker/attempt authority,
 * and conditional-create output objects. The worker never chooses a Storage path.
 * putImmutableOutput must replay identical bytes as one object and reject changed
 * bytes for the same attempt and role. The registry's owner-only SQL is the final
 * current-attempt and exact Storage-version check. */
export type NativeArtifactRuntime = Readonly<{
  enabled: () => boolean;
  authorize: (request: Readonly<{ scope: NativeArtifactScope; tokenSha256: string;
    direction: "input" | "output"; artifactId: string | null; role: NativeResultRole | null }>) => Promise<ArtifactAdmission | null>;
  readInput: (id: string, signal: AbortSignal) => Promise<Response>;
  putImmutableOutput: (scope: NativeArtifactScope, role: NativeResultRole, bytes: Uint8Array,
    signal: AbortSignal) => Promise<void>;
  registration: NativeRegistrationRepository;
}>;

function id(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value) && value !== "00000000-0000-0000-0000-000000000000";
}
function scope(value: unknown): value is NativeArtifactScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = ["organizationId", "projectId", "workerId", "installationId", "bootId", "sessionId",
    "taskId", "attemptId", "fence", "inputSnapshotId", "candidateSnapshotId", "predecessorAttemptId"];
  return Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key))
    && keys.filter((key) => !["fence", "predecessorAttemptId"].includes(key)).every((key) => id(v[key]))
    && Number.isSafeInteger(v.fence) && (v.fence as number) >= 1 && (v.fence as number) < Number.MAX_SAFE_INTEGER
    && (v.predecessorAttemptId === null || id(v.predecessorAttemptId));
}
function failure(status: number, code: string): Response {
  return new Response(JSON.stringify({ schema: NATIVE_ARTIFACT_SCHEMA, error: code }), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
type TransferBudget = Readonly<{ signal: AbortSignal; deadline: number; check: () => void }>;
function bounded<T>(start: () => Promise<T>, budget: TransferBudget, discard?: (value: T) => void): Promise<T> {
  const { signal } = budget;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", stop);
    const stop = () => { cleanup(); reject(new Error("interrupted")); };
    signal.addEventListener("abort", stop, { once: true });
    try { budget.check(); } catch { stop(); return; }
    void (async () => {
      try {
        const value = await start();
        cleanup();
        try { budget.check(); } catch (error) { discard?.(value); throw error; }
        resolve(value);
      } catch (error) { cleanup(); reject(error); }
    })();
  });
}
async function measured(response: Response, expectedBytes: number, expectedSha: string,
  budget: TransferBudget): Promise<Uint8Array> {
  if (response.status !== 200 || response.redirected || !response.body
    || response.headers.get("content-encoding") || (response.headers.get("content-length") !== null
      && Number(response.headers.get("content-length")) !== expectedBytes)) throw new Error("invalid object response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let size = 0, count = 0, complete = false;
  try {
    while (true) {
      const part = await bounded(() => reader.read(), budget);
      if (part.done) { complete = true; break; }
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0 || ++count > 4096) throw new Error("invalid object stream");
      size += part.value.byteLength;
      if (size > expectedBytes || size > MAX) throw new Error("object too large");
      hash.update(part.value); chunks.push(new Uint8Array(part.value));
    }
  } finally {
    if (complete) reader.releaseLock(); else void reader.cancel().catch(() => undefined);
  }
  if (size !== expectedBytes || hash.digest("hex") !== expectedSha) throw new Error("object mismatch");
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  budget.check();
  return bytes;
}
function parse(request: Request) {
  const url = new URL(request.url);
  if (url.pathname !== PATH || url.search || url.hash || request.headers.has("origin")
    || request.headers.has("cookie") || request.headers.has("content-encoding")
    || url.protocol !== "https:") return null;
  const rawScope = request.headers.get("x-overdrafter-scope") ?? "";
  if (rawScope.length < 1 || rawScope.length > 2048) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(rawScope); } catch { return null; }
  if (!scope(parsed)) return null;
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer odw_[0-9a-f]{64}$/.test(authorization)) return null;
  return { scope: parsed, tokenSha256: createHash("sha256").update(authorization.slice(7), "utf8").digest("hex") };
}
type Transfer = Readonly<{ direction: "input" | "output"; artifactId: string | null;
  role: NativeResultRole | null; expectedBytes: number; expectedSha: string }>;
function transferHeaders(request: Request): Transfer | null {
  const direction = request.method === "GET" ? "input" : "output";
  const artifactId = request.headers.get("x-overdrafter-artifact-id");
  const role = request.headers.get("x-overdrafter-role") as NativeResultRole | null;
  if (direction === "input") {
    if (!id(artifactId) || role !== null) return null;
  } else if (artifactId !== null || !role || !Object.hasOwn(NATIVE_RESULT_ROLE_LIMITS, role)) return null;
  const expectedBytes = Number(request.headers.get("x-overdrafter-bytes"));
  const expectedSha = request.headers.get("x-overdrafter-sha256");
  const limit = direction === "input" ? MAX : NATIVE_RESULT_ROLE_LIMITS[role!];
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > limit
    || !expectedSha || !SHA.test(expectedSha)) return null;
  return { direction, artifactId, role, expectedBytes, expectedSha };
}
function admissionMatches(admission: ArtifactAdmission | null, scope: NativeArtifactScope, transfer: Transfer): boolean {
  if (!admission || !isDeepStrictEqual(admission.scope, scope)) return false;
  if (transfer.direction === "output") return true;
  return admission.input?.id === transfer.artifactId && admission.input.bytes === transfer.expectedBytes
    && admission.input.sha256 === transfer.expectedSha;
}
async function download(runtime: NativeArtifactRuntime, transfer: Transfer, admission: ArtifactAdmission,
  authorize: () => Promise<ArtifactAdmission | null>, budget: TransferBudget): Promise<Response> {
  const bytes = await measured(await bounded(() => runtime.readInput(transfer.artifactId!, budget.signal), budget,
    (late) => { void late.body?.cancel().catch(() => undefined); }),
    transfer.expectedBytes, transfer.expectedSha, budget);
  const fresh = await bounded(authorize, budget);
  if (!fresh || !isDeepStrictEqual(fresh, admission)) return failure(403, "transfer_denied");
  return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream",
    "content-length": String(bytes.byteLength), "x-overdrafter-sha256": transfer.expectedSha, "cache-control": "no-store" } });
}
async function upload(runtime: NativeArtifactRuntime, request: Request, scope: NativeArtifactScope, transfer: Transfer,
  admission: ArtifactAdmission, authorize: () => Promise<ArtifactAdmission | null>, budget: TransferBudget): Promise<Response> {
  if (request.headers.get("content-type") !== "application/octet-stream"
    || (request.headers.get("content-length") !== null
      && Number(request.headers.get("content-length")) !== transfer.expectedBytes)) return failure(400, "invalid_transfer");
  const bytes = await measured(new Response(request.body), transfer.expectedBytes, transfer.expectedSha, budget);
  const fresh = await bounded(authorize, budget);
  if (!fresh || !isDeepStrictEqual(fresh, admission)) return failure(403, "transfer_denied");
  await bounded(() => runtime.putImmutableOutput(scope, transfer.role!, bytes, budget.signal), budget);
  const stillCurrent = await bounded(authorize, budget);
  if (!stillCurrent || !isDeepStrictEqual(stillCurrent, admission)) return failure(403, "transfer_denied");
  // Registration has its own bounds, but its adapter calls must also consume
  // this transfer's original budget rather than receive a fresh 30 seconds.
  const registration: NativeRegistrationRepository = {
    loadAdmission: (...args) => bounded(() => runtime.registration.loadAdmission(...args), budget),
    readUploadedObject: (...args) => bounded(() => runtime.registration.readUploadedObject(...args), budget,
      (late) => { void late.body?.cancel().catch(() => undefined); }),
    registerMeasuredObject: (...args) => bounded(() => runtime.registration.registerMeasuredObject(...args), budget),
  };
  await bounded(() => {
    // Registration accepts whole milliseconds only. Refuse a submillisecond
    // remainder rather than round up and extend its internal read budget.
    const timeoutMs = Math.floor(budget.deadline - performance.now());
    if (timeoutMs < 1) throw new Error("interrupted");
    return registerMeasuredNativeResult({ taskId: scope.taskId, attemptId: scope.attemptId,
      role: transfer.role!, repository: registration, signal: budget.signal, timeoutMs });
  }, budget);
  return new Response(JSON.stringify({ schema: NATIVE_ARTIFACT_SCHEMA, delivered: true, role: transfer.role }), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Source-only HTTP seam. No production adapter, bucket or verifier key is
 * created here. Upload returns delivery status only, never verification or a
 * candidate-finalization receipt. */
export function createNativeArtifactHandler(runtime: NativeArtifactRuntime) {
  return async (request: Request): Promise<Response> => {
    if (!runtime.enabled()) return failure(503, "transfer_disabled");
    if (request.method !== "GET" && request.method !== "PUT") return failure(405, "method_not_allowed");
    const subject = parse(request);
    if (!subject) return failure(403, "transfer_denied");
    const transfer = transferHeaders(request);
    if (!transfer) return failure(400, "invalid_transfer");
    const requestedScope = structuredClone(subject.scope);
    const controller = new AbortController();
    const deadline = performance.now() + DEADLINE_MS;
    const budget: TransferBudget = { signal: controller.signal, deadline, check: () => {
      // A timer cannot interrupt synchronous work or a microtask chain. Recheck
      // elapsed time before dispatch and after settlement, and abort children.
      if (performance.now() >= deadline) controller.abort();
      if (controller.signal.aborted) throw new Error("interrupted");
    } };
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    const disconnected = () => controller.abort();
    request.signal.addEventListener("abort", disconnected, { once: true });
    if (request.signal.aborted) disconnected();
    const authorize = () => runtime.authorize({ ...subject, scope: structuredClone(requestedScope), direction: transfer.direction,
      artifactId: transfer.artifactId, role: transfer.role });
    try {
      const loaded = await bounded(authorize, budget);
      const admission = loaded && structuredClone(loaded);
      if (!admissionMatches(admission, requestedScope, transfer)) return failure(403, "transfer_denied");
      const response = transfer.direction === "input"
        ? await download(runtime, transfer, admission!, authorize, budget)
        : await upload(runtime, request, requestedScope, transfer, admission!, authorize, budget);
      budget.check();
      return response;
    } catch {
      return failure(503, "transfer_unavailable");
    } finally {
      clearTimeout(timer); request.signal.removeEventListener("abort", disconnected); controller.abort();
    }
  };
}
