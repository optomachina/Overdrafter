import { createEngineeringSnapshot, type EngineeringScope, type EngineeringSnapshot } from "./engineering-domain";

type TargetPin = Readonly<{ operationId: string; targetId: string; targetRevision: string }>;
type ComponentPin = Readonly<{ componentId: string; componentHash: string; configurationId: string; mappingId: string; mappingRevision: string; interfaceMapHash: string }>;
export type EngineeringOperation =
  | (TargetPin & Readonly<{ kind: "set_dimension"; value: number; unit: string }>)
  | (TargetPin & ComponentPin & Readonly<{ kind: "add_component" | "replace_occurrence" }>)
  | (TargetPin & Readonly<{ kind: "suppress_occurrence" }>)
  | (TargetPin & Readonly<{ kind: "review_dfm_dfa"; mode: "dfm" | "dfa"; rulepackId: string; rulepackVersion: string; rulepackHash: string }>);
export type EngineeringOperationKind = EngineeringOperation["kind"];
export type EngineeringExpectedOutput = Readonly<{ outputId: string; kind: string }>;
export type EngineeringOperationEnvelope = Readonly<{
  taskId: string; batchId: string; alternativeId: string; scope: EngineeringScope;
  snapshotId: string; snapshotKey: string; bindingKey: string; catalogRevision: string;
  capabilityId: string; capabilityVersion: string; workspaceId: string; branchId: string;
  leaseId: string; fencingToken: number; budgetRevision: string; nativeTaskSeconds: number;
  operations: readonly EngineeringOperation[]; expectedOutputs: readonly EngineeringExpectedOutput[]; requiredChecks: readonly string[];
}>;
export type EngineeringPreparedTarget = Readonly<{
  targetId: string; revision: string; kind: "dimension" | "occurrence" | "assembly";
  artifactId: string; sourceHash: string; configurationId: string; sourcePartVersionId: string | null; sourceNativeVersion: string | null;
  writable: boolean; optional: boolean; active: boolean; componentId: string | null; parentOccurrenceId: string | null;
  dimension: Readonly<{ unit: string; minimum: number; maximum: number }> | null;
  /** Prepared physical resource identities shared by every alias of a writable document. */
  writeClosure: readonly string[];
}>;
export type EngineeringPreparedCatalog = Readonly<{
  scope: EngineeringScope; snapshotId: string; snapshotKey: string; bindingKey: string; revision: string;
  /** Every prepared check and output kind is mandatory, not merely allowed. */
  capability: Readonly<{ id: string; version: string; operations: readonly EngineeringOperationKind[]; requiredChecks: readonly string[]; outputKinds: readonly string[] }>;
  targets: readonly EngineeringPreparedTarget[];
  components: readonly Readonly<{ componentId: string; contentHash: string; configurationId: string; approved: boolean }>[];
}>;
export type EngineeringInterfaceMapping = Readonly<{
  mappingId: string; revision: string; scope: EngineeringScope; snapshotKey: string;
  targetId: string; targetRevision: string; sourceHash: string; sourceComponentId: string | null;
  componentId: string; componentHash: string; configurationId: string; interfaceMapHash: string; state: "exact" | "stale" | "ambiguous";
}>;
export type EngineeringRulepack = Readonly<{
  rulepackId: string; version: string; contentHash: string; scope: EngineeringScope;
  enabled: boolean; modes: readonly ("dfm" | "dfa")[]; requiredChecks: readonly string[];
}>;
export type EngineeringExecutionObservation = Readonly<{
  actorId: string; observedAtMs: number;
  workspace: Readonly<{ workspaceId: string; branchId: string; ownerId: string; private: boolean; snapshotKey: string }>;
  lease: Readonly<{ leaseId: string; workspaceId: string; branchId: string; ownerId: string; fencingToken: number; expiresAtMs: number }>;
  activeTasks: readonly Readonly<{ taskId: string; workspaceId: string; branchId: string; writeClosure: readonly string[] }>[];
  budget: Readonly<{
    revision: string; batchId: string; taskId: string; alternativeIds: readonly string[];
    transientRetries: number; retryClassification: "initial" | "transient" | "unknown_external_effect" | "permanent";
    plannerRevisions: number; nativeElapsedSeconds: number; costBearing: boolean;
    currency: string; ceiling: number | null; accumulatedCost: number; projectedCost: number;
  }>;
}>;
export type EngineeringPreflightContext = Readonly<{
  currentSnapshot: EngineeringSnapshot; catalog: EngineeringPreparedCatalog;
  mappings: readonly EngineeringInterfaceMapping[]; rulepacks: readonly EngineeringRulepack[]; observed: EngineeringExecutionObservation;
}>;
export type EngineeringPreflightResult = Readonly<{
  eligible: boolean; reasons: readonly string[]; replayKey: string | null;
  executionAuthorized: false; nativeValidated: false; requiredChecks: readonly string[];
  expectedOutputs: readonly EngineeringExpectedOutput[]; writeClosure: readonly string[];
  recovery: Readonly<{ quarantinePrivateOutputs: true; restartPinnedInput: true; unknownExternalEffectsRetryable: false; nativeBinaryMerge: false }>;
}>;

