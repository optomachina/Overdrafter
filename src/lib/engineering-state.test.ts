import { describe, expect, it } from "vitest";
import { createEngineeringSnapshot, type EngineeringDecisionReference, type EngineeringSnapshotInput } from "./engineering-domain";
import { createEngineeringState, reduceEngineeringState, type EngineeringState, type EngineeringStateDenial } from "./engineering-state";

const digest = (character: string) => character.repeat(64);
const ref = (decisionId: string, revisionId = "v1"): EngineeringDecisionReference => ({ decisionId, revisionId, contentHash: digest("d") });
const BASE: EngineeringSnapshotInput = {
  snapshotId: "S142",
  binding: {
    scope: { organizationId: "organization", projectId: "project" }, baselineSnapshotId: "S142", baselineManifestHash: digest("a"),
    includedDecisions: [], requirementsHash: digest("b"), artifactManifestHash: digest("c"), toolchainHash: digest("e"), verificationPolicyHash: digest("f"),
  },
  request: { id: "request", scope: { organizationId: "organization", projectId: "project" }, text: "Evaluate changes", desiredOutcome: "Compare checked alternatives", selectedReferences: [], statements: [] },
  artifacts: [],
};
const CHECKS = [{ checkId: "envelope", versionId: "v1" }, { checkId: "mass", versionId: "v2" }];
const RESULTS = CHECKS.map((check) => ({ ...check, outcome: "passed" as const, evidenceHash: digest("a") }));
const snapshot = (id: string, references: readonly EngineeringDecisionReference[]): EngineeringSnapshotInput => ({
  ...BASE, snapshotId: id, binding: { ...BASE.binding, includedDecisions: references },
});
function apply(state: EngineeringState, action: Record<string, unknown>): EngineeringState {
  const result = reduceEngineeringState(state, { expectedRevision: state.revision, actorId: "engineer", ...action });
  if (result.ok === false) throw new Error(`Unexpected denial: ${result.reason}, ${action.type}`);
  return result.state;
}
function denied(state: EngineeringState, action: Record<string, unknown>, reason?: EngineeringStateDenial): void {
  const result = reduceEngineeringState(state, { expectedRevision: state.revision, actorId: "engineer", ...action });
  expect(result.ok).toBe(false);
  expect(result.state).toBe(state);
  if (result.ok === false && reason) expect(result.reason).toBe(reason);
}
function accepted(state: EngineeringState, reference: EngineeringDecisionReference, dependencies: readonly EngineeringDecisionReference[] = []): EngineeringState {
  return apply(apply(state, { type: "propose", reference, dependencies }), { type: "accept", reference });
}
function queued(state: EngineeringState, id: string, refs: readonly EngineeringDecisionReference[], prerequisites: readonly string[] = []): EngineeringState {
  return apply(state, { type: "queue", taskId: id, snapshot: snapshot(id, refs), prerequisites, inputSourceTaskId: null, requiredChecks: CHECKS });
}
function target(state: EngineeringState, id: string): Record<string, unknown> {
  const item = state.tasks.find((entry) => entry.taskId === id)!;
  return { taskId: id, snapshotKey: item.snapshot.canonicalKey, attemptId: `attempt-${id}`, fence: 1 };
}
function succeeded(state: EngineeringState, id: string): EngineeringState {
  const running = apply(state, { type: "start", ...target(state, id) });
  return apply(running, { type: "result", ...target(running, id), outcome: "succeeded", outputManifestHash: digest("a"), failureReason: null });
}
function verified(state: EngineeringState, id: string): EngineeringState {
  const checking = apply(state, { type: "start_verification", ...target(state, id), outputManifestHash: digest("a") });
  return apply(checking, { type: "verification_result", ...target(checking, id), outputManifestHash: digest("a"), checks: RESULTS });
}
function getTask(state: EngineeringState, id: string) { return state.tasks.find((item) => item.taskId === id)!; }

