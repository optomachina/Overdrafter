import { describe, expect, it } from "vitest";
import { createEngineeringSnapshot, type EngineeringDocumentReference } from "./engineering-domain";
import { preflightEngineeringTransaction, type EngineeringOperation, type EngineeringOperationEnvelope, type EngineeringPreflightContext, type EngineeringPreparedTarget } from "./engineering-preflight";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type Fixture = Mutable<{ envelope: EngineeringOperationEnvelope; context: EngineeringPreflightContext }>;
const hash = (character: string) => character.repeat(64);

function fixture(): Fixture {
  const scope = { organizationId: "org-a", projectId: "project-a" };
  const document: EngineeringDocumentReference = { scope, documentId: "native-model", canonicalPartId: "part-a", partVersionId: "version-a", configurationId: "default", nativeVersion: "7", officialRevision: "A", observedAt: "2026-09-08T01:30:00.000Z", ownerId: "engineer" };
  const currentSnapshot = createEngineeringSnapshot({
    snapshotId: "candidate", binding: { scope, baselineSnapshotId: "baseline", baselineManifestHash: hash("a"), includedDecisions: [], requirementsHash: hash("b"), artifactManifestHash: hash("c"), toolchainHash: hash("d"), verificationPolicyHash: hash("e") },
    request: { id: "request", scope, text: "Evaluate the prepared assembly.", desiredOutcome: "A verified private candidate.", selectedReferences: [document], statements: [] },
    artifacts: [{ artifactId: "native", scope, kind: "native_cad", contentHash: hash("f"), document }],
  });
  const baseTarget: EngineeringPreparedTarget = { targetId: "diameter", revision: "target-v1", kind: "dimension", artifactId: "native", sourceHash: hash("f"), configurationId: "default", sourcePartVersionId: "version-a", sourceNativeVersion: "7", writable: true, optional: false, active: true, componentId: null, parentOccurrenceId: null, dimension: { unit: "mm", minimum: 2, maximum: 20 }, writeClosure: ["native-model"] };
  const mapping = { mappingId: "map-add", revision: "map-v1", scope, snapshotKey: currentSnapshot.canonicalKey, targetId: "slot", targetRevision: "target-v1", sourceHash: hash("f"), sourceComponentId: null, componentId: "component-a", componentHash: hash("1"), configurationId: "default", interfaceMapHash: hash("3"), state: "exact" as const };
  const context: EngineeringPreflightContext = {
    currentSnapshot,
    catalog: {
      scope, snapshotId: currentSnapshot.snapshotId, snapshotKey: currentSnapshot.canonicalKey, bindingKey: currentSnapshot.bindingKey, revision: "catalog-v1",
      capability: { id: "prepared-assembly", version: "1", operations: ["set_dimension", "add_component", "suppress_occurrence", "replace_occurrence", "review_dfm_dfa"], requiredChecks: ["rebuild", "geometry"], outputKinds: ["native_candidate"] },
      targets: [baseTarget, { ...baseTarget, targetId: "slot", kind: "occurrence", dimension: null, optional: true, active: false }, { ...baseTarget, targetId: "mount", kind: "occurrence", dimension: null, optional: true, componentId: "old-component" }, { ...baseTarget, targetId: "assembly", kind: "assembly", dimension: null }],
      components: [{ componentId: "component-a", contentHash: hash("1"), configurationId: "default", approved: true }, { componentId: "component-b", contentHash: hash("2"), configurationId: "default", approved: true }],
    },
    mappings: [mapping, { ...mapping, mappingId: "map-replace", targetId: "mount", sourceComponentId: "old-component" }, { ...mapping, mappingId: "map-after-add", sourceComponentId: "component-a", componentId: "component-b", componentHash: hash("2") }],
    rulepacks: [{ rulepackId: "manufacturing", version: "2", contentHash: hash("4"), scope, enabled: true, modes: ["dfm", "dfa"], requiredChecks: ["finding_provenance"] }],
    observed: {
      actorId: "engineer", observedAtMs: 1_000,
      workspace: { workspaceId: "private-a", branchId: "branch-a", ownerId: "engineer", private: true, snapshotKey: currentSnapshot.canonicalKey },
      lease: { leaseId: "lease-a", workspaceId: "private-a", branchId: "branch-a", ownerId: "engineer", fencingToken: 7, expiresAtMs: 10_000 },
      activeTasks: [],
      budget: { revision: "budget-v1", batchId: "batch-a", taskId: "task-a", alternativeIds: [], transientRetries: 0, retryClassification: "initial", plannerRevisions: 0, nativeElapsedSeconds: 0, costBearing: true, currency: "USD", ceiling: 10, accumulatedCost: 2, projectedCost: 3 },
    },
  };
  const envelope: EngineeringOperationEnvelope = {
    taskId: "task-a", batchId: "batch-a", alternativeId: "alternative-a", scope,
    snapshotId: currentSnapshot.snapshotId, snapshotKey: currentSnapshot.canonicalKey, bindingKey: currentSnapshot.bindingKey, catalogRevision: "catalog-v1", capabilityId: "prepared-assembly", capabilityVersion: "1",
    workspaceId: "private-a", branchId: "branch-a", leaseId: "lease-a", fencingToken: 7, budgetRevision: "budget-v1", nativeTaskSeconds: 600,
    operations: [{ operationId: "op-dimension", targetId: "diameter", targetRevision: "target-v1", kind: "set_dimension", value: 12, unit: "mm" }],
    expectedOutputs: [{ outputId: "private-native", kind: "native_candidate" }], requiredChecks: ["rebuild", "geometry"],
  };
  return JSON.parse(JSON.stringify({ envelope, context })) as Fixture;
}