type Parser = (value: unknown) => unknown;
const deny = (message: string): never => { throw new TypeError(message); };
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) deny(message); }
const string: Parser = (value) => { requireThat(typeof value === "string" && value.trim() && value === value.trim(), "malformed text or identifier"); return value; };
const number: Parser = (value) => { requireThat(typeof value === "number" && Number.isFinite(value), "malformed finite number"); return value; };
const fence: Parser = (value) => { requireThat(typeof value === "number" && Number.isSafeInteger(value) && value > 0, "fencing token must be a positive safe integer"); return value; };
const boolean: Parser = (value) => { requireThat(typeof value === "boolean", "malformed boolean"); return value; };
const digest: Parser = (value) => { requireThat(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "malformed lowercase SHA-256 digest"); return value; };
const nullable = (parse: Parser): Parser => (value) => {
  if (value === null) return null;
  return parse(value);
};
const oneOf = (...values: string[]): Parser => (value) => { requireThat(typeof value === "string" && values.includes(value), "unknown operation or contract value"); return value; };
const array = (parse: Parser): Parser => (value) => {
  requireThat(Array.isArray(value), "malformed array");
  for (let i = 0; i < value.length; i += 1) requireThat(Object.prototype.hasOwnProperty.call(value, i), "sparse array");
  return value.map(parse);
};
const object = (fields: Record<string, Parser>): Parser => (value) => {
  requireThat(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, "malformed contract object");
  const record = value as Record<string, unknown>;
  requireThat(Object.keys(record).length === Object.keys(fields).length && Object.keys(fields).every((key) => Object.prototype.hasOwnProperty.call(record, key)), "unknown or missing contract field");
  return Object.fromEntries(Object.entries(fields).map(([key, parse]) => [key, parse(record[key])]));
};
const scope = object({ organizationId: string, projectId: string });
const operationKinds = ["set_dimension", "add_component", "suppress_occurrence", "replace_occurrence", "review_dfm_dfa"];
const pin = { operationId: string, targetId: string, targetRevision: string };
const componentPin = { componentId: string, componentHash: digest, configurationId: string, mappingId: string, mappingRevision: string, interfaceMapHash: digest };
const operation: Parser = (value) => {
  requireThat(value && typeof value === "object", "malformed operation");
  const kind = (value as Record<string, unknown>).kind;
  const common = { ...pin, kind: oneOf(...operationKinds) };
  if (kind === "set_dimension") return object({ ...common, value: number, unit: string })(value);
  if (kind === "add_component" || kind === "replace_occurrence") return object({ ...common, ...componentPin })(value);
  if (kind === "suppress_occurrence") return object(common)(value);
  if (kind === "review_dfm_dfa") return object({ ...common, mode: oneOf("dfm", "dfa"), rulepackId: string, rulepackVersion: string, rulepackHash: digest })(value);
  return deny("unknown operation");
};
const output = object({ outputId: string, kind: string });
const envelopeParser = object({
  taskId: string, batchId: string, alternativeId: string, scope, snapshotId: string, snapshotKey: string, bindingKey: string, catalogRevision: string,
  capabilityId: string, capabilityVersion: string, workspaceId: string, branchId: string, leaseId: string, fencingToken: fence, budgetRevision: string, nativeTaskSeconds: number,
  operations: array(operation), expectedOutputs: array(output), requiredChecks: array(string),
});
const target = object({
  targetId: string, revision: string, kind: oneOf("dimension", "occurrence", "assembly"), artifactId: string, sourceHash: digest, configurationId: string,
  sourcePartVersionId: nullable(string), sourceNativeVersion: nullable(string), writable: boolean, optional: boolean, active: boolean, componentId: nullable(string), parentOccurrenceId: nullable(string),
  dimension: nullable(object({ unit: string, minimum: number, maximum: number })), writeClosure: array(string),
});
const catalogParser = object({
  scope, snapshotId: string, snapshotKey: string, bindingKey: string, revision: string,
  capability: object({ id: string, version: string, operations: array(oneOf(...operationKinds)), requiredChecks: array(string), outputKinds: array(string) }),
  targets: array(target), components: array(object({ componentId: string, contentHash: digest, configurationId: string, approved: boolean })),
});
const mappingParser = object({
  mappingId: string, revision: string, scope, snapshotKey: string, targetId: string, targetRevision: string, sourceHash: digest, sourceComponentId: nullable(string),
  componentId: string, componentHash: digest, configurationId: string, interfaceMapHash: digest, state: oneOf("exact", "stale", "ambiguous"),
});
const rulepackParser = object({ rulepackId: string, version: string, contentHash: digest, scope, enabled: boolean, modes: array(oneOf("dfm", "dfa")), requiredChecks: array(string) });
const observationParser = object({
  actorId: string, observedAtMs: number,
  workspace: object({ workspaceId: string, branchId: string, ownerId: string, private: boolean, snapshotKey: string }),
  lease: object({ leaseId: string, workspaceId: string, branchId: string, ownerId: string, fencingToken: fence, expiresAtMs: number }),
  activeTasks: array(object({ taskId: string, workspaceId: string, branchId: string, writeClosure: array(string) })),
  budget: object({
    revision: string, batchId: string, taskId: string, alternativeIds: array(string), transientRetries: number,
    retryClassification: oneOf("initial", "transient", "unknown_external_effect", "permanent"), plannerRevisions: number, nativeElapsedSeconds: number,
    costBearing: boolean, currency: string, ceiling: nullable(number), accumulatedCost: number, projectedCost: number,
  }),
});

