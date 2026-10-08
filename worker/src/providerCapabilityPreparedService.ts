import type { SupabaseClient } from "@supabase/supabase-js";
import { createCapabilityPreparationTransport } from "./providerCapabilityPreparationTransport.js";
import { createCapabilityPersistenceTransport, type CapabilityPersistenceTransport } from "./providerCapabilityPersistenceTransport.js";
import { createCapabilityRetentionHooks } from "./providerCapabilityRetention.js";
import { createCapabilityCanaryService, type CanaryServiceDependencies } from "./providerCapabilityCanaryService.js";
import { createCapabilityAttentionService } from "./providerCapabilityAttentionService.js";
import { createCapabilityRecoveryService } from "./providerCapabilityRecoveryService.js";
import type { CapabilityAttentionMetadata } from "./providerCapabilityAttention.js";

type CanaryConfiguration = Omit<CanaryServiceDependencies, "createClient" | "retainBeforeDispatch" | "onConfirmedObservation" | "now">;
type RunCanary = ReturnType<typeof createCapabilityCanaryService>;

/** Concrete SDK composition only. No client, timer, discovery, replay or probe starts at construction. */
export function createCapabilityPreparedService(options: {
  enabled?: boolean;
  createClient: () => SupabaseClient;
  now: () => number;
  canary?: CanaryConfiguration;
  reviewedMetadata?: readonly CapabilityAttentionMetadata[];
  reviewedWindows?: readonly string[];
  issueEvaluationKey?: () => string;
}) {
  const enabled = options.enabled === true;
  const clientFactory = options.createClient;
  const now = options.now;
  const issueEvaluationKey = options.issueEvaluationKey;
  const reviewedMetadata = structuredClone(options.reviewedMetadata ?? []);
  const reviewedWindows = [...(options.reviewedWindows ?? [])];
  const config = options.canary;
  // Functions/signals keep their identity; reviewed data and configuration are detached.
  const canary = config ? {
    now, revocationSignal: config.revocationSignal, withProfileLock: config.withProfileLock,
    bindings: config.bindings.map(binding => ({ ...binding, envelope: structuredClone(binding.envelope) })),
    fenced: { ...config.fenced },
  } : null;
  let client: SupabaseClient | undefined;
  function getClient(): SupabaseClient {
    if (!enabled) throw new Error("capability_prepared_service_disabled");
    client ??= clientFactory();
    return client;
  }
  // The preparation facade invokes this factory only after its own input validation.
  const retention = createCapabilityPreparationTransport({ enabled, createClient: getClient });
  const hooks = createCapabilityRetentionHooks({ enabled, port: retention });
  let runtimeTransport: CapabilityPersistenceTransport | undefined;
  const persistence = (signal: AbortSignal) => {
    if (signal.aborted) throw new Error("capability_prepared_service_cancelled");
    return runtimeTransport ??= createCapabilityPersistenceTransport(getClient());
  };
  const attention = createCapabilityAttentionService({ enabled, reviewedMetadata, now, issueEvaluationKey,
    onPrepared: hooks.onPrepared,
    transport: {
      readAttention: (scopeKey, signal) => persistence(signal).readAttention(scopeKey, signal),
      commitAttention: (input, signal) => persistence(signal).commitAttention(input, signal),
      listDueAttention: (limit, signal) => persistence(signal).listDueAttention(limit, signal),
    },
  });
  const recovery = createCapabilityRecoveryService({ enabled, port: retention, reviewedMetadata, reviewedWindows, now,
    status: (windowKey, requestKey, signal) => persistence(signal).get(windowKey, requestKey, signal),
    complete: (input, signal) => persistence(signal).complete(input, signal), attentionReplay: attention.replayPrepared,
  });
  const run = enabled && canary ? createCapabilityCanaryService({ ...canary, createClient: getClient,
    retainBeforeDispatch: hooks.retainBeforeDispatch, onConfirmedObservation: attention.onConfirmedObservation,
  }) : null;
  const runCanary: RunCanary = request => run ? run(request) : Promise.resolve({ state: "disabled" });
  return Object.freeze({ runCanary, attention: Object.freeze(attention), recovery: Object.freeze(recovery) });
}