function componentOperation(kind: "add_component" | "replace_occurrence", targetId = "slot", afterAdd = false): EngineeringOperation {
  let mappingId = "map-add";
  if (kind === "replace_occurrence") mappingId = "map-replace";
  if (afterAdd) mappingId = "map-after-add";
  return { operationId: `${kind}-${targetId}`, kind, targetId, targetRevision: "target-v1", componentId: afterAdd ? "component-b" : "component-a", componentHash: hash(afterAdd ? "2" : "1"), configurationId: "default", mappingId, mappingRevision: "map-v1", interfaceMapHash: hash("3") };
}
function reviewOperation(mode: "dfm" | "dfa"): EngineeringOperation {
  return { operationId: `review-${mode}`, kind: "review_dfm_dfa", targetId: "assembly", targetRevision: "target-v1", mode, rulepackId: "manufacturing", rulepackVersion: "2", rulepackHash: hash("4") };
}
function run(input: Fixture) { return preflightEngineeringTransaction(input.envelope, input.context); }
function denied(input: Fixture, reason: string) {
  const result = run(input);
  expect(result.eligible).toBe(false); expect(result.reasons.join(" ")).toContain(reason);
  expect(result).toMatchObject({ executionAuthorized: false, nativeValidated: false, replayKey: null });
}