function compare(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!); const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) { if (left[i] !== right[i]) return left[i] - right[i]; }
  return left.length - right.length;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",");
    return `{${fields}}`;
  }
  return JSON.stringify(value);
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function unique<T>(items: readonly T[], key: (item: T) => string, name: string): void { requireThat(new Set(items.map(key)).size === items.length, `duplicate ${name}`); }
function sameScope(a: EngineeringScope, b: EngineeringScope): boolean { return a.organizationId === b.organizationId && a.projectId === b.projectId; }
function nonemptySet(values: readonly string[], name: string): void { requireThat(values.length > 0, `${name} must be nonempty`); unique(values, (value) => value, name); }

function validateContext(input: EngineeringPreflightContext): EngineeringPreflightContext {
  const parsed = object({ currentSnapshot: (value) => value, catalog: catalogParser, mappings: array(mappingParser), rulepacks: array(rulepackParser), observed: observationParser })(input) as EngineeringPreflightContext;
  const raw = object({ schema: oneOf("engineering-snapshot.v1"), snapshotId: string, binding: (value) => value, request: (value) => value, artifacts: (value) => value, bindingKey: string, canonicalKey: string })(parsed.currentSnapshot) as EngineeringSnapshot;
  const snapshot = createEngineeringSnapshot({ snapshotId: raw.snapshotId, binding: raw.binding, request: raw.request, artifacts: raw.artifacts });
  requireThat(raw.canonicalKey === snapshot.canonicalKey && raw.bindingKey === snapshot.bindingKey, "current snapshot identity is inconsistent");
  return { ...parsed, currentSnapshot: snapshot };
}

function validatePreparedTarget(item: EngineeringPreparedTarget, snapshot: EngineeringSnapshot, targets: readonly EngineeringPreparedTarget[]): void {
  const source = snapshot.artifacts.find((artifact) => artifact.artifactId === item.artifactId);
  requireThat(source?.kind === "native_cad" && source.contentHash === item.sourceHash && source.document.configurationId === item.configurationId && source.document.partVersionId === item.sourcePartVersionId && source.document.nativeVersion === item.sourceNativeVersion, "prepared target source/configuration mismatch");
  nonemptySet(item.writeClosure, "prepared write closure");
  requireThat((item.kind === "dimension") === (item.dimension !== null), "prepared dimension contract mismatch");
  if (item.dimension) requireThat(item.dimension.minimum <= item.dimension.maximum, "invalid prepared dimension range");
  if (item.kind !== "occurrence") requireThat(item.componentId === null && !item.optional, "invalid non-occurrence occupancy");
  if (item.kind === "occurrence" && item.active) requireThat(item.componentId !== null, "active occurrence has no component");
  if (item.parentOccurrenceId !== null) requireThat(targets.some((parent) => parent.targetId === item.parentOccurrenceId && parent.kind === "occurrence" && parent.targetId !== item.targetId), "missing parent occurrence");
}

