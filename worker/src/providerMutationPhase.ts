import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tracks whether a provider-facing mutation (file upload or quote configuration)
 * may have started during one claimed task. Once started, the phase never
 * resets: any later failure in that task, whatever its type or message, is
 * treated as possibly having mutated provider state and is not auto-retried.
 */
export type ProviderMutationPhase = {
  started: boolean;
  /**
   * OVD-734: the task's durable permit side effect was stamped. Its permit is
   * then consumed, so a requeue could never dispatch again and no later
   * failure in the task is retried. Unlike `started` it is not evidence that a
   * provider mutation happened.
   */
  permitSideEffectStarted?: boolean;
};

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

/** Call once the durable permit side effect is stamped (OVD-734). No-op outside a tracked task. */
export function markProviderDispatchSideEffectStarted(): void {
  const phase = activePhase.getStore();
  if (phase) {
    phase.permitSideEffectStarted = true;
  }
}

/**
 * Persisted failure-payload fields that explain a fail-closed retry decision.
 * They apply to every error type, including plain errors that cannot carry a
 * vendor payload, and stay empty until a provider mutation may have started.
 */
export function providerMutationEvidence(
  phase: ProviderMutationPhase | undefined = currentProviderMutationPhase(),
): { providerMutationPossible?: true } {
  return phase?.started ? { providerMutationPossible: true } : {};
}
