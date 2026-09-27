/** The worker supplies identity only; SQL resolves qualified immutable evidence. */
export type NativeStopRequest = Readonly<{
  workerId: string; bootId: string; taskId: string; attemptId: string; fence: number;
  evidenceId: string; revision: number; idempotencyKey: string;
}>;
export type NativeStopReceipt = Readonly<{
  outcome: "process_stopped"; attemptId: string; revision: number; taskRevision: number;
  resultEligible: boolean; phase: "awaiting_result" | "failed"; failureCode: string | null;
  verification: "unverified";
}>;
export type NativeStopRepository = Readonly<{
  admit: (request: NativeStopRequest, credentialHash: string, signal: AbortSignal) => Promise<NativeStopReceipt>;
}>;
/** Only an explicit transactional rejection proves no effect after dispatch. */
export class NativeStopFailure extends Error {
  constructor(readonly status: number, readonly code: string, readonly uncertain = false) { super(code); }
}
export function stopObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function stopInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value < Number.MAX_SAFE_INTEGER;
}
/** Treat malformed success as an ambiguous commit, never as rollback or verification. */
export function nativeStopReceipt(value: unknown, request: NativeStopRequest): NativeStopReceipt {
  const keys = ["outcome", "attemptId", "revision", "taskRevision", "resultEligible", "phase", "failureCode", "verification"];
  if (!stopObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || value.outcome !== "process_stopped" || value.attemptId !== request.attemptId
    || value.revision !== request.revision + 1 || !stopInteger(value.taskRevision)
    || typeof value.resultEligible !== "boolean" || value.verification !== "unverified"
    || (value.resultEligible && (value.phase !== "awaiting_result" || value.failureCode !== null))
    || (!value.resultEligible && (value.phase !== "failed" || typeof value.failureCode !== "string"
      || value.failureCode.length < 1 || value.failureCode.length > 100))) {
    throw new NativeStopFailure(503, "stop_outcome_unknown", true);
  }
  return value as NativeStopReceipt;
}