function validateContainment(targets: readonly EngineeringPreparedTarget[]): void {
  for (const item of targets) {
    const seen = new Set([item.targetId]); let parentId = item.parentOccurrenceId;
    while (parentId) {
      requireThat(!seen.has(parentId), "cyclic prepared occurrence hierarchy"); seen.add(parentId);
      parentId = targets.find((parent) => parent.targetId === parentId)!.parentOccurrenceId;
    }
  }
}

function validatePrepared(context: EngineeringPreflightContext): void {
  const { catalog, currentSnapshot: snapshot, mappings, rulepacks } = context;
  requireThat(sameScope(catalog.scope, snapshot.binding.scope) && catalog.snapshotId === snapshot.snapshotId && catalog.snapshotKey === snapshot.canonicalKey && catalog.bindingKey === snapshot.bindingKey, "stale or cross-scope prepared catalog");
  unique(catalog.targets, (item) => item.targetId, "prepared target"); unique(catalog.components, (item) => item.componentId, "component");
  unique(mappings, (item) => item.mappingId, "mapping"); unique(rulepacks, (item) => item.rulepackId, "rulepack");
  nonemptySet(catalog.capability.requiredChecks, "prepared checks"); nonemptySet(catalog.capability.operations, "capabilities"); nonemptySet(catalog.capability.outputKinds, "output kinds");
  for (const target of catalog.targets) validatePreparedTarget(target, snapshot, catalog.targets);
  validateContainment(catalog.targets);
  for (const item of mappings) requireThat(sameScope(item.scope, catalog.scope) && item.snapshotKey === snapshot.canonicalKey, "stale or cross-scope mapping contract");
  for (const item of rulepacks) { requireThat(sameScope(item.scope, catalog.scope), "cross-scope rulepack"); nonemptySet(item.requiredChecks, "rulepack checks"); nonemptySet(item.modes, "rulepack modes"); }
}

function validateBudget(envelope: EngineeringOperationEnvelope, budget: EngineeringExecutionObservation["budget"]): void {
  requireThat(budget.revision === envelope.budgetRevision && budget.batchId === envelope.batchId && budget.taskId === envelope.taskId, "budget/task pin mismatch");
  unique(budget.alternativeIds, (id) => id, "batch alternative");
  requireThat(new Set([...budget.alternativeIds, envelope.alternativeId]).size <= 3, "batch alternative limit exceeded");
  requireThat(Number.isInteger(budget.transientRetries) && budget.transientRetries >= 0 && budget.transientRetries <= 1, "task retry limit exceeded");
  requireThat((budget.transientRetries === 0 && budget.retryClassification === "initial") || (budget.transientRetries === 1 && budget.retryClassification === "transient"), "retry requires a classified transient failure; unknown external effects are not retryable");
  requireThat(Number.isInteger(budget.plannerRevisions) && budget.plannerRevisions >= 0 && budget.plannerRevisions <= 2, "planner revision limit exceeded");
  requireThat(envelope.nativeTaskSeconds > 0 && envelope.nativeTaskSeconds <= 600 && budget.nativeElapsedSeconds >= 0 && budget.nativeElapsedSeconds + envelope.nativeTaskSeconds <= 600, "native task exceeds the 600-second budget");
  requireThat(/^[A-Z]{3}$/.test(budget.currency) && budget.accumulatedCost >= 0 && budget.projectedCost >= 0 && (budget.ceiling === null || budget.ceiling >= 0), "invalid budget currency or negative cost");
  requireThat(budget.costBearing || (budget.accumulatedCost === 0 && budget.projectedCost === 0), "cost-bearing task mislabeled as free");
  requireThat(!budget.costBearing || budget.ceiling !== null, "cost-bearing batch requires an explicit ceiling");
  if (budget.ceiling !== null) requireThat(Number.isFinite(budget.accumulatedCost + budget.projectedCost) && budget.accumulatedCost + budget.projectedCost <= budget.ceiling, "batch spending ceiling exceeded");
}