describe("prepared ordered operations", () => {
  it("admits an in-range declared dimension without authorizing or claiming native execution", () => {
    const result = run(fixture());
    expect(result).toMatchObject({ eligible: true, reasons: [], executionAuthorized: false, nativeValidated: false, requiredChecks: ["geometry", "rebuild"], writeClosure: ["native-model"] });
    expect(result.recovery).toEqual({ quarantinePrivateOutputs: true, restartPinnedInput: true, unknownExternalEffectsRetryable: false, nativeBinaryMerge: false });
  });

  it("simulates addition, replacement and optional suppression in order", () => {
    const input = fixture();
    input.envelope.operations = [componentOperation("add_component"), componentOperation("replace_occurrence", "slot", true), { operationId: "suppress-added", kind: "suppress_occurrence", targetId: "slot", targetRevision: "target-v1" }];
    expect(run(input).eligible).toBe(true);
    input.envelope.operations.reverse();
    denied(input, "optional occurrences");
  });

  it("replaces an existing occurrence only with the pinned approved component and map", () => {
    const input = fixture(); input.envelope.operations = [componentOperation("replace_occurrence", "mount")];
    expect(run(input).eligible).toBe(true);
    input.context.catalog.components[0].approved = false; denied(input, "approved catalog");
  });

  it("does not treat suppression as deletion or free an occupied component slot", () => {
    const input = fixture();
    input.envelope.operations = [{ operationId: "suppress", kind: "suppress_occurrence", targetId: "mount", targetRevision: "target-v1" }, componentOperation("add_component", "mount")];
    denied(input, "unoccupied target");
  });

  it("invalidates child edits after their occurrence is suppressed", () => {
    const input = fixture(); input.context.catalog.targets[0].parentOccurrenceId = "mount";
    input.envelope.operations.unshift({ operationId: "suppress", kind: "suppress_occurrence", targetId: "mount", targetRevision: "target-v1" });
    denied(input, "parent occurrence is inactive");
  });

  it.each(["add_component", "replace_occurrence"] as const)("requires fresh descendant preparation after %s", (kind) => {
    const input = fixture(); const parentId = kind === "add_component" ? "slot" : "mount";
    input.context.catalog.targets[0].parentOccurrenceId = parentId;
    input.envelope.operations.unshift(componentOperation(kind, parentId));
    denied(input, "prepared descendant is stale");
  });

  it("rejects containment cycles and checks activity through every ancestor", () => {
    const input = fixture(); input.context.catalog.targets[1].parentOccurrenceId = "mount"; input.context.catalog.targets[2].parentOccurrenceId = "slot";
    denied(input, "cyclic prepared occurrence hierarchy");
    input.context.catalog.targets[2].parentOccurrenceId = null; input.context.catalog.targets[0].parentOccurrenceId = "slot";
    input.context.catalog.targets[1].active = true; input.context.catalog.targets[1].componentId = "component-a";
    input.context.catalog.targets[2].active = false; denied(input, "parent occurrence is inactive");
  });

  it.each(["dfm", "dfa"] as const)("requires the current %s rulepack and its complete check set", (mode) => {
    const input = fixture(); input.envelope.operations = [reviewOperation(mode)];
    denied(input, "required checks differ");
    input.envelope.requiredChecks.push("finding_provenance"); input.envelope.expectedOutputs = [{ outputId: "private-review", kind: "review_report" }];
    input.context.catalog.capability.outputKinds = ["review_report"];
    expect(run(input).eligible).toBe(true);
    input.context.rulepacks[0].version = "3"; denied(input, "stale review rulepack");
  });

  it("preserves sequential dimension changes in replay identity rather than sorting them", () => {
    const input = fixture();
    input.envelope.operations.push({ operationId: "later-dimension", kind: "set_dimension", targetId: "diameter", targetRevision: "target-v1", value: 14, unit: "mm" });
    const forward = run(input); input.envelope.operations.reverse(); const reverse = run(input);
    expect(forward.eligible && reverse.eligible).toBe(true);
    expect(forward.replayKey).not.toBe(reverse.replayKey);
    expect(JSON.parse(forward.replayKey!).envelope.operations.map((op: EngineeringOperation) => op.operationId)).toEqual(["op-dimension", "later-dimension"]);
  });

  it.each(["unit", "range", "writable"])("denies a dimension %s violation", (condition) => {
    const input = fixture();
    if (condition === "unit") input.envelope.operations = [{ ...input.envelope.operations[0], unit: "inch" } as EngineeringOperation];
    if (condition === "range") input.envelope.operations = [{ ...input.envelope.operations[0], value: 21 } as EngineeringOperation];
    if (condition === "writable") input.context.catalog.targets[0].writable = false;
    expect(run(input).eligible).toBe(false);
  });

  it("denies required-occurrence suppression and additions into occupied targets", () => {
    const input = fixture(); input.context.catalog.targets[2].optional = false;
    input.envelope.operations = [{ operationId: "suppress", kind: "suppress_occurrence", targetId: "mount", targetRevision: "target-v1" }];
    denied(input, "optional occurrences"); input.envelope.operations = [componentOperation("add_component", "mount")]; denied(input, "unoccupied");
  });
});

