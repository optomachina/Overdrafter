import { NATIVE_REPORT_POLICY, parsePreparedEvidenceJson } from "./native-reports";
import { verifyStoredNativeCandidate, type ResultReadAdmission } from "./native-result-bytes";

type Fetch = typeof globalThis.fetch;
type Config = Readonly<{
  enabled: boolean; projectUrl: string; apiKey: string; verifierToken: string; sourceSha256: string;
}>;
type Delivery = { schema: string; runId: string; manifestId: string; expiresAt: string; sourceSha256: string;
  policy: string; status: "ready" | "completed"; result?: { outcome: string; snapshotId: string; verification: string; adoption: string }; admission: ResultReadAdmission };
const uuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s)
  && s !== "00000000-0000-0000-0000-000000000000";
function need(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Native verification unavailable: ${label}.`);
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Native verification interrupted."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
/** Bound RPC bodies independently of the native-object streaming limits. */
async function readRpc(response: Response, signal: AbortSignal): Promise<unknown> {
  need(response.status === 200 && !response.redirected && response.body, "RPC response");
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0, count = 0, done = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await bounded(reader.read(), signal);
      if (result.done) { done = true; break; }
      size += result.value.byteLength;
      need(result.value.byteLength > 0 && ++count <= 4096 && size <= 200_000, "RPC body bounds");
      parts.push(new Uint8Array(result.value));
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return parsePreparedEvidenceJson(bytes);
  } finally {
    if (done) reader.releaseLock();
    else void reader.cancel().catch(() => undefined);
  }
}

/**
 * Bind one private verifier deployment to its project origin and qualified
 * source identity. The supplied JWT is a narrowly scoped verifier credential,
 * never a worker token or a service-role key. No environment is enabled here.
 */
export function createNativeVerifier(config: Config, fetch: Fetch = globalThis.fetch) {
  const pinned = structuredClone(config), origin = new URL(pinned.projectUrl);
  need(origin.protocol === "https:" && !origin.username && !origin.password && origin.pathname === "/"
    && !origin.search && !origin.hash, "project origin");
  need(/^[0-9a-f]{64}$/.test(pinned.sourceSha256), "qualified source");
  need(pinned.apiKey.length > 0 && pinned.apiKey.length <= 4096 && !/[\r\n]/.test(pinned.apiKey), "API key");
  need(pinned.verifierToken.length <= 8192 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(pinned.verifierToken), "verifier token");
  // This is a configuration guard only. The platform must verify the JWT's
  // signature and expiry; its role and subject are enforced again by SQL.
  const claims = JSON.parse(Buffer.from(pinned.verifierToken.split(".")[1], "base64url").toString("utf8"));
  need(claims.role === "engineering_native_verifier" && uuid(claims.sub), "verifier role");
  const headers = Object.freeze({ apikey: pinned.apiKey, Authorization: `Bearer ${pinned.verifierToken}` });
  async function rpc(name: "load" | "complete", body: object, signal: AbortSignal) {
    const response = await bounded(fetch(`${origin.origin}/rest/v1/rpc/api_${name}_native_verification`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
      redirect: "error", cache: "no-store", signal,
    }), signal);
    return readRpc(response, signal);
  }
  return Object.freeze({
    /** A delivery retry reuses these IDs; it never resubmits native CAD work. */
    async verify(manifestId: string, idempotencyKey: string): Promise<unknown> {
      need(pinned.enabled, "disabled"); need(uuid(manifestId) && uuid(idempotencyKey), "delivery identity");
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45_000);
      try {
        const delivery = await rpc("load", { p_manifest: manifestId, p_key: idempotencyKey }, controller.signal) as Delivery;
        need(delivery?.schema === "overdrafter.native-verification-delivery.v1" && uuid(delivery.runId)
          && delivery.manifestId === manifestId && delivery.sourceSha256 === pinned.sourceSha256
          && delivery.policy === NATIVE_REPORT_POLICY, "admitted delivery");
        if (delivery.status === "completed") {
          need(delivery.result?.outcome === "finalized" && uuid(delivery.result.snapshotId)
            && delivery.result.verification === "passed" && delivery.result.adoption === "unadopted", "completed receipt");
          return delivery.result;
        }
        need(delivery.status === "ready" && Number.isFinite(Date.parse(delivery.expiresAt))
          && Date.parse(delivery.expiresAt) > Date.now(), "admitted delivery");
        const objects = structuredClone(delivery.admission.objects);
        const reader = async (id: string, signal: AbortSignal) => {
          const object = objects.find((entry) => entry.id === id);
          need(object && uuid(object.scope.organizationId) && uuid(object.scope.projectId) && uuid(object.attemptId) && uuid(object.id), "registered object");
          const path = [object.scope.organizationId, object.scope.projectId, object.attemptId, object.id].join("/");
          return fetch(`${origin.origin}/storage/v1/object/engineering-native-results/${path}`, {
            method: "GET", headers, redirect: "error", cache: "no-store", signal: AbortSignal.any([signal, controller.signal]),
          });
        };
        const verified = await verifyStoredNativeCandidate(delivery.admission, reader);
        controller.signal.throwIfAborted();
        return await rpc("complete", { p_run: delivery.runId, p_context_text: JSON.stringify(verified.context) }, controller.signal);
      } finally { clearTimeout(timer); controller.abort(); }
    },
  });
}
