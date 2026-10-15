import { createHash } from "node:crypto";
import { prepareNativeArtifactOutputs } from "./native-artifact-mapping";
import { isDeepStrictEqual } from "node:util";
import { createNativeArtifactHandler, type NativeArtifactRuntime, type NativeArtifactScope } from "./native-artifact-transport";
import { NATIVE_RESULT_ROLE_LIMITS, type NativeResultRole } from "./native-result-bytes";
import type { NativeRegistrationAdmission } from "./native-result-registration";
import { ARTIFACT_ISOLATION_SQL, ARTIFACT_ATTEMPT_LOCK_SQL, ARTIFACT_AUTHORITY_LOCK_SQL, ARTIFACT_STORAGE_LOCK_SQL, ARTIFACT_LOCK_SQL, ARTIFACT_AUTHORITY_SQL, ARTIFACT_INPUT_SQL, ARTIFACT_OUTPUT_SQL, ARTIFACT_REGISTER_SQL,
  type ArtifactStorageObject, type PrivateArtifactSql, type PrivateArtifactStorage } from "./native-artifact-repository";

type Subject = Parameters<NativeArtifactRuntime["authorize"]>[0];
type Config = Readonly<{ enabled?: () => boolean; sql: PrivateArtifactSql; storage: PrivateArtifactStorage; outputBucket?: string }>;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const unavailable = () => new Error("Private artifact adapter unavailable.");
function object(row: Record<string, unknown>): ArtifactStorageObject {
  if (typeof row.storageObjectId !== "string" || !uuid.test(row.storageObjectId)
    || typeof row.bucketId !== "string" || !row.bucketId
    || typeof row.objectName !== "string" || !row.objectName
    || typeof row.storageVersion !== "string" || !row.storageVersion
    || typeof row.storageUpdatedAt !== "string" || Number.isNaN(Date.parse(row.storageUpdatedAt))) throw unavailable();
  return { storageObjectId: row.storageObjectId, bucketId: row.bucketId, objectName: row.objectName,
    storageVersion: row.storageVersion, storageUpdatedAt: row.storageUpdatedAt };
}

/** Own one runtime per HTTP request. Authority and Storage identities must never
 * be retained in a singleton shared by unrelated worker requests. The SQL and
 * Storage drivers are trusted private capabilities, supplied by a separately
 * authorized deployment; this factory neither obtains nor uses credentials. */
