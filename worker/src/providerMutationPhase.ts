import { AsyncLocalStorage } from "node:async_hooks";
import { VendorAutomationError } from "./types.js";

/**
 * Tracks whether a provider-facing mutation (file upload or quote configuration)
 * may have started during one claimed task. Once started, the phase never
 * resets: any later failure in that task, whatever its type or message, is
 * treated as possibly having mutated provider state and is not auto-retried.
 */
export type ProviderMutationPhase = { started: boolean };

const activePhase = new AsyncLocalStorage<ProviderMutationPhase>();

export function createProviderMutationPhase(): ProviderMutationPhase {
  return { started: false };
}

export function runInProviderMutationPhase<T>(
  phase: ProviderMutationPhase,
  operation: () => Promise<T>,
): Promise<T> {
  return activePhase.run(phase, operation);
}

export function currentProviderMutationPhase(): ProviderMutationPhase | undefined {
  return activePhase.getStore();
}

/**
 * Call immediately before the first provider-facing mutation. Marking happens
 * before the action because the action itself may partially succeed and then
 * throw. Outside a tracked task this is a no-op.
 */
export function markProviderMutationStarted(): void {
  const phase = activePhase.getStore();
  if (phase) {
    phase.started = true;
  }
}

/**
 * Records the phase on a vendor error's persisted payload so the failure
 * evidence matches the retry decision. Plain errors cannot carry the payload;
 * their retry decision reads the phase directly.
 */
export function annotateProviderMutationFailure(
  error: unknown,
  phase: ProviderMutationPhase | undefined = currentProviderMutationPhase(),
): void {
  if (phase?.started && error instanceof VendorAutomationError) {
    error.payload.providerMutationPossible = true;
  }
}