function validateExecution(envelope: EngineeringOperationEnvelope, observed: EngineeringExecutionObservation): void {
  const { workspace, lease, budget } = observed;
  requireThat(observed.observedAtMs >= 0 && workspace.private && workspace.ownerId === observed.actorId, "workspace must be private and owned by the actor");
  requireThat(workspace.workspaceId === envelope.workspaceId && workspace.branchId === envelope.branchId && workspace.snapshotKey === envelope.snapshotKey, "workspace pin mismatch");
  requireThat(lease.workspaceId === workspace.workspaceId && lease.branchId === workspace.branchId && lease.ownerId === observed.actorId && lease.leaseId === envelope.leaseId && lease.fencingToken === envelope.fencingToken && lease.expiresAtMs > observed.observedAtMs, "invalid, expired or wrong-owner lease");
  validateBudget(envelope, budget);
  unique(observed.activeTasks, (item) => item.taskId, "active task");
  for (const item of observed.activeTasks) nonemptySet(item.writeClosure, "active write closure");
  requireThat(!observed.activeTasks.some((task) => task.taskId === envelope.taskId), "task is already active");
}

type MutableTarget = { -readonly [K in keyof EngineeringPreparedTarget]: EngineeringPreparedTarget[K] };
type ComponentOperation = Extract<EngineeringOperation, { kind: "add_component" | "replace_occurrence" }>;

function currentTarget(operation: EngineeringOperation, states: Map<string, MutableTarget>, invalidated: Set<string>): MutableTarget {
  const target = states.get(operation.targetId);
  requireThat(target?.revision === operation.targetRevision, "missing or stale prepared target");
  requireThat(!invalidated.has(target.targetId), "prepared descendant is stale after a parent component change");
  let parentId = target.parentOccurrenceId;
  while (parentId) {
    const parent = states.get(parentId)!; requireThat(parent.active, "parent occurrence is inactive"); parentId = parent.parentOccurrenceId;
  }
  return target;
}

function simulateDimension(operation: Extract<EngineeringOperation, { kind: "set_dimension" }>, target: MutableTarget): void {
  requireThat(target.kind === "dimension" && target.active && target.writable && target.dimension, "dimension is unavailable or not writable");
  requireThat(operation.unit === target.dimension.unit && operation.value >= target.dimension.minimum && operation.value <= target.dimension.maximum, "dimension unit/range mismatch");
}

function simulateSuppression(target: MutableTarget): void {
  requireThat(target.kind === "occurrence" && target.active && target.optional && target.writable, "only writable active optional occurrences may be suppressed");
  target.active = false;
}

function simulateReview(operation: Extract<EngineeringOperation, { kind: "review_dfm_dfa" }>, target: MutableTarget, context: EngineeringPreflightContext, checks: Set<string>): void {
  requireThat(target.active, "review target is inactive");
  const rulepack = context.rulepacks.find((item) => item.rulepackId === operation.rulepackId);
  requireThat(rulepack && rulepack.enabled && rulepack.version === operation.rulepackVersion && rulepack.contentHash === operation.rulepackHash && rulepack.modes.includes(operation.mode), "missing or stale review rulepack");
  rulepack.requiredChecks.forEach((check) => checks.add(check));
}

function validateMapping(operation: ComponentOperation, target: MutableTarget, context: EngineeringPreflightContext): void {
  const map = context.mappings.find((item) => item.mappingId === operation.mappingId);
  requireThat(map && map.state === "exact" && map.revision === operation.mappingRevision && map.interfaceMapHash === operation.interfaceMapHash, "stale or mismatched interface mapping");
  requireThat(map.targetId === target.targetId && map.targetRevision === target.revision && map.sourceHash === target.sourceHash && map.sourceComponentId === target.componentId, "stale or mismatched interface mapping");
  requireThat(map.componentId === operation.componentId && map.componentHash === operation.componentHash && map.configurationId === operation.configurationId, "stale or mismatched interface mapping");
}

function simulateComponent(operation: ComponentOperation, target: MutableTarget, context: EngineeringPreflightContext): void {
  requireThat(target.kind === "occurrence" && target.writable, "component operation needs a writable occurrence target");
  if (operation.kind === "add_component") requireThat(!target.active && target.componentId === null, "component addition requires an unoccupied target");
  else requireThat(target.active && target.componentId !== null, "replacement requires an active occupied target");
  const component = context.catalog.components.find((item) => item.componentId === operation.componentId);
  requireThat(component?.approved && component.contentHash === operation.componentHash && component.configurationId === operation.configurationId, "component hash/configuration is not in the approved catalog");
  validateMapping(operation, target, context); target.componentId = component.componentId; target.active = true;
}

