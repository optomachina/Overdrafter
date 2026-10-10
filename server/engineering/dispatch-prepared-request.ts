import { nativeDigest } from "../../src/lib/engineering-cumulative.ts";
import {
  classifyPreparedDepthRequest, type PreparedClarification, type PreparedInterpretation,
} from "./interpret-prepared-request.ts";

export type DispatchIdentity = Readonly<{
  requestId: string;
  expectedQueueRevision: number;
  idempotencyKey: string;
}>;
type Reservation = Readonly<{
  state: "reserved" | "completed" | "failed" | "timed_out";
  invoke: boolean;
  receipt?: unknown;
  failureCode?: string | null;
  text?: string;
  contextText?: string;
  inputSnapshotId?: string;
  contextSha256?: string;
  inputSha256?: string;
  organizationId?: string;
  projectId?: string;
  priorClarification?: PreparedClarification | null;
}>;
export type PreparedAdapter = (input: Readonly<{
  text: string;
  contextText: string;
  contextSha256: string;
  priorClarification: PreparedClarification | null;
  signal: AbortSignal;
}>) => PromiseLike<unknown>;
export type PreparedDispatchRuntime = Readonly<{
  enabled: () => boolean;
  reserve: (identity: DispatchIdentity, signal: AbortSignal) => PromiseLike<unknown>;
  finish: (identity: DispatchIdentity, interpretation: PreparedInterpretation,
    signal: AbortSignal) => PromiseLike<unknown>;
  fail: (identity: DispatchIdentity, code: "timed_out" | "adapter_error" | "invalid_output" | "conflict",
    signal: AbortSignal) => PromiseLike<unknown>;
  adapter: PreparedAdapter;
  deadlineMs?: number;
}>;
export type DispatchResult = Readonly<{
  state: "disabled" | "completed" | "failed" | "reserved" | "budget_exhausted" | "conflict" | "unknown";
  receipt?: unknown;
  failureCode?: string;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    && value !== "00000000-0000-0000-0000-000000000000";
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validIdentity(value: DispatchIdentity): boolean {
  return uuid(value.requestId) && uuid(value.idempotencyKey)
    && Number.isSafeInteger(value.expectedQueueRevision) && value.expectedQueueRevision >= 0
    && value.expectedQueueRevision < Number.MAX_SAFE_INTEGER;
}
function validPrior(value: unknown, contextSha256: string): value is PreparedClarification | null {
  if (value === null || value === undefined) return true;
  if (!object(value) || !exactKeys(value, ["contextSha256", "depthMm", "reason"])) return false;
  if (value.contextSha256 !== contextSha256 || (value.reason !== "unit" && value.reason !== "depth")) return false;
  if (value.reason === "unit") return typeof value.depthMm === "number" && value.depthMm >= 6 && value.depthMm <= 10;
  return value.depthMm === null;
}
function proposal(value: unknown, expected: PreparedInterpretation): boolean {
  if (!object(value) || !exactKeys(value, ["depthMm", "outcome", "schema"])) return false;
  return value.schema === "overdrafter.prepared-interpretation.v1"
    && value.outcome === expected.outcome && value.depthMm === expected.depthMm;
}
async function bounded<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const result = Promise.resolve(promise);
    const aborted = () => reject(new Error("deadline_exceeded"));
    if (signal.aborted) { void result.catch(() => undefined); aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    result.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function replayResult(reservation: Reservation): DispatchResult {
  if (reservation.state === "completed") return { state: "completed", receipt: reservation.receipt };
  if (reservation.state === "failed" || reservation.state === "timed_out") {
    return { state: "failed", failureCode: reservation.failureCode ?? reservation.state };
  }
  return { state: "reserved" };
}
function validReservation(reservation: Reservation): boolean {
  return reservation.state === "reserved" && typeof reservation.text === "string"
    && typeof reservation.contextText === "string" && uuid(reservation.inputSnapshotId)
    && digest(reservation.contextSha256) && digest(reservation.inputSha256)
    && uuid(reservation.organizationId) && uuid(reservation.projectId)
    && validPrior(reservation.priorClarification, reservation.contextSha256);
}
async function prepareInterpretation(reservation: Reservation, runtime: PreparedDispatchRuntime,
  signal: AbortSignal, checkDeadline: () => void): Promise<PreparedInterpretation> {
  if (!validReservation(reservation)) throw new TypeError("Invalid reserved interpretation context.");
  const text = reservation.text!;
  const contextText = reservation.contextText!;
  const contextSha256 = reservation.contextSha256!;
  if (await nativeDigest(text) !== reservation.inputSha256) {
    throw new TypeError("Reserved request text changed.");
  }
  const interpretation = await classifyPreparedDepthRequest({
    text, contextText, inputSnapshotId: reservation.inputSnapshotId!,
    expectedContextSha256: contextSha256, organizationId: reservation.organizationId!,
    projectId: reservation.projectId!, priorClarification: reservation.priorClarification,
  });
  // Hash validation may outlast the deadline; do not start an adapter call then.
  checkDeadline();
  const candidate = await bounded(runtime.adapter({ text, contextText, contextSha256,
    priorClarification: reservation.priorClarification ?? null, signal }), signal);
  if (!proposal(candidate, interpretation)) throw new TypeError("Invalid model proposal.");
  return interpretation;
}
async function recordFailure(identity: DispatchIdentity, runtime: PreparedDispatchRuntime,
  code: "timed_out" | "adapter_error" | "invalid_output" | "conflict"): Promise<string | null> {
  try {
    const deadlineAt = performance.now() + 5_000;
    const signal = AbortSignal.timeout(5_000);
    if (performance.now() >= deadlineAt) return null;
    const receipt = await bounded(runtime.fail(identity, code, signal), signal);
    if (signal.aborted || performance.now() >= deadlineAt) return null;
    // The database may replace the requested code when its own deadline elapsed.
    if (!object(receipt) || receipt.requestId !== identity.requestId || receipt.state !== "failed"
      || typeof receipt.failureCode !== "string"
      || (receipt.failureCode !== code && receipt.failureCode !== "timed_out")) return null;
    return receipt.failureCode;
  } catch {
    return null;
  }
}
async function errorResult(identity: DispatchIdentity, runtime: PreparedDispatchRuntime,
  error: unknown, reserved: boolean, finishing: boolean, aborted: boolean): Promise<DispatchResult> {
  if (finishing) {
    if (aborted) return { state: "unknown" };
    if (error instanceof Error && error.message === "PT409") {
      await recordFailure(identity, runtime, "conflict");
      return { state: "conflict" };
    }
    // A finalization call may have committed before its reply was lost.
    return { state: "unknown" };
  }
  if (!reserved) {
    if (aborted) return { state: "unknown" };
    if (error instanceof Error && error.message === "PT429") return { state: "budget_exhausted" };
    if (error instanceof Error && error.message === "PT409") return { state: "conflict" };
    return { state: "unknown" };
  }
  let code: "timed_out" | "adapter_error" | "invalid_output";
  if (aborted) code = "timed_out";
  else if (error instanceof TypeError) code = "invalid_output";
  else code = "adapter_error";
  const recorded = await recordFailure(identity, runtime, code);
  return recorded ? { state: "failed", failureCode: recorded } : { state: "unknown", failureCode: code };
}

/**
 * One reserved model call per request. The model proposes typed data; only the
 * retained deterministic classifier and database resolution construct intent.
 * Unknown database delivery is never retried by minting a new identity.
 */
export async function dispatchPreparedRequest(identity: DispatchIdentity,
  runtime: PreparedDispatchRuntime): Promise<DispatchResult> {
  if (!runtime.enabled()) return { state: "disabled" };
  if (!validIdentity(identity)) return { state: "conflict" };
  const deadlineMs = runtime.deadlineMs ?? 15_000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 15_000) {
    throw new TypeError("Invalid interpretation deadline.");
  }
  const controller = new AbortController();
  const deadlineAt = performance.now() + deadlineMs;
  const expireIfElapsed = () => {
    if (performance.now() >= deadlineAt) controller.abort();
  };
  const checkDeadline = () => {
    expireIfElapsed();
    controller.signal.throwIfAborted();
  };
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let reserved = false;
  let finishing = false;
  try {
    checkDeadline();
    const raw = await bounded(runtime.reserve(identity, controller.signal), controller.signal);
    // An overdue reservation may have committed; leave delivery unknown.
    checkDeadline();
    if (!object(raw) || (raw.state !== "reserved" && raw.state !== "completed"
      && raw.state !== "failed" && raw.state !== "timed_out")
      || typeof raw.invoke !== "boolean") return { state: "unknown" };
    const reservation = raw as Reservation;
    if (!reservation.invoke) return replayResult(reservation);
    reserved = true;
    const interpretation = await prepareInterpretation(reservation, runtime, controller.signal, checkDeadline);
    checkDeadline();
    finishing = true;
    const receipt = await bounded(runtime.finish(identity, interpretation, controller.signal), controller.signal);
    checkDeadline();
    return { state: "completed", receipt };
  } catch (error) {
    expireIfElapsed();
    return errorResult(identity, runtime, error, reserved, finishing, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}