describe("engineering decision and execution state", () => {
  it("records five decisions while an earlier task runs without staling its exact context", () => {
    let state = queued(accepted(createEngineeringState(BASE), ref("D143")), "earlier", [ref("D143")]);
    state = apply(state, { type: "start", ...target(state, "earlier") });
    const launchRevision = state.revision;
    const originalKey = getTask(state, "earlier").snapshot.canonicalKey;
    for (let id = 144; id <= 148; id += 1) {
      state = queued(accepted(state, ref(`D${id}`)), `task-${id}`, [ref(`D${id}`)]);
    }
    expect(state.tasks.filter((item) => item.execution === "queued")).toHaveLength(5);
    expect(state.revision).toBeGreaterThan(launchRevision);
    state = apply(state, { type: "result", ...target(state, "earlier"), outcome: "succeeded", outputManifestHash: digest("a"), failureReason: null });
    expect(getTask(state, "earlier")).toMatchObject({ execution: "succeeded", verification: "unverified", adoption: "unadopted", invalidated: false });
    expect(getTask(state, "earlier").snapshot.canonicalKey).toBe(originalKey);
    expect(state.baseline.snapshotId).toBe("S142");
    expect(state.baseline.binding.includedDecisions).toEqual([]);
  });

  it("rejects CAS collisions atomically and validates attribution without treating it as authority", () => {
    const initial = createEngineeringState(BASE);
    const first = apply(initial, { type: "propose", reference: ref("D143"), dependencies: [] });
    denied(first, { type: "propose", expectedRevision: 0, reference: ref("D144"), dependencies: [] }, "revision_conflict");
    for (const actorId of ["", " engineer", null, 42]) denied(first, { type: "accept", reference: ref("D143"), actorId }, "invalid_command");
    for (const expectedRevision of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) denied(first, { type: "accept", reference: ref("D143"), expectedRevision }, "invalid_command");
    expect(first.history).toHaveLength(1);
    expect(initial.decisions).toHaveLength(0);
    expect(first.history[0].command.actorId).toBe("engineer");
  });

  it("executes independent tasks out of order while transitive dependents wait for exact verified predecessors", () => {
    let state = accepted(createEngineeringState(BASE), ref("D143"));
    state = accepted(state, ref("D144"), [ref("D143")]);
    state = accepted(state, ref("D146"), [ref("D144")]);
    state = accepted(state, ref("D147"));
    state = queued(state, "first", [ref("D143")]);
    state = queued(state, "second", [ref("D144")], ["first"]);
    state = queued(state, "third", [ref("D146")], ["second"]);
    state = queued(state, "independent", [ref("D147")]);
    state = verified(succeeded(state, "independent"), "independent");
    denied(state, { type: "start", ...target(state, "third") }, "invalid_transition");
    state = succeeded(state, "first");
    expect(getTask(state, "second").execution).toBe("blocked");
    state = verified(state, "first");
    expect(getTask(state, "second").execution).toBe("queued");
    expect(getTask(state, "third").execution).toBe("blocked");
    state = verified(succeeded(state, "second"), "second");
    expect(getTask(state, "third").execution).toBe("queued");
    expect(getTask(state, "independent").verification).toBe("passed");
    expect(getTask(state, "independent").adoption).toBe("unadopted");
  });

  it("denies invalid predecessor graphs and blocks failures without dropping independent results", () => {
    let state = accepted(createEngineeringState(BASE), ref("D143"));
    denied(state, { type: "propose", reference: ref("D144"), dependencies: [ref("missing")] }, "unknown_reference");
    denied(state, { type: "propose", reference: ref("self"), dependencies: [ref("self")] }, "unknown_reference");
    denied(state, { type: "propose", reference: ref("D144"), dependencies: [ref("D143", "wrong")] }, "unknown_reference");
    denied(state, { type: "propose", reference: { ...ref("D143"), contentHash: digest("f") }, dependencies: [] }, "duplicate_identity");
    state = accepted(state, ref("D144"), [ref("D143")]);
    state = accepted(state, ref("D147"));
    state = queued(state, "first", [ref("D143")]);
    denied(state, { type: "queue", taskId: "missing-prerequisite", snapshot: snapshot("x", [ref("D144")]), prerequisites: [], inputSourceTaskId: null, requiredChecks: CHECKS }, "dependency_conflict");
    state = queued(state, "dependent", [ref("D144")], ["first"]);
    state = verified(succeeded(queued(state, "independent", [ref("D147")]), "independent"), "independent");
    state = apply(state, { type: "start", ...target(state, "first") });
    state = apply(state, { type: "result", ...target(state, "first"), outcome: "failed", outputManifestHash: null, failureReason: "native operation failed" });
    expect(getTask(state, "dependent")).toMatchObject({ execution: "blocked", blockedBy: ["first"] });
    expect(getTask(state, "independent").verification).toBe("passed");
    denied(state, { type: "result", ...target(state, "first"), outcome: "succeeded", outputManifestHash: digest("a"), failureReason: null }, "invalid_transition");
    denied(state, { type: "start", ...target(state, "first") }, "invalid_transition");
    state = apply(state, { type: "reject", reference: ref("D143") });
    expect(getTask(state, "first").execution).toBe("failed");
    expect(getTask(state, "dependent")).toMatchObject({ execution: "canceled", verification: "stale" });
    denied(state, { type: "accept", reference: ref("D143") }, "invalid_transition");
  });

  it("supersedes terminal intent and transitive eligibility while preserving prior observations and evidence", () => {
    let state = accepted(createEngineeringState(BASE), ref("D143"));
    state = accepted(state, ref("D144"), [ref("D143")]);
    state = accepted(state, ref("D145"), [ref("D144")]);
    state = queued(state, "first", [ref("D143")]);
    state = verified(succeeded(state, "first"), "first");
    state = queued(state, "second", [ref("D144")], ["first"]);
    state = verified(succeeded(state, "second"), "second");
    state = queued(state, "third", [ref("D145")], ["second"]);
    state = apply(state, { type: "start", ...target(state, "third") });
    const before = state;
    state = apply(state, { type: "propose", reference: ref("D143", "v2"), dependencies: [] });
    state = apply(state, { type: "supersede", reference: ref("D143"), replacement: ref("D143", "v2") });
    expect(getTask(state, "first")).toMatchObject({ execution: "succeeded", verification: "stale", checkResults: RESULTS });
    expect(getTask(state, "second")).toMatchObject({ execution: "succeeded", verification: "stale", checkResults: RESULTS });
    expect(getTask(state, "third")).toMatchObject({ execution: "running", verification: "stale", invalidated: true });
    expect(state.decisions.find((item) => item.reference.revisionId === "v2")?.disposition).toBe("proposed");
    denied(state, { type: "result", ...target(state, "third"), outcome: "succeeded", outputManifestHash: digest("a"), failureReason: null }, "stale_task");
    denied(state, { type: "accept", reference: ref("D143") }, "invalid_transition");
    denied(state, { type: "reject", reference: ref("D143") }, "invalid_transition");
    expect(getTask(before, "first").verification).toBe("passed");
    expect(getTask(before, "third").execution).toBe("running");
    let cyclic = accepted(createEngineeringState(BASE), ref("old"));
    cyclic = apply(cyclic, { type: "propose", reference: ref("new"), dependencies: [ref("old")] });
    denied(cyclic, { type: "supersede", reference: ref("old"), replacement: ref("new") }, "dependency_conflict");
  });

  it("denies composite attempt/context swaps, malformed queues and duplicate completions", () => {
    let state = accepted(createEngineeringState(BASE), ref("D143"));
    state = queued(state, "first", [ref("D143")]);
    state = queued(state, "other", [ref("D143")]);
    state = apply(state, { type: "start", ...target(state, "first") });
    denied(state, { type: "start", ...target(state, "other"), attemptId: "attempt-first" }, "duplicate_identity");
    state = apply(state, { type: "start", ...target(state, "other") });
    const result = { type: "result", ...target(state, "first"), outcome: "succeeded", outputManifestHash: digest("a"), failureReason: null };
    for (const swap of [{ taskId: "other" }, { attemptId: "attempt-other" }, { fence: 2 }, { snapshotKey: getTask(state, "other").snapshot.canonicalKey }, { attemptId: "attempt-other", fence: 1, snapshotKey: getTask(state, "other").snapshot.canonicalKey }]) {
      denied(state, { ...result, ...swap }, "context_mismatch");
    }
    for (const field of ["baselineSnapshotId", "baselineManifestHash", "requirementsHash", "artifactManifestHash", "toolchainHash", "verificationPolicyHash"] as const) {
      const context = snapshot("first", [ref("D143")]);
      const changed = { ...context, binding: { ...context.binding, [field]: field === "baselineSnapshotId" ? "different" : digest("0") } };
      denied(state, { ...result, snapshotKey: createEngineeringSnapshot(changed).canonicalKey }, "context_mismatch");
    }
    for (const scope of [{ organizationId: "other", projectId: "project" }, { organizationId: "organization", projectId: "other" }]) {
      const changed = { ...snapshot("first", [ref("D143")]), binding: { ...BASE.binding, scope, includedDecisions: [ref("D143")] }, request: { ...BASE.request, scope } };
      denied(state, { ...result, snapshotKey: createEngineeringSnapshot(changed).canonicalKey }, "context_mismatch");
      denied(state, { type: "queue", taskId: "foreign", snapshot: changed, prerequisites: [], inputSourceTaskId: null, requiredChecks: CHECKS }, "context_mismatch");
    }
    const changedDecision = snapshot("first", [ref("D143", "v2")]);
    denied(state, { ...result, snapshotKey: createEngineeringSnapshot(changedDecision).canonicalKey }, "context_mismatch");
    denied(state, { type: "queue", taskId: "malformed", snapshot: { ...BASE, unexpected: true }, prerequisites: [], inputSourceTaskId: null, requiredChecks: CHECKS }, "invalid_context");
    denied(state, { type: "queue", taskId: "empty-checks", snapshot: snapshot("empty", [ref("D143")]), prerequisites: [], inputSourceTaskId: null, requiredChecks: [] }, "incomplete_checks");
    state = apply(state, result);
    denied(state, result, "invalid_transition");
  });

  it("distinguishes baseline inputs, waiting prerequisites and explicit verified output consumption", () => {
    let state = queued(accepted(createEngineeringState(BASE), ref("D143")), "producer", [ref("D143")]);
    state = accepted(state, ref("D144"), [ref("D143")]);
    const context = snapshot("consumer", [ref("D144")]);
    const evolved = { ...context, binding: { ...context.binding, artifactManifestHash: digest("a") } };
    const command = { type: "queue", taskId: "consumer", snapshot: evolved, prerequisites: ["producer"], inputSourceTaskId: "producer", requiredChecks: CHECKS };
    denied(state, command, "invalid_transition");
    denied(state, { ...command, inputSourceTaskId: null }, "context_mismatch");
    denied(state, { ...command, prerequisites: [] }, "dependency_conflict");
    state = succeeded(state, "producer");
    denied(state, command, "invalid_transition");
    state = verified(state, "producer");
    denied(state, { ...command, snapshot: context }, "context_mismatch");
    denied(state, { ...command, inputSourceTaskId: null }, "context_mismatch");
    const forgedArtifacts = [{ artifactId: "forged", scope: BASE.binding.scope, kind: "native_cad", contentHash: digest("f"), document: {
      scope: BASE.binding.scope, documentId: "model", canonicalPartId: null, partVersionId: null, configurationId: null,
      nativeVersion: null, officialRevision: null, observedAt: "2026-09-08T00:00:00.000Z", ownerId: "native",
    } }];
    denied(state, { ...command, inputSourceTaskId: null, snapshot: { ...context, artifacts: forgedArtifacts } }, "context_mismatch");
    state = apply(state, command);
    expect(getTask(state, "consumer").inputSource).toEqual({
      taskId: "producer", snapshotKey: getTask(state, "producer").snapshot.canonicalKey,
      attemptId: "attempt-producer", fence: 1, outputManifestHash: digest("a"),
    });
    expect(getTask(state, "consumer").execution).toBe("queued");
    state = apply(state, { type: "reject", reference: ref("D143") });
    expect(getTask(state, "consumer")).toMatchObject({ execution: "canceled", verification: "stale", adoption: "unadopted" });
  });

  it("requires every exact check and prevents stale, contradictory or shortcut verification", () => {
    let state = succeeded(queued(accepted(createEngineeringState(BASE), ref("D143")), "first", [ref("D143")]), "first");
    const start = { type: "start_verification", ...target(state, "first"), outputManifestHash: digest("a") };
    denied(state, { ...start, outputManifestHash: digest("b") }, "context_mismatch");
    state = apply(state, start);
    const result = { type: "verification_result", ...target(state, "first"), outputManifestHash: digest("a"), checks: RESULTS };
    denied(state, { ...result, checks: [] }, "incomplete_checks");
    denied(state, { ...result, checks: RESULTS.slice(0, 1) }, "incomplete_checks");
    denied(state, { ...result, checks: [RESULTS[0], RESULTS[0]] }, "duplicate_identity");
    denied(state, { ...result, checks: [{ ...RESULTS[0], versionId: "wrong" }, RESULTS[1]] }, "incomplete_checks");
    denied(state, { ...result, verified: true }, "invalid_command");
    denied(state, { ...result, outputManifestHash: digest("b") }, "context_mismatch");
    denied(state, { ...result, attemptId: "different" }, "context_mismatch");
    const checking = state;
    state = apply(state, { ...result, checks: [{ ...RESULTS[0], outcome: "failed" }, RESULTS[1]] });
    expect(getTask(state, "first")).toMatchObject({ execution: "succeeded", verification: "failed" });
    denied(state, result, "invalid_transition");
    const rejected = apply(checking, { type: "reject", reference: ref("D143") });
    denied(rejected, result, "stale_task");
    expect(getTask(rejected, "first").verification).toBe("stale");
  });

  it("owns immutable history, replays deterministically, handles codepoint references and exposes no adoption action", () => {
    const input = structuredClone(BASE);
    let state = createEngineeringState(input);
    const initial = state;
    (input.request as { text: string }).text = "mutated after initialization";
    const original = { expectedRevision: 0, actorId: "engineer", type: "propose", reference: { ...ref("\u{10000}") }, dependencies: [] as EngineeringDecisionReference[] };
    const result = reduceEngineeringState(state, original);
    if (result.ok === false) throw new Error(result.reason);
    state = result.state;
    original.reference.contentHash = digest("b");
    original.dependencies.push(ref("unexpected"));
    expect(state.history[0].command).toMatchObject({ reference: ref("\u{10000}"), dependencies: [] });
    expect(state.baseline.request.text).toBe(BASE.request.text);
    state = apply(state, { type: "accept", reference: ref("\u{10000}") });
    state = accepted(state, ref("\uE000"));
    state = accepted(state, ref("a|b", "c"));
    state = accepted(state, ref("a", "b|c"));
    state = queued(state, "unicode", [ref("\u{10000}"), ref("\uE000"), ref("a|b", "c"), ref("a", "b|c")]);
    expect(getTask(state, "unicode").snapshot.binding.includedDecisions.map((item) => item.decisionId)).toEqual(["a", "a|b", "\uE000", "\u{10000}"]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.history[0].command)).toBe(true);
    expect(Object.isFrozen(state.decisions[0].dependencies)).toBe(true);
    expect(() => (state.decisions as unknown as unknown[]).push({})).toThrow(TypeError);
    for (const type of ["adopt", "publish", "set_baseline", "__proto__", "constructor"]) denied(state, { type }, "invalid_command");
    for (const malformed of [null, [], { type: "accept" }, { type: "queue", snapshot: null }]) {
      const failure = reduceEngineeringState(state, malformed);
      expect(failure).toMatchObject({ ok: false, reason: "invalid_command" });
      expect(failure.state).toBe(state);
    }
    let replay = createEngineeringState(BASE);
    for (const event of state.history) {
      const next = reduceEngineeringState(replay, event.command);
      if (next.ok === false) throw new Error(next.reason);
      replay = next.state;
    }
    expect(replay).toEqual(state);
    expect(initial).toEqual(createEngineeringState(BASE));
    expect(state.baseline).toBe(initial.baseline);
    expect(() => createEngineeringState({ ...BASE, binding: { ...BASE.binding, requirementsHash: "bad" } })).toThrow(TypeError);
  });
});
