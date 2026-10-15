import type { ArtifactStorageObject, PrivateArtifactSql, PrivateArtifactStorage } from "./native-artifact-repository";

export const NATIVE_STORAGE_IDENTITY_SQL = `select o.id from storage.objects o
join storage.buckets b on b.id=o.bucket_id and not b.public
where o.id=$1::uuid and o.bucket_id=$2::text and o.name=$3::text
  and o.version=$4::text and o.updated_at=$5::timestamptz`;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const unavailable = () => new Error("Private Storage operation unavailable; write outcomes require explicit reconciliation.");
const segment = (part: string) => {
  if (!part || part === "." || part === ".." || ([...part].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || part.includes("\\"))) throw unavailable();
  return encodeURIComponent(part);
};

/** Supabase REST, NOT S3: POST x-upsert:false and authenticated GET versionId.
 * storage.objects.version is never an HTTP ETag. Supply trusted server config;
 * no environment reads, auth provisioning, signed URLs, fallback or retries.
 * Deployment must qualify versionId enforcement on its pinned Storage build. */
export function createNativePrivateStorage(config: {
  sql: PrivateArtifactSql; storageOrigin: string; authorization: string;
  enabled?: boolean; versionIdQualified?: boolean; fetch?: typeof fetch; timeoutMs?: number;
}): PrivateArtifactStorage {
  const origin = new URL(config.storageOrigin), enabled = config.enabled === true && config.versionIdQualified === true;
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new TypeError("Invalid private Storage origin.");
  const originText = origin.origin, authorization = config.authorization, request = config.fetch ?? globalThis.fetch;
  const sql = config.sql, timeoutMs = config.timeoutMs ?? 30000;
  if (!authorization.startsWith("Bearer ") || /[\r\n]/.test(authorization) || authorization.length > 16384
    || authorization.length < 8 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError("Invalid private Storage configuration.");
  const operation = async <T>(signal: AbortSignal, work: (bounded: <V>(start: () => Promise<V>, discard?: (value: V) => void) => Promise<V>, signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (!enabled) throw unavailable();
    const controller = new AbortController(), deadline = performance.now() + timeoutMs;
    const abort = () => controller.abort(), timer = setTimeout(abort, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const ensure = () => { if (performance.now() >= deadline) abort(); if (controller.signal.aborted) throw unavailable(); };
    const bounded = <V>(start: () => Promise<V>, discard?: (value: V) => void): Promise<V> => new Promise((resolve, reject) => {
      const stop = () => { controller.signal.removeEventListener("abort", stop); reject(unavailable()); };
      controller.signal.addEventListener("abort", stop, { once: true });
      try {
        ensure();
        start().then(value => { try { ensure(); resolve(value); } catch (error) { discard?.(value); reject(error); } }, reject)
          .finally(() => controller.signal.removeEventListener("abort", stop)).catch(reject);
      } catch (error) { controller.signal.removeEventListener("abort", stop); reject(error); }
    });
    try { return await bounded(() => work(bounded, controller.signal)); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); abort(); }
  };
  const path = (bucket: string, name: string) => {
    if (bucket.includes("/")) throw unavailable();
    return `${segment(bucket)}/${name.split("/").map(segment).join("/")}`;
  };
  const discard = (response: Response) => { void response.body?.cancel().catch(() => undefined); };
  return Object.freeze({
    read: (input, signal) => {
      const ref = structuredClone(input);
      if (ref.method !== "GET" || ref.ifMatch !== ref.storageVersion || !uuid.test(ref.storageObjectId)
        || !uuid.test(ref.storageVersion) || Number.isNaN(Date.parse(ref.storageUpdatedAt))) return Promise.reject(unavailable());
      return operation(signal, async (bounded, activeSignal) => {
        const current = async () => {
          const values = [ref.storageObjectId, ref.bucketId, ref.objectName, ref.storageVersion, ref.storageUpdatedAt];
          const rows = await bounded(() => sql.query(NATIVE_STORAGE_IDENTITY_SQL, values, { signal: activeSignal, timeoutMs: 30000 }));
          if (rows.length !== 1 || rows[0].id !== ref.storageObjectId) throw unavailable();
        };
        await current();
        const url = `${originText}/storage/v1/object/authenticated/${path(ref.bucketId, ref.objectName)}?versionId=${encodeURIComponent(ref.storageVersion)}`;
        const response = await bounded(() => request(url, { method: "GET", redirect: "error", cache: "no-store", signal: activeSignal,
          headers: { authorization, "accept-encoding": "identity", "cache-control": "no-store" } }), discard);
        if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-encoding")) { discard(response); throw unavailable(); }
        const declared = response.headers.get("content-length");
        if (declared !== null && (!/^[1-9][0-9]*$/.test(declared) || Number(declared) > 16000000)) { discard(response); throw unavailable(); }
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let size = 0, complete = false;
        try {
          while (true) {
            const part = await bounded(() => reader.read());
            if (part.done) { complete = true; break; }
            if (!(part.value instanceof Uint8Array) || part.value.byteLength < 1 || chunks.length >= 4096) throw unavailable();
            size += part.value.byteLength;
            if (size > 16000000) throw unavailable();
            chunks.push(new Uint8Array(part.value));
          }
        } finally { if (complete) reader.releaseLock(); else void reader.cancel().catch(() => undefined); }
        if (!size || (declared !== null && Number(declared) !== size)) throw unavailable();
        await current();
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        // Upper layers independently measure the admitted SHA/size. Nothing is
        // released until this driver has rechecked the same private generation.
        return new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(size), "cache-control": "no-store" } });
      });
    },
    create: (input, signal) => {
      const target = structuredClone(input);
      if (target.method !== "PUT" || target.ifNoneMatch !== "*" || target.contentType !== "application/octet-stream"
        || !(target.bytes instanceof Uint8Array) || !target.bytes.byteLength || target.bytes.byteLength > 16000000) return Promise.reject(unavailable());
      return operation(signal, async (bounded, activeSignal) => {
        const response = await bounded(() => request(`${originText}/storage/v1/object/${path(target.bucketId, target.objectName)}`, {
          method: "POST", redirect: "error", cache: "no-store", signal: activeSignal,
          headers: { authorization, "content-type": target.contentType, "x-upsert": "false", "cache-control": "no-store" },
          body: new Uint8Array(target.bytes),
        }), discard);
        // Any 2xx remains subject to SQL lookup and independent measured reread
        // in the artifact runtime; it never acknowledges registration by itself.
        if (!response.redirected && response.status >= 200 && response.status < 300) { discard(response); return "created"; }
        if (response.redirected || (response.status !== 400 && response.status !== 409) || !response.body) { discard(response); throw unavailable(); }
        const reader = response.body.getReader(); let text = "", count = 0, chunks = 0, complete = false;
        try {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          while (true) {
            const part = await bounded(() => reader.read());
            if (part.done) { text += decoder.decode(); complete = true; break; }
            if (!(part.value instanceof Uint8Array) || !part.value.byteLength || ++chunks > 4096) throw unavailable();
            count += part.value.byteLength; if (count > 4096) throw unavailable();
            text += decoder.decode(part.value, { stream: true });
          }
        } finally { if (complete) reader.releaseLock(); else void reader.cancel().catch(() => undefined); }
        const error: unknown = JSON.parse(text);
        if (error && typeof error === "object" && !Array.isArray(error)
          && (Object.hasOwn(error, "code") && (error as { code: string }).code === "ResourceAlreadyExists")) return "conflict";
        throw unavailable();
      });
    },
  });
}

export type NativePrivateStorageReference = ArtifactStorageObject;
