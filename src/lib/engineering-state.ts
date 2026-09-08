import {
  canonicalEngineeringBindingKey, createEngineeringSnapshot,
  type EngineeringDecisionReference, type EngineeringSnapshot, type EngineeringSnapshotInput,
} from "./engineering-domain";

type Ref = EngineeringDecisionReference;
type Check = Readonly<{ checkId: string; versionId: string }>;
type CheckResult = Check & Readonly<{ outcome: "passed" | "failed"; evidenceHash: string }>;
type InputSource = Readonly<{ taskId: string; snapshotKey: string; attemptId: string; fence: number; outputManifestHash: string }>;
export type EngineeringDecisionState = Readonly<{
  reference: Ref; dependencies: readonly Ref[];
  disposition: "proposed" | "accepted" | "rejected" | "superseded";
  replacement: Ref | null;
}>;
export type EngineeringTaskState = Readonly<{
  taskId: string; snapshot: EngineeringSnapshot; prerequisites: readonly string[]; inputSource: InputSource | null;
  execution: "blocked" | "queued" | "running" | "succeeded" | "failed" | "canceled";
  verification: "unverified" | "checking" | "passed" | "failed" | "stale";
  adoption: "unadopted";
  invalidated: boolean; blockedBy: readonly string[];
  attemptId: string | null; fence: number | null;
  outputManifestHash: string | null; failureReason: string | null;
  requiredChecks: readonly Check[]; checkResults: readonly CheckResult[];
}>;
type TaskTarget = Readonly<{ taskId: string; snapshotKey: string }>;
type AttemptTarget = TaskTarget & Readonly<{ attemptId: string; fence: number }>;
type CheckTarget = AttemptTarget & Readonly<{ outputManifestHash: string }>;
type Action =
  | Readonly<{ type: "propose"; reference: Ref; dependencies: readonly Ref[] }>
  | Readonly<{ type: "accept" | "reject"; reference: Ref }>
  | Readonly<{ type: "supersede"; reference: Ref; replacement: Ref }>
  | Readonly<{ type: "queue"; taskId: string; snapshot: EngineeringSnapshotInput; prerequisites: readonly string[]; inputSourceTaskId: string | null; requiredChecks: readonly Check[] }>
  | (Readonly<{ type: "start" }> & AttemptTarget)
  | (Readonly<{ type: "result"; outcome: "succeeded" | "failed"; outputManifestHash: string | null; failureReason: string | null }> & AttemptTarget)
  | (Readonly<{ type: "start_verification" }> & CheckTarget)
  | (Readonly<{ type: "verification_result"; checks: readonly CheckResult[] }> & CheckTarget);
/** actorId is validated attribution supplied by the caller, never authentication or authorization. */
export type EngineeringStateCommand = Readonly<{ expectedRevision: number; actorId: string }> & Action;
export type EngineeringState = Readonly<{
  revision: number; baseline: EngineeringSnapshot;
  decisions: readonly EngineeringDecisionState[]; tasks: readonly EngineeringTaskState[];
  history: readonly Readonly<{ revision: number; command: EngineeringStateCommand }>[];
}>;
export type EngineeringStateDenial = "invalid_command" | "invalid_context" | "revision_conflict" | "unknown_reference" | "duplicate_identity" | "invalid_transition" | "dependency_conflict" | "context_mismatch" | "stale_task" | "incomplete_checks";
export type EngineeringStateResult = Readonly<{ ok: true; state: EngineeringState }> | Readonly<{ ok: false; reason: EngineeringStateDenial; state: EngineeringState }>;