describe("independent source and capability contracts", () => {
  it.each(["scope", "snapshotId", "snapshotKey", "bindingKey", "catalogRevision", "capabilityId", "capabilityVersion"])("rejects a changed envelope %s pin", (field) => {
    const input = fixture();
    if (field === "scope") input.envelope.scope.organizationId = "other-org";
    else Reflect.set(input.envelope, field, "substituted");
    expect(run(input).eligible).toBe(false);
  });

  it.each(["sourceHash", "configurationId", "sourcePartVersionId", "sourceNativeVersion"])("rejects mismatched prepared source %s", (field) => {
    const input = fixture(); Reflect.set(input.context.catalog.targets[0], field, field === "sourceHash" ? hash("9") : "substituted"); denied(input, "source/configuration mismatch");
  });

  it("revalidates the actual snapshot rather than trusting a forged canonical key", () => {
    const input = fixture(); input.context.currentSnapshot.artifacts[0].contentHash = hash("9"); denied(input, "snapshot identity is inconsistent");
  });

  it.each(["calculation", "report"] as const)("cannot qualify a %s artifact as editable native CAD", (kind) => {
    const input = fixture(); const before = input.context.currentSnapshot;
    const next = createEngineeringSnapshot({ snapshotId: before.snapshotId, binding: before.binding, request: before.request, artifacts: [{ ...before.artifacts[0], kind }] });
    input.context.currentSnapshot = JSON.parse(JSON.stringify(next));
    input.context.catalog.snapshotKey = next.canonicalKey; input.envelope.snapshotKey = next.canonicalKey;
    input.context.observed.workspace.snapshotKey = next.canonicalKey;
    input.context.mappings.forEach((map) => { map.snapshotKey = next.canonicalKey; });
    denied(input, "prepared target source/configuration mismatch");
  });

  it("rejects a stale prepared catalog and cross-project rulepacks", () => {
    const input = fixture(); input.context.catalog.snapshotKey = "old"; denied(input, "prepared catalog");
    const other = fixture(); other.context.rulepacks[0].scope.projectId = "other-project"; denied(other, "cross-scope rulepack");
  });

  it.each(["state", "scope", "sourceHash", "sourceComponentId", "interfaceMapHash", "configurationId"])("rejects a mismatched or stale %s in the interface mapping", (field) => {
    const input = fixture(); input.envelope.operations = [componentOperation("add_component")];
    const map = input.context.mappings[0];
    if (field === "scope") map.scope.organizationId = "other-org";
    else if (field === "state") map.state = "ambiguous";
    else Reflect.set(map, field, field.endsWith("Hash") ? hash("9") : "other");
    expect(run(input).eligible).toBe(false);
  });

  it("cannot expand policy with extra operation fields or weaken frozen required checks", () => {
    const input = fixture(); Reflect.set(input.envelope.operations[0], "writable", true); denied(input, "unknown or missing contract field");
    const weakened = fixture(); weakened.envelope.requiredChecks = ["geometry"]; denied(weakened, "required checks differ");
    weakened.envelope.requiredChecks = []; denied(weakened, "required checks must be nonempty");
  });

  it("requires every independently prepared output kind, including execution evidence", () => {
    const input = fixture(); input.context.catalog.capability.outputKinds.push("execution_log");
    denied(input, "mandatory prepared output kind is missing");
    input.envelope.expectedOutputs.push({ outputId: "private-log", kind: "execution_log" });
    expect(run(input).eligible).toBe(true);
  });
});

describe("private workspace leases and physical conflicts", () => {
  it.each(["private", "owner", "expiry", "lease-owner", "fence", "branch"])("denies an invalid %s observation", (condition) => {
    const input = fixture();
    if (condition === "private") input.context.observed.workspace.private = false;
    if (condition === "owner") input.context.observed.workspace.ownerId = "other";
    if (condition === "expiry") input.context.observed.lease.expiresAtMs = input.context.observed.observedAtMs;
    if (condition === "lease-owner") input.context.observed.lease.ownerId = "other";
    if (condition === "fence") input.context.observed.lease.fencingToken = 6;
    if (condition === "branch") input.context.observed.lease.branchId = "wrong";
    expect(run(input).eligible).toBe(false);
  });

  it("detects shared physical writes across branch labels but permits detached alternative copies", () => {
    const input = fixture(); input.context.observed.activeTasks = [{ taskId: "another-task", workspaceId: "private-a", branchId: "different-label", writeClosure: ["native-model"] }];
    denied(input, "private workspace write closure");
    input.context.observed.activeTasks[0].workspaceId = "detached-alternative";
    expect(run(input).eligible).toBe(true);
    input.context.observed.activeTasks[0].taskId = "task-a"; denied(input, "task is already active");
  });

  it("serializes the same private native workspace even when declared closures look unrelated", () => {
    const input = fixture(); input.context.observed.activeTasks = [{ taskId: "another-task", workspaceId: "private-a", branchId: "branch-a", writeClosure: ["separate-private-document"] }];
    denied(input, "serialized private workspace");
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, "7"])("rejects non-positive or unsafe fence %j", (fencingToken) => {
    const input = fixture(); Reflect.set(input.envelope, "fencingToken", fencingToken); Reflect.set(input.context.observed.lease, "fencingToken", fencingToken);
    denied(input, "positive safe integer");
  });
});

