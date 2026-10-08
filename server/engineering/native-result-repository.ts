import type { NativeFinalizationRepository } from "./native-result-finalization";
import type { NativeResultRepository } from "./native-result-receipt";
import type { NativeOwnerSqlPool } from "./native-result-executor";
import { createNativeFinalizationPersistence } from "./native-result-persistence";

/** Compose registered-byte admission/read verification with concrete private
 * pending persistence and OVD561 finalization. Both this adapter and the finalizer
 * must be explicitly enabled by trusted server composition; no route is added. */
export function createNativeResultRepository(config: {
  results: NativeResultRepository; pool: NativeOwnerSqlPool; enabled?: boolean; timeoutMs?: number;
}): NativeFinalizationRepository {
  const { results } = config;
  return Object.freeze({
    loadAdmission: (task, attempt) => results.loadAdmission(task, attempt),
    readRegisteredObject: (id, signal) => results.readRegisteredObject(id, signal),
    isCurrent: admission => results.isCurrent(admission),
    ...createNativeFinalizationPersistence(config),
  });
}
