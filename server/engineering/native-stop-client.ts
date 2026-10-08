import { NativeStopFailure, nativeStopReceipt, stopObject, type NativeStopRequest } from "./native-stop-admission.ts";
import { boundedStopCall, privateStopUrl, stopJsonReply } from "./native-observer-repository.ts";
import { NATIVE_STOP_SCHEMA } from "./native-stop-transport.ts";

/** Paired worker capability only. Never receives or forwards validator credentials. */
export function createNativeStopClient(config: Readonly<{ origin: string; token: string; fetch?: typeof fetch; deadlineMs?: number }>) {
  const endpoint = privateStopUrl(config.origin, "/functions/v1/engineering-worker-stop");
  const url = new URL(endpoint);
  if (url.pathname !== "/functions/v1/engineering-worker-stop" || !/^odw_[0-9a-f]{64}$/.test(config.token)) {
    throw new NativeStopFailure(503, "stop_client_unavailable");
  }
  const deadline = config.deadlineMs ?? 5000;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > 30000) throw new NativeStopFailure(503, "stop_client_unavailable");
  return { async submit(request: NativeStopRequest) {
    const body = JSON.stringify({ schema: NATIVE_STOP_SCHEMA, action: "record_stop", ...request });
    try {
      return await boundedStopCall(async signal => {
        const response = await (config.fetch ?? fetch)(endpoint, { method: "POST", redirect: "error", signal,
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body });
        const value = await stopJsonReply(response, signal);
        if (!stopObject(value) || value.schema !== NATIVE_STOP_SCHEMA) throw new NativeStopFailure(503, "stop_outcome_unknown", true);
        if (!response.ok) {
          // Only an explicit checked server rejection certifies no transition.
          const rejected = value.outcome === "not_applied" && value.retrySameRequest === false;
          throw new NativeStopFailure(response.status, rejected ? "stop_not_admitted" : "stop_outcome_unknown", !rejected);
        }
        if (value.action !== "record_stop") throw new NativeStopFailure(503, "stop_outcome_unknown", true);
        return nativeStopReceipt(value.receipt, request);
      }, deadline);
    } catch (error) {
      if (error instanceof NativeStopFailure) throw error;
      throw new NativeStopFailure(503, "stop_outcome_unknown", true);
    }
  } };
}