class Denial extends Error {
  constructor(readonly reason: EngineeringStateDenial) { super(reason); }
}
function deny(reason: EngineeringStateDenial): never { throw new Denial(reason); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) deny("invalid_command");
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) deny("invalid_command");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) deny("invalid_command");
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) deny("invalid_command");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) deny("invalid_command");
  return value;
}
function array<T>(value: unknown, parse: (item: unknown) => T, key: (item: T) => string): T[] {
  if (!Array.isArray(value)) deny("invalid_command");
  const items: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) deny("invalid_command");
    items.push(parse(value[index]));
  }
  if (new Set(items.map(key)).size !== items.length) deny("duplicate_identity");
  return items;
}
function identity(reference: Ref): string { return JSON.stringify([reference.decisionId, reference.revisionId]); }
function equalRef(left: Ref, right: Ref): boolean { return identity(left) === identity(right) && left.contentHash === right.contentHash; }
function references(value: unknown, state: EngineeringState): Ref[] {
  const key = canonicalEngineeringBindingKey({ ...state.baseline.binding, includedDecisions: value as Ref[] });
  return (JSON.parse(key) as { includedDecisions: Ref[] }).includedDecisions;
}
function reference(value: unknown, state: EngineeringState): Ref { return references([value], state)[0]; }
function decision(state: EngineeringState, ref: Ref): EngineeringDecisionState {
  const found = state.decisions.find((item) => equalRef(item.reference, ref));
  if (!found) deny("unknown_reference");
  return found;
}
function task(state: EngineeringState, taskId: string): EngineeringTaskState {
  const found = state.tasks.find((item) => item.taskId === taskId);
  if (!found) deny("unknown_reference");
  return found;
}
function check(value: unknown): Check {
  const item = object(value, ["checkId", "versionId"]);
  return { checkId: text(item.checkId), versionId: text(item.versionId) };
}
function checkResult(value: unknown): CheckResult {
  const item = object(value, ["checkId", "versionId", "outcome", "evidenceHash"]);
  if (item.outcome !== "passed" && item.outcome !== "failed") deny("invalid_command");
  return { checkId: text(item.checkId), versionId: text(item.versionId), outcome: item.outcome, evidenceHash: hash(item.evidenceHash) };
}
function snapshot(value: EngineeringSnapshotInput): EngineeringSnapshot {
  try { return createEngineeringSnapshot(value); } catch { return deny("invalid_context"); }
}
function compatible(baseline: EngineeringSnapshot, candidate: EngineeringSnapshot): boolean {
  const withoutArtifacts = { ...candidate.binding, includedDecisions: baseline.binding.includedDecisions, artifactManifestHash: baseline.binding.artifactManifestHash };
  return canonicalEngineeringBindingKey(withoutArtifacts) === baseline.bindingKey;
}
function terminal(item: EngineeringDecisionState): boolean { return item.disposition === "rejected" || item.disposition === "superseded"; }
function closure(state: EngineeringState, refs: readonly Ref[]): EngineeringDecisionState[] {
  const result: EngineeringDecisionState[] = [];
  const visit = (ref: Ref) => {
    const item = decision(state, ref);
    if (result.includes(item)) return;
    result.push(item);
    item.dependencies.forEach(visit);
  };
  refs.forEach(visit);
  return result;
}
/** Reconciles eligibility without erasing execution observations or previously recorded evidence. */
function reconcile(state: EngineeringState): EngineeringState {
  let tasks = [...state.tasks];
  // Prerequisites can only name existing tasks, so queue order is topological.
  tasks = tasks.map((item, index) => {
    const predecessors = item.prerequisites.map((id) => tasks.find((other) => other.taskId === id)!);
    const invalidated = item.invalidated || closure(state, item.snapshot.binding.includedDecisions).some(terminal) || predecessors.some((other) => other.invalidated);
    const blockedBy = predecessors.filter((other) => other.verification !== "passed" || other.invalidated).map((other) => other.taskId);
    let execution = item.execution;
    let verification = item.verification;
    if (invalidated) {
      if (execution === "blocked" || execution === "queued") execution = "canceled";
      verification = "stale";
    } else if (execution === "blocked" || execution === "queued") {
      execution = blockedBy.length ? "blocked" : "queued";
    }
    const updated = { ...item, invalidated, blockedBy, execution, verification };
    tasks[index] = updated;
    return updated;
  });
  return { ...state, tasks };
}

/** Validates/copies the baseline once; malformed input throws the domain validator's TypeError. No action can replace it. */
export function createEngineeringState(input: EngineeringSnapshotInput): EngineeringState {
  const baseline = createEngineeringSnapshot(input);
  const decisions = baseline.binding.includedDecisions.map((ref): EngineeringDecisionState => ({ reference: ref, dependencies: [], disposition: "accepted", replacement: null }));
  return freeze({ revision: 0, baseline, decisions, tasks: [], history: [] });
}

