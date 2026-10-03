import type { SupabaseClient } from "@supabase/supabase-js";
import type { CapabilityRetentionPort } from "./providerCapabilityRetention.js";
import type { PersistenceResult } from "./providerCapabilityRuntimePersistence.js";
import {
  prepareCapabilityClaim, readPreparedCapabilityClaim, prepareCapabilityCompletion, readPreparedCapabilityCompletion,
  prepareCapabilityAttention, readPreparedCapabilityAttention, listPreparedCapabilityClaims, listPreparedCapabilityAttention,
} from "./providerCapabilityPreparationPersistence.js";

/** Exact release helpers -> semantic retention port. No client exists until a validated, enabled operation needs its sole RPC. */
export function createCapabilityPreparationTransport(options: {
  enabled?: boolean;
  createClient: () => SupabaseClient;
  budgetMs?: number;
}): CapabilityRetentionPort {
  const enabled = options.enabled === true;
  const createClient = options.createClient;
  const budgetMs = options.budgetMs ?? 5000;
  const validBudget = Number.isSafeInteger(budgetMs) && budgetMs >= 1 && budgetMs <= 5000;
  const unavailable = () => new Error("capability_preparation_unavailable");
  let rpc: SupabaseClient["rpc"] | undefined;
  async function operation<T>(name: string, signal: AbortSignal, helper: (facade: SupabaseClient) => Promise<PersistenceResult<T>>): Promise<T> {
    if (!enabled || !validBudget || signal.aborted) throw unavailable();
    const controller = new AbortController();
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => { abort = () => { controller.abort(); reject(unavailable()); }; });
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, budgetMs);
    let invoked = false;
    try {
      if (signal.aborted) throw unavailable();
      const facade = { rpc(requested: string, args: Record<string, unknown>) {
        if (requested !== name || invoked || signal.aborted || controller.signal.aborted) throw unavailable();
        invoked = true;
        // Canonical helper validation precedes this call. Capture the method/receiver once.
        if (!rpc) { const client = createClient(); rpc = client.rpc.bind(client); }
        if (signal.aborted || controller.signal.aborted) throw unavailable();
        // PostgREST is lazy; cancellation must be attached before the helper awaits it.
        return rpc(requested, structuredClone(args)).abortSignal(controller.signal);
      } } as unknown as SupabaseClient;
      const result = await Promise.race([helper(facade), cancelled]);
      if (signal.aborted || controller.signal.aborted || !result.ok) throw unavailable();
      return result.value;
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  return Object.freeze({
    prepareClaim: (input, signal) => operation("api_prepare_capability_claim", signal, c => prepareCapabilityClaim(c, input)),
    readClaim: (requestKey, signal) => operation("api_read_prepared_capability_claim", signal, c => readPreparedCapabilityClaim(c, requestKey)),
    prepareCompletion: (input, signal) => operation("api_prepare_capability_completion", signal, c => prepareCapabilityCompletion(c, input)),
    readCompletion: (completionKey, signal) => operation("api_read_prepared_capability_completion", signal, c => readPreparedCapabilityCompletion(c, completionKey)),
    prepareAttention: (input, signal) => operation("api_prepare_capability_attention", signal, c => prepareCapabilityAttention(c, input)),
    readAttention: (evaluationKey, signal) => operation("api_read_prepared_capability_attention", signal, c => readPreparedCapabilityAttention(c, evaluationKey)),
    listClaims: (input, signal) => operation("api_list_prepared_capability_claims", signal, c => listPreparedCapabilityClaims(c, input)),
    listAttention: (input, signal) => operation("api_list_prepared_capability_attention", signal, c => listPreparedCapabilityAttention(c, input)),
  });
}