function invalidateDescendants(parent: string, states: Map<string, MutableTarget>, invalidated: Set<string>): void {
  for (const target of states.values()) {
    let ancestor = target.parentOccurrenceId;
    while (ancestor) {
      if (ancestor === parent) { invalidated.add(target.targetId); break; }
      ancestor = states.get(ancestor)!.parentOccurrenceId;
    }
  }
}

function simulate(envelope: EngineeringOperationEnvelope, context: EngineeringPreflightContext): { checks: string[]; closure: string[] } {
  const states = new Map(context.catalog.targets.map((target) => [target.targetId, { ...target }]));
  const invalidated = new Set<string>(); const checks = new Set(context.catalog.capability.requiredChecks); const closure = new Set<string>();
  for (const operation of envelope.operations) {
    requireThat(context.catalog.capability.operations.includes(operation.kind), "operation outside prepared capability");
    const target = currentTarget(operation, states, invalidated);
    switch (operation.kind) {
      case "set_dimension": simulateDimension(operation, target); break;
      case "suppress_occurrence": simulateSuppression(target); break;
      case "review_dfm_dfa": simulateReview(operation, target, context, checks); break;
      case "add_component":
      case "replace_occurrence":
        simulateComponent(operation, target, context); invalidateDescendants(target.targetId, states, invalidated); break;
    }
    target.writeClosure.forEach((path) => closure.add(path));
  }
  return { checks: [...checks].sort(compare), closure: [...closure].sort(compare) };
}

/**
 * Checks an ordered, pinned proposal against separately supplied prepared and
 * observed contracts. Eligibility is neither security authority nor native proof.
 * This function never mutates inputs, writes files, spends money or invokes CAD.
 */
export function preflightEngineeringTransaction(value: EngineeringOperationEnvelope, input: EngineeringPreflightContext): EngineeringPreflightResult {
  const base = { executionAuthorized: false as const, nativeValidated: false as const, recovery: { quarantinePrivateOutputs: true as const, restartPinnedInput: true as const, unknownExternalEffectsRetryable: false as const, nativeBinaryMerge: false as const } };
  try {
    const envelope = envelopeParser(value) as EngineeringOperationEnvelope;
    const context = validateContext(input); validatePrepared(context);
    const { currentSnapshot: snapshot, catalog } = context;
    requireThat(sameScope(envelope.scope, snapshot.binding.scope) && envelope.snapshotId === snapshot.snapshotId && envelope.snapshotKey === snapshot.canonicalKey && envelope.bindingKey === snapshot.bindingKey, "snapshot/binding/scope pin mismatch");
    requireThat(envelope.catalogRevision === catalog.revision && envelope.capabilityId === catalog.capability.id && envelope.capabilityVersion === catalog.capability.version, "prepared capability/version mismatch");
    requireThat(envelope.operations.length > 0 && envelope.expectedOutputs.length > 0, "operations and outputs must be nonempty");
    unique(envelope.operations, (item) => item.operationId, "operation"); unique(envelope.expectedOutputs, (item) => item.outputId, "output"); nonemptySet(envelope.requiredChecks, "required checks");
    for (const item of envelope.expectedOutputs) requireThat(catalog.capability.outputKinds.includes(item.kind), "unexpected output kind");
    for (const kind of catalog.capability.outputKinds) requireThat(envelope.expectedOutputs.some((item) => item.kind === kind), "mandatory prepared output kind is missing");
    validateExecution(envelope, context.observed);
    const simulation = simulate(envelope, context);
    requireThat(canonical([...envelope.requiredChecks].sort(compare)) === canonical(simulation.checks), "required checks differ from the prepared policy");
    for (const task of context.observed.activeTasks) requireThat(task.workspaceId !== envelope.workspaceId, "active task conflicts with the serialized private workspace write closure");
    const replayKey = canonical({ schema: "engineering-replay.v1", envelope, catalog: context.catalog, mappings: context.mappings, rulepacks: context.rulepacks });
    return freeze({ ...base, eligible: true, reasons: [], replayKey, requiredChecks: simulation.checks, expectedOutputs: envelope.expectedOutputs, writeClosure: simulation.closure });
  } catch (error) {
    return freeze({ ...base, eligible: false, reasons: [error instanceof Error ? error.message : "invalid preflight contract"], replayKey: null, requiredChecks: [], expectedOutputs: [], writeClosure: [] });
  }
}