const FIELDS: Record<string, readonly string[]> = {
  propose: ["reference", "dependencies"], accept: ["reference"], reject: ["reference"], supersede: ["reference", "replacement"],
  queue: ["taskId", "snapshot", "prerequisites", "inputSourceTaskId", "requiredChecks"],
  start: ["taskId", "snapshotKey", "attemptId", "fence"],
  result: ["taskId", "snapshotKey", "attemptId", "fence", "outcome", "outputManifestHash", "failureReason"],
  start_verification: ["taskId", "snapshotKey", "attemptId", "fence", "outputManifestHash"],
  verification_result: ["taskId", "snapshotKey", "attemptId", "fence", "outputManifestHash", "checks"],
};

function updateDecision(state: EngineeringState, input: Record<string, unknown>): EngineeringState {
  const ref = reference(input.reference, state);
  if (input.type === "propose") {
    if (state.decisions.some((item) => identity(item.reference) === identity(ref))) deny("duplicate_identity");
    const dependencies = references(input.dependencies, state);
    dependencies.forEach((dependency) => decision(state, dependency));
    // New immutable revisions may depend only on existing revisions: no forward edges or cycles.
    return { ...state, decisions: [...state.decisions, { reference: ref, dependencies, disposition: "proposed", replacement: null }] };
  }
  const previous = decision(state, ref);
  if (terminal(previous)) deny("invalid_transition");
  let replacement: Ref | null = null;
  let disposition: EngineeringDecisionState["disposition"];
  if (input.type === "accept") {
    if (previous.disposition !== "proposed") deny("invalid_transition");
    disposition = "accepted";
  } else if (input.type === "reject") {
    disposition = "rejected";
  } else {
    replacement = reference(input.replacement, state);
    if (decision(state, replacement).disposition !== "proposed" || equalRef(ref, replacement)) deny("invalid_transition");
    if (closure(state, [replacement]).includes(previous)) deny("dependency_conflict");
    disposition = "superseded";
  }
  return { ...state, decisions: state.decisions.map((item) => item === previous ? { ...item, disposition, replacement } : item) };
}

/** Explicit source provenance is separate from waiting for prerequisite checks; supplied digests still do not prove bytes. */
function inputSource(state: EngineeringState, context: EngineeringSnapshot, predecessors: readonly EngineeringTaskState[], sourceId: unknown): InputSource | null {
  if (sourceId === null) {
    if (context.binding.artifactManifestHash !== state.baseline.binding.artifactManifestHash || JSON.stringify(context.artifacts) !== JSON.stringify(state.baseline.artifacts)) deny("context_mismatch");
    return null;
  }
  const id = text(sourceId);
  const source = predecessors.find((item) => item.taskId === id);
  if (!source) deny("dependency_conflict");
  if (source.execution !== "succeeded" || source.verification !== "passed" || source.invalidated) deny("invalid_transition");
  if (source.outputManifestHash !== context.binding.artifactManifestHash) deny("context_mismatch");
  return { taskId: id, snapshotKey: source.snapshot.canonicalKey, attemptId: source.attemptId!, fence: source.fence!, outputManifestHash: source.outputManifestHash };
}

function queue(state: EngineeringState, input: Record<string, unknown>): EngineeringState {
  const taskId = text(input.taskId);
  if (state.tasks.some((item) => item.taskId === taskId)) deny("duplicate_identity");
  const context = snapshot(input.snapshot as EngineeringSnapshotInput);
  if (!compatible(state.baseline, context)) deny("context_mismatch");
  const refs = context.binding.includedDecisions;
  if (!refs.length || refs.some((ref) => decision(state, ref).disposition !== "accepted")) deny("invalid_transition");
  if (closure(state, refs).some(terminal)) deny("dependency_conflict");
  const prerequisites = array(input.prerequisites, text, (id) => id);
  const predecessors = prerequisites.map((id) => task(state, id));
  const source = inputSource(state, context, predecessors, input.inputSourceTaskId);
  const ancestors = new Set<EngineeringTaskState>();
  const visit = (item: EngineeringTaskState) => {
    if (ancestors.has(item)) return;
    ancestors.add(item);
    item.prerequisites.forEach((id) => visit(task(state, id)));
  };
  predecessors.forEach(visit);
  const covered = [...refs, ...[...ancestors].flatMap((item) => item.snapshot.binding.includedDecisions)];
  if (closure(state, refs).some((item) => !covered.some((ref) => equalRef(ref, item.reference)))) deny("dependency_conflict");
  const requiredChecks = array(input.requiredChecks, check, (item) => item.checkId);
  if (!requiredChecks.length) deny("incomplete_checks");
  const created: EngineeringTaskState = {
    taskId, snapshot: context, prerequisites, inputSource: source, execution: "queued", verification: "unverified", adoption: "unadopted", invalidated: false,
    blockedBy: [], attemptId: null, fence: null, outputManifestHash: null, failureReason: null, requiredChecks, checkResults: [],
  };
  return { ...state, tasks: [...state.tasks, created] };
}