export function createPrivateNativeArtifactHandler(config: Config) {
  const outputBucket = config.outputBucket; // Server configuration only; never a worker header/path.
  return (request: Request): Promise<Response> => {
    const controller = new AbortController();
    const deadline = performance.now() + 30000;
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(abort, 30000);
    const ensure = (signal: AbortSignal) => {
      if (performance.now() >= deadline) abort();
      if (signal.aborted || controller.signal.aborted) throw unavailable();
    };
    let subject: Subject | undefined;
    let targetsPrepared = false;
    let registeredObject: ArtifactStorageObject | undefined;
    const query = async (text: string, values: readonly unknown[], signal: AbortSignal, sql = config.sql) => {
      ensure(signal);
      const rows = await sql.query(text, values, { signal, timeoutMs: 30000 });
      ensure(signal);
      if (rows.length > 1) throw unavailable();
      return rows[0] ? structuredClone(rows[0]) : null;
    };
    const authority = async (wanted: Subject, signal: AbortSignal, sql = config.sql) => {
      const row = await query(ARTIFACT_AUTHORITY_SQL,
        [wanted.scope.attemptId, wanted.scope.taskId, wanted.tokenSha256], signal, sql);
      return row && isDeepStrictEqual(row.scope, wanted.scope)
        && row[wanted.direction === "input" ? "inputEligible" : "outputEligible"] === true;
    };
    const current = async (direction: "input" | "output", signal: AbortSignal, sql = config.sql): Promise<Subject> => {
      if (!subject || subject.direction !== direction || !await authority(subject, signal, sql)) throw unavailable();
      return subject;
    };
    const input = async (id: string, signal: AbortSignal) => {
      const admitted = await current("input", signal);
      if (id !== admitted.artifactId) throw unavailable();
      const row = await query(ARTIFACT_INPUT_SQL, [admitted.scope.attemptId, id], signal);
      if (!row || row.id !== id || !Number.isSafeInteger(row.bytes) || (row.bytes as number) < 1
        || (row.bytes as number) > 16000000 || typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)) throw unavailable();
      return { ...object(row), id, bytes: row.bytes as number, sha256: row.sha256 };
    };
    const output = async (scope: NativeArtifactScope, role: NativeResultRole, signal: AbortSignal, sql = config.sql) => {
      const admitted = await current("output", signal, sql);
      if (!isDeepStrictEqual(scope, admitted.scope) || role !== admitted.role) throw unavailable();
      const row = await query(ARTIFACT_OUTPUT_SQL, [scope.attemptId, role], signal, sql);
      if (!row || typeof row.bucketId !== "string" || !row.bucketId
        || row.objectName !== `native-results/${scope.attemptId}/${role}`) throw unavailable();
      return row;
    };
    const read = (ref: ArtifactStorageObject, signal: AbortSignal) => {
      ensure(signal);
      return config.storage.read({ ...ref, method: "GET", ifMatch: ref.storageVersion }, signal);
    };
    const runtime: NativeArtifactRuntime = {
      enabled: config.enabled ?? (() => false),
      authorize: async (wanted) => {
        if (subject && !isDeepStrictEqual(subject, wanted)) return null;
        if (!await authority(wanted, controller.signal)) return null;
        subject = structuredClone(wanted);
        if (wanted.direction === "output") {
          if (!wanted.role || !Object.hasOwn(NATIVE_RESULT_ROLE_LIMITS, wanted.role) || wanted.artifactId !== null) return null;
          if (outputBucket !== undefined && !targetsPrepared) {
            // Existing paired-token/scope/stopped authority was checked above.
            // Owner SQL independently rechecks current qualified stop under locks.
            await prepareNativeArtifactOutputs({ enabled: true, sql: config.sql,
              attemptId: wanted.scope.attemptId, outputBucket, signal: controller.signal });
            ensure(controller.signal);
            targetsPrepared = true;
          }
          await output(wanted.scope, wanted.role, controller.signal);
          return { scope: structuredClone(wanted.scope), input: null };
        }
        if (!wanted.artifactId || wanted.role !== null) return null;
        const row = await input(wanted.artifactId, controller.signal);
        return { scope: structuredClone(wanted.scope), input: { id: row.id, bytes: row.bytes, sha256: row.sha256 } };
      },
      readInput: async (id, signal) => read(await input(id, signal), signal),
      putImmutableOutput: async (scope, role, bytes, signal) => {
        const target = await output(scope, role, signal);
        if (target.storageObjectId === null) {
          ensure(signal);
          const result = await config.storage.create({ method: "PUT", bucketId: target.bucketId as string,
            objectName: target.objectName as string, ifNoneMatch: "*", contentType: "application/octet-stream",
            bytes: new Uint8Array(bytes) }, signal);
          if (result !== "created" && result !== "conflict") throw unavailable();
        }
        // Both created and conflict take the same exact-generation read path.
        // Unknown create outcomes throw, retaining the immutable object for replay.
        const stored = object(await output(scope, role, signal));
        const response = await read(stored, signal);
        if (signal.aborted || controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined); throw unavailable();
        }
        if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-encoding")) {
          void response.body?.cancel().catch(() => undefined); throw unavailable();
        }
        const reader = response.body.getReader(), digest = createHash("sha256");
        let size = 0, chunks = 0, complete = false;
        const cancel = () => { void reader.cancel().catch(() => undefined); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          while (true) {
            ensure(signal);
            const part = await reader.read();
            ensure(signal);
            if (part.done) { complete = true; break; }
            if (!(part.value instanceof Uint8Array) || !part.value.byteLength || ++chunks > 4096) throw unavailable();
            size += part.value.byteLength;
            if (size > bytes.byteLength) throw unavailable();
            digest.update(part.value);
          }
        } finally { signal.removeEventListener("abort", cancel); if (complete) reader.releaseLock(); else void reader.cancel().catch(() => undefined); }
        if (size !== bytes.byteLength || digest.digest("hex") !== hash(bytes)) throw unavailable();
        const fresh = object(await output(scope, role, signal));
        if (!isDeepStrictEqual(fresh, stored)) throw unavailable();
      },
      registration: {
        loadAdmission: async (taskId, attemptId, role, signal) => {
          const admitted = await current("output", signal);
          if (taskId !== admitted.scope.taskId || attemptId !== admitted.scope.attemptId || role !== admitted.role) return null;
          registeredObject = object(await output(admitted.scope, role, signal));
          const { organizationId, projectId, fence, inputSnapshotId, candidateSnapshotId } = admitted.scope;
          return { taskId, attemptId, organizationId, projectId, fence, inputSnapshotId, candidateSnapshotId,
            role, ...registeredObject } satisfies NativeRegistrationAdmission;
        },
        readUploadedObject: async (id, signal) => {
          const admitted = await current("output", signal);
          if (!registeredObject || registeredObject.storageObjectId !== id) throw unavailable();
          const fresh = object(await output(admitted.scope, admitted.role!, signal));
          if (!isDeepStrictEqual(fresh, registeredObject)) throw unavailable();
          return read(registeredObject, signal);
        },
        registerMeasuredObject: async (row, signal) => {
          ensure(signal);
          if (!subject || subject.direction !== "output") throw unavailable();
          const bound = subject;
          return config.sql.transaction(async (sql) => {
            const isolation = await query(ARTIFACT_ISOLATION_SQL, [], signal, sql);
            if (isolation?.isolation !== "read committed") throw unavailable();
            const locked = await query(ARTIFACT_LOCK_SQL,
              [bound.scope.workerId, bound.tokenSha256, bound.scope.taskId], signal, sql);
            if (locked?.id !== bound.scope.taskId) throw unavailable();
            const attempt = await query(ARTIFACT_ATTEMPT_LOCK_SQL,
              [bound.scope.attemptId, bound.scope.taskId], signal, sql);
            if (attempt?.id !== bound.scope.attemptId || !registeredObject) throw unavailable();
            await query(ARTIFACT_AUTHORITY_LOCK_SQL, [], signal, sql);
            const stored = await query(ARTIFACT_STORAGE_LOCK_SQL, [registeredObject.storageObjectId,
              registeredObject.bucketId, registeredObject.objectName, registeredObject.storageVersion,
              registeredObject.storageUpdatedAt], signal, sql);
            if (stored?.id !== registeredObject.storageObjectId) throw unavailable();
            const admitted = await current("output", signal, sql);
            const fresh = object(await output(admitted.scope, admitted.role!, signal, sql));
            if (!registeredObject || !isDeepStrictEqual(fresh, registeredObject)) throw unavailable();
            const result = await query(ARTIFACT_REGISTER_SQL, [row.organizationId, row.projectId, row.taskId,
              row.attemptId, row.fence, row.inputSnapshotId, row.candidateSnapshotId, row.role,
              row.bucketId, row.objectName, row.storageObjectId, row.storageVersion, row.storageUpdatedAt,
              row.byteLength, row.sha256, bound.scope.attemptId, bound.scope.taskId, bound.tokenSha256,
              JSON.stringify(bound.scope)], signal, sql);
            if (!result || typeof result.registered !== "boolean") throw unavailable();
            return result.registered;
          }, { signal, timeoutMs: 30000, isolation: "read committed" });
        },
      },
    };
    return createNativeArtifactHandler(runtime)(request).finally(() => {
      clearTimeout(timer); request.signal.removeEventListener("abort", abort); abort();
    });
  };
}
