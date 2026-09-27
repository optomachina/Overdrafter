import { NativeStopFailure, nativeStopReceipt, stopObject, type NativeStopRepository } from "./native-stop-admission.ts";

const EXECUTOR = "ovd576_stop_validator";
/** Explicit dedicated PostgREST capability, never the application's service key.
 * JWT signature verification belongs to PostgREST; local role checking additionally
 * rejects an accidentally configured broad token before sending any request. */
export function createNativeStopRepository(config: { url: string | undefined; token: string | undefined; fetch?: typeof fetch }): NativeStopRepository {
  let endpoint: URL;
  try {
    endpoint = new URL(config.url ?? "");
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new TypeError("Executor requires HTTPS and no URL credentials or query.");
    const parts = (config.token ?? "").split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new TypeError("Executor token must be a JWT.");
    const claims: unknown = JSON.parse(atob(parts[1].replaceAll("-", "+").replaceAll("_", "/")));
    if (!stopObject(claims) || claims.role !== EXECUTOR) throw new TypeError("Executor token must select the restricted role.");
    endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/rpc/admit_qualified_native_stop";
  } catch { throw new NativeStopFailure(503, "stop_executor_unavailable"); }
  const send = config.fetch ?? fetch;
  return { async admit(request, credentialHash, signal) {
    if (signal.aborted) throw new NativeStopFailure(503, "stop_not_dispatched");
    try {
      const response = await send(endpoint.href, { method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json",
          "content-profile": "engineering_private", accept: "application/json" },
        body: JSON.stringify({ p_worker: request.workerId, p_credential: credentialHash,
          p_boot: request.bootId, p_task: request.taskId, p_attempt: request.attemptId,
          p_fence: request.fence, p_evidence: request.evidenceId, p_revision: request.revision, p_key: request.idempotencyKey }) });
      const value: unknown = await response.json();
      if (!response.ok) {
        const code = stopObject(value) ? value.code : null;
        if (code === "42501") throw new NativeStopFailure(401, "worker_access_denied");
        if (code === "PT409" || code === "23505") throw new NativeStopFailure(409, "stop_not_admitted");
        if (code === "22023") throw new NativeStopFailure(400, "invalid_request");
        throw new NativeStopFailure(503, "stop_outcome_unknown", true);
      }
      return nativeStopReceipt(value, request);
    } catch (error) {
      if (error instanceof NativeStopFailure) throw error;
      throw new NativeStopFailure(503, "stop_outcome_unknown", true);
    }
  } };
}