function executionResult(previous: EngineeringTaskState, input: Record<string, unknown>): EngineeringTaskState {
  if (previous.execution !== "running") deny("invalid_transition");
  if (input.outcome === "succeeded" && input.failureReason === null) {
    return { ...previous, execution: "succeeded", outputManifestHash: hash(input.outputManifestHash) };
  }
  if (input.outcome === "failed" && input.outputManifestHash === null) {
    return { ...previous, execution: "failed", failureReason: text(input.failureReason) };
  }
  return deny("invalid_command");
}

function verificationResult(previous: EngineeringTaskState, input: Record<string, unknown>): EngineeringTaskState {
  if (previous.execution !== "succeeded") deny("invalid_transition");
  if (hash(input.outputManifestHash) !== previous.outputManifestHash) deny("context_mismatch");
  if (input.type === "start_verification") {
    if (previous.verification !== "unverified") deny("invalid_transition");
    return { ...previous, verification: "checking" };
  }
  if (previous.verification !== "checking") deny("invalid_transition");
  const checks = array(input.checks, checkResult, (item) => item.checkId);
  const missing = previous.requiredChecks.some((required) => !checks.some((item) => item.checkId === required.checkId && item.versionId === required.versionId));
  if (checks.length !== previous.requiredChecks.length || missing) deny("incomplete_checks");
  return { ...previous, verification: checks.every((item) => item.outcome === "passed") ? "passed" : "failed", checkResults: checks };
}

function updateTask(state: EngineeringState, input: Record<string, unknown>): EngineeringState {
  const previous = task(state, text(input.taskId));
  if (previous.snapshot.canonicalKey !== text(input.snapshotKey)) deny("context_mismatch");
  if (previous.invalidated) deny("stale_task");
  const attemptId = text(input.attemptId);
  const fence = integer(input.fence, 1);
  let updated = previous;
  if (input.type === "start") {
    if (previous.execution !== "queued") deny("invalid_transition");
    if (state.tasks.some((item) => item.attemptId === attemptId)) deny("duplicate_identity");
    updated = { ...previous, execution: "running", attemptId, fence };
  } else {
    if (previous.attemptId !== attemptId || previous.fence !== fence) deny("context_mismatch");
    if (input.type === "result") updated = executionResult(previous, input);
    else updated = verificationResult(previous, input);
  }
  return { ...state, tasks: state.tasks.map((item) => item === previous ? updated : item) };
}

/**
 * Pure CAS reducer for states returned by this module. Exact queued context is
 * independent of aggregate revision. Denials preserve the original state;
 * successful commands are copied/frozen for deterministic replay. No identity,
 * result or passing check grants execution permission or authoritative adoption.
 */
export function reduceEngineeringState(state: EngineeringState, command: unknown): EngineeringStateResult {
  try {
    const type = text((command as { type?: unknown } | null)?.type);
    if (!Object.prototype.hasOwnProperty.call(FIELDS, type)) deny("invalid_command");
    const input = object(command, ["type", "expectedRevision", "actorId", ...FIELDS[type]]);
    text(input.actorId);
    if (integer(input.expectedRevision, 0) !== state.revision) deny("revision_conflict");
    if (state.revision === Number.MAX_SAFE_INTEGER) deny("revision_conflict");
    let next: EngineeringState;
    if (["propose", "accept", "reject", "supersede"].includes(type)) next = updateDecision(state, input);
    else if (type === "queue") next = queue(state, input);
    else next = updateTask(state, input);
    const revision = state.revision + 1;
    const history = [...state.history, { revision, command: structuredClone(command) as EngineeringStateCommand }];
    return { ok: true, state: freeze({ ...reconcile(next), revision, history }) };
  } catch (error) {
    return { ok: false, reason: error instanceof Denial ? error.reason : "invalid_command", state };
  }
}