describe("observed per-batch and per-task limits", () => {
  it("counts alternatives across the entire batch while a retry keeps the same alternative identity", () => {
    const input = fixture(); input.context.observed.budget.alternativeIds = ["alternative-b", "alternative-c"];
    expect(run(input).eligible).toBe(true);
    input.context.observed.budget.alternativeIds = ["alternative-a", "alternative-a"];
    denied(input, "duplicate batch alternative");
    input.context.observed.budget.alternativeIds = ["alternative-b", "alternative-c", "alternative-d"]; denied(input, "batch alternative limit");
    input.context.observed.budget.alternativeIds = ["alternative-a", "alternative-b", "alternative-c"];
    expect(run(input).eligible).toBe(true);
  });

  it("allows one classified transient retry within the original task time budget", () => {
    const input = fixture(); const budget = input.context.observed.budget;
    budget.transientRetries = 1; budget.retryClassification = "transient"; budget.nativeElapsedSeconds = 200; input.envelope.nativeTaskSeconds = 400;
    expect(run(input).eligible).toBe(true);
    input.envelope.nativeTaskSeconds = 401; denied(input, "600-second");
    input.envelope.nativeTaskSeconds = 400; budget.transientRetries = 2; denied(input, "retry limit");
  });

  it.each(["unknown_external_effect", "permanent", "initial"] as const)("never blindly retries a %s outcome", (classification) => {
    const input = fixture(); input.context.observed.budget.transientRetries = 1; input.context.observed.budget.retryClassification = classification; denied(input, "classified transient");
  });

  it("requires a current task budget and caps planner revisions", () => {
    const input = fixture(); input.context.observed.budget.plannerRevisions = 2; expect(run(input).eligible).toBe(true);
    input.context.observed.budget.plannerRevisions = 3; denied(input, "planner revision limit");
    input.context.observed.budget.plannerRevisions = 0; input.context.observed.budget.taskId = "another-task"; denied(input, "budget/task pin mismatch");
  });

  it("requires a configured ceiling for cost-bearing work and counts accumulated plus projected cost", () => {
    const input = fixture(); input.context.observed.budget.ceiling = null; denied(input, "explicit ceiling");
    input.context.observed.budget.ceiling = 5; expect(run(input).eligible).toBe(true);
    input.context.observed.budget.projectedCost = 3.01; denied(input, "spending ceiling");
    input.context.observed.budget.costBearing = false; denied(input, "mislabeled as free");
    input.context.observed.budget.accumulatedCost = 0; input.context.observed.budget.projectedCost = 0; input.context.observed.budget.ceiling = null;
    expect(run(input).eligible).toBe(true);
  });

  it.each([NaN, Infinity, -1])("denies malformed or negative accumulated/projected cost %s", (value) => {
    for (const field of ["accumulatedCost", "projectedCost", "ceiling"] as const) {
      const input = fixture(); input.context.observed.budget[field] = value; expect(run(input).eligible).toBe(false);
    }
  });

  it.each(["", "usd", "US", "USDD"])("rejects malformed currency %j", (currency) => {
    const input = fixture(); input.context.observed.budget.currency = currency; expect(run(input).eligible).toBe(false);
  });

  it("rejects arithmetic overflow when combining finite accumulated and projected costs", () => {
    const input = fixture(); const budget = input.context.observed.budget;
    budget.accumulatedCost = Number.MAX_VALUE; budget.projectedCost = Number.MAX_VALUE; budget.ceiling = Number.MAX_VALUE;
    denied(input, "batch spending ceiling exceeded");
  });
});

describe("strict immutable preflight", () => {
  it.each(["NaN", "digest", "operation", "duplicate", "unknown-field", "sparse", "empty-output"])("fails closed on %s input without mutation", (condition) => {
    const input = fixture();
    if (condition === "NaN") Reflect.set(input.envelope.operations[0], "value", NaN);
    if (condition === "digest") input.context.catalog.targets[0].sourceHash = "F".repeat(64);
    if (condition === "operation") Reflect.set(input.envelope.operations[0], "kind", "delete_everything");
    if (condition === "duplicate") input.envelope.operations.push(input.envelope.operations[0]);
    if (condition === "unknown-field") Reflect.set(input.envelope, "executionAuthorized", true);
    if (condition === "sparse") input.envelope.operations = new Array(1);
    if (condition === "empty-output") input.envelope.expectedOutputs = [];
    const before = JSON.stringify(input); expect(run(input).eligible).toBe(false); expect(JSON.stringify(input)).toBe(before);
  });

  it("returns immutable copied checks and outputs and stable object-key identity", () => {
    const input = fixture(); const before = JSON.stringify(input); const first = run(input);
    expect(first.eligible).toBe(true); expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.requiredChecks)).toBe(true); expect(Object.isFrozen(first.expectedOutputs[0])).toBe(true);
    expect(Reflect.set(first.expectedOutputs[0], "kind", "authoritative_release")).toBe(false);
    input.envelope.expectedOutputs[0].kind = "caller-edit"; expect(first.expectedOutputs[0].kind).toBe("native_candidate");
    const reordered = fixture(); reordered.envelope.operations[0] = { unit: "mm", value: 12, kind: "set_dimension", targetRevision: "target-v1", targetId: "diameter", operationId: "op-dimension" };
    expect(run(reordered).replayKey).toBe(first.replayKey);
  });
});
