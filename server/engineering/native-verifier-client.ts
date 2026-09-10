import { NATIVE_REPORT_POLICY, parsePreparedEvidenceJson } from "./native-reports";
import { verifyStoredNativeCandidate, type ResultReadAdmission } from "./native-result-bytes";
import { NativeEvidenceRejection } from "./native-verification-failure";
import { NATIVE_PREVIEW_POLICY, verifyStoredNativePreview, type NativePreviewAdmission } from "./native-preview-bytes";

type Fetch = typeof globalThis.fetch;
type Config = Readonly<{
  enabled: boolean; projectUrl: string; apiKey: string; verifierToken: string; sourceSha256: string;
}>;
type Delivery = { schema: string; runId: string; manifestId: string; expiresAt: string; sourceSha256: string;
  policy: string; status: "ready" | "completed" | "rejected"; result?: { outcome: string; snapshotId: string; failureId: string; verification: string; adoption: string }; admission: ResultReadAdmission };
type PreviewDelivery = { schema: string; exportId: string; runId: string; expiresAt: string; sourceSha256: string;
  policy: string; status: "ready" | "completed"; contextText: string; admission: NativePreviewAdmission; result?: Record<string, unknown> };
const RPC_PATHS = Object.freeze({ load: "api_load_native_verification", complete: "api_complete_native_verification",
  reject: "api_reject_native_verification", previewLoad: "api_load_native_preview", previewComplete: "api_complete_native_preview" });
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
  async function rpc(name: keyof typeof RPC_PATHS, body: object, signal: AbortSignal) {
    const response = await bounded(fetch(`${origin.origin}/rest/v1/rpc/${RPC_PATHS[name]}`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
      redirect: "error", cache: "no-store", signal,
    }), signal);
    return readRpc(response, signal);
  }
  return Object.freeze({
    /** Verify an already admitted read-only export and attach its exact bundle.
     * This does not dispatch CAD or change native verification/adoption state.
     */
    async verifyPreview(exportId: string, idempotencyKey: string): Promise<unknown> {
      need(pinned.enabled, "disabled"); need(uuid(exportId) && uuid(idempotencyKey), "preview delivery identity");
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45_000);
      try {
        const delivery = await rpc("previewLoad", { p_export: exportId, p_key: idempotencyKey }, controller.signal) as PreviewDelivery;
        need(delivery?.schema === "overdrafter.native-preview-delivery.v1" && delivery.exportId === exportId
          && delivery.sourceSha256 === pinned.sourceSha256 && delivery.policy === NATIVE_PREVIEW_POLICY, "admitted preview delivery");
        if (delivery.status === "completed") {
          need(delivery.result?.status === "ready" && delivery.result.exportId === exportId
            && uuid(delivery.result.snapshotId) && delivery.result.policy === NATIVE_PREVIEW_POLICY, "preview receipt");
          return delivery.result;
        }
        need(delivery.status === "ready" && uuid(delivery.runId) && delivery.admission?.exportId === exportId
          && Number.isFinite(Date.parse(delivery.expiresAt)) && Date.parse(delivery.expiresAt) > Date.now(), "preview admission");
        const admission = structuredClone(delivery.admission);
        const reader = async (id: string, signal: AbortSignal) => {
          const object = admission.objects.find((entry) => entry.id === id);
          need(object && uuid(id) && uuid(admission.scope.organizationId) && uuid(admission.scope.projectId), "preview object");
          const path = [admission.scope.organizationId, admission.scope.projectId, exportId, id].join("/");
          return fetch(`${origin.origin}/storage/v1/object/engineering-native-previews/${path}`, {
            method: "GET", headers, redirect: "error", cache: "no-store", signal: AbortSignal.any([signal, controller.signal]),
          });
        };
        const result = await verifyStoredNativePreview(delivery.contextText, admission, reader);
        need(result.status === "ready", "verified preview required"); controller.signal.throwIfAborted();
        return await rpc("previewComplete", { p_run: delivery.runId, p_step_sha256: result.preview.step.sha256,
          p_step_bytes: result.preview.step.bytes }, controller.signal);
      } finally { clearTimeout(timer); controller.abort(); }
    },
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
        if (delivery.status === "rejected") {
          need(delivery.result?.outcome === "verification_failed" && uuid(delivery.result.failureId)
            && delivery.result.verification === "failed" && delivery.result.adoption === "unadopted", "rejected receipt");
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
        let verified;
        try { verified = await verifyStoredNativeCandidate(delivery.admission, reader); }
        catch (error) {
          controller.signal.throwIfAborted();
          if (!(error instanceof NativeEvidenceRejection)) throw error;
          return await rpc("reject", { p_run: delivery.runId, p_failure: error.failure }, controller.signal);
        }
        controller.signal.throwIfAborted();
        return await rpc("complete", { p_run: delivery.runId, p_context_text: JSON.stringify(verified.context) }, controller.signal);
      } finally { clearTimeout(timer); controller.abort(); }
    },
  });
}
