import type { SupabaseClient } from "@supabase/supabase-js";
import { createCapabilityPersistenceTransport } from "./providerCapabilityPersistenceTransport.js";
import { createCapabilityCanaryRuntime, type CanaryFencedRuntime, type CanaryRuntimeDependencies } from "./providerCapabilityCanaryRuntime.js";
import type { CanaryFencedRequest, CanaryFencedCompletion } from "./providerCapabilityCanaryFenced.js";

export type CanaryRetentionEntry =
  | { kind: "claim_request"; request: CanaryFencedRequest; completionKey: string }
  | { kind: "completion"; input: CanaryFencedCompletion };
export type CanaryServiceDependencies = Pick<CanaryRuntimeDependencies, "bindings" | "now" | "revocationSignal" | "withProfileLock" | "onConfirmedObservation"> & {
  /** Supplied service factory only, evaluated lazily after runtime approval/binding guards and retention. */
  createClient: () => SupabaseClient;
  fenced: Omit<CanaryFencedRuntime, "mode" | "transport">;
  /** Required atomic immutable preparation acknowledgement. Existing/uncertain means recovery-only; no backend is supplied here. */
  retainBeforeDispatch: ((entry: CanaryRetentionEntry, signal: AbortSignal) => Promise<{ state: "created" | "existing" }>) | null;
};
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
/** Canonical SDK -> fenced runtime composition. Missing durability never silently degrades to an in-memory journal. */
export function createCapabilityCanaryService(deps: CanaryServiceDependencies) {
  const createClient = deps.createClient;
  const retain = deps.retainBeforeDispatch;
  const config = { ...deps.fenced };
  let persistence: ReturnType<typeof createCapabilityPersistenceTransport> | undefined;
  const getPersistence = (signal: AbortSignal) => {
    if (signal.aborted) throw new Error("canary_service_unavailable");
    persistence ??= createCapabilityPersistenceTransport(createClient());
    return persistence;
  };
  async function retainEntry(entry: CanaryRetentionEntry, signal: AbortSignal) {
    if (!retain || signal.aborted) throw new Error("canary_retention_unavailable");
    const acknowledgement = await retain(frozen(structuredClone(entry)), signal);
    if (signal.aborted || !acknowledgement || Object.getPrototypeOf(acknowledgement) !== Object.prototype
      || Reflect.ownKeys(acknowledgement).length !== 1 || Object.getOwnPropertyDescriptor(acknowledgement, "state")?.value !== "created") throw new Error("canary_retention_unavailable");
  }
  const runtime = createCapabilityCanaryRuntime({ bindings: deps.bindings, now: deps.now,
    revocationSignal: deps.revocationSignal, withProfileLock: deps.withProfileLock, onConfirmedObservation: deps.onConfirmedObservation,
    // Omitting the fenced service when retention is missing invokes the existing missing-dependency gate.
    ...(retain ? { fenced: { ...config, preflightAdmission: true, mode: "fenced", transport: {
      async claim({ p_input }, signal) {
        await retainEntry({ kind: "claim_request", request: p_input, completionKey: config.completionKey }, signal);
        return getPersistence(signal).claim(p_input, signal);
      },
      get: (args, signal) => getPersistence(signal).get(args.p_window_key, args.p_request_key, signal),
      async complete({ p_input }, signal) {
        await retainEntry({ kind: "completion", input: p_input }, signal);
        return getPersistence(signal).complete(p_input, signal);
      },
    } } } : {}),
  });
  return runtime;
}
