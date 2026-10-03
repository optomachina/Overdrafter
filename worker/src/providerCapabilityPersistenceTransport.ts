import type { SupabaseClient } from "@supabase/supabase-js";
import {
  claimCapabilityWindow, getCapabilityWindow, completeCapabilityWindow,
  commitCapabilityAttention, readCapabilityAttention, listDueCapabilityAttention,
  type CapabilityWindowClaim, type CapabilityWindowCompletion, type CapabilityAttentionCommit, type PersistenceResult,
} from "./providerCapabilityRuntimePersistence.js";

/** Actual SDK mapping, scoped to one canonical helper RPC per invocation. No clients or credentials are created. */
export function createCapabilityPersistenceTransport(client: SupabaseClient) {
  const rpc = client.rpc.bind(client);
  async function operation<T>(name: string, signal: AbortSignal, helper: (facade: SupabaseClient) => Promise<PersistenceResult<T>>): Promise<T> {
    const controller = new AbortController();
    let rejectAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = () => { controller.abort(); reject(new Error("capability_persistence_unavailable")); }; });
    const timer = setTimeout(rejectAbort, 5000);
    signal.addEventListener("abort", rejectAbort, { once: true });
    let invoked = false;
    try {
      if (signal.aborted) throw new Error("capability_persistence_unavailable");
      const facade = { rpc(requested: string, args: Record<string, unknown>) {
        if (requested !== name || invoked || controller.signal.aborted || signal.aborted) throw new Error("capability_persistence_unavailable");
        invoked = true;
        // The SDK builder is lazy: attach cancellation before the canonical helper awaits it.
        return rpc(requested, structuredClone(args)).abortSignal(controller.signal);
      } } as unknown as SupabaseClient;
      const result = await Promise.race([helper(facade), aborted]);
      if (signal.aborted || controller.signal.aborted || !result.ok) throw new Error("capability_persistence_unavailable");
      return result.value;
    } catch { throw new Error("capability_persistence_unavailable"); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", rejectAbort); }
  }
  return Object.freeze({
    claim: (input: CapabilityWindowClaim, signal: AbortSignal) => operation("api_claim_capability_window", signal, c => claimCapabilityWindow(c, input)),
    get: (windowKey: string, requestKey: string, signal: AbortSignal) => operation("api_get_capability_window", signal, c => getCapabilityWindow(c, windowKey, requestKey)),
    complete: (input: CapabilityWindowCompletion, signal: AbortSignal) => operation("api_complete_capability_window", signal, c => completeCapabilityWindow(c, input)),
    commitAttention: (input: CapabilityAttentionCommit, signal: AbortSignal) => operation("api_commit_capability_attention", signal, c => commitCapabilityAttention(c, input)),
    readAttention: (scopeKey: string, signal: AbortSignal) => operation("api_read_capability_attention", signal, c => readCapabilityAttention(c, scopeKey)),
    listDueAttention: (limit: number, signal: AbortSignal) => operation("api_list_due_capability_attention", signal, c => listDueCapabilityAttention(c, limit)),
  });
}
export type CapabilityPersistenceTransport = ReturnType<typeof createCapabilityPersistenceTransport>;
