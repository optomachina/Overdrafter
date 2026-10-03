import { type DispatchIdentity, type PreparedDispatchRuntime } from "./dispatch-prepared-request.ts";
import { dispatchPreparedRequestWithJev } from "./prepared-jev.ts";
import { pythonJson } from "./python-json.ts";

/** Explicit existing helper only. No discovery, installation, credential setup or activation.
 * The helper protocol is shared with sample-plate-adapter; this module imports no CAD adapter.
 * Dispatch cancellation prevents finalization, but cannot prove an external call had no effects.
 */
export function dispatchPreparedRequestWithPythonJev(identity: DispatchIdentity,
  runtime: Omit<PreparedDispatchRuntime, "adapter">,
  helper: Readonly<{ python: string; jev: string }>) {
  return dispatchPreparedRequestWithJev(identity, runtime, (request, signal) => {
    signal.throwIfAborted();
    return pythonJson(helper.python, helper.jev, request, runtime.deadlineMs ?? 15_000);
  });
}
