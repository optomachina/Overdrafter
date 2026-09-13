import { createEngineeringInboxFixturePlan, ENGINEERING_INBOX_FIXTURE_PLAN_SCHEMA } from "./engineering-inbox-fixture-plan.mjs";
import { consumeExactNativePromise, deepFreeze, exactKeys, safeCall, sameData,
  snapshotData } from "./engineering-inbox-fixture-boundary.mjs";

const ID = /^[0-9a-f]{64}$/;
const ADAPTER_KEYS = ["create", "inspect", "inventory", "remove"];
const RESULT_KEYS = {
  inventory: ["completedAtMs", "resources", "settled"],
  create: ["completedAtMs", "id", "settled"],
  inspect: ["completedAtMs", "resource", "settled"],
  operation: ["completedAtMs", "settled", "succeeded"],
  remove: ["completedAtMs", "removed", "settled"],
};
const RESOURCE_KEYS = ["caps", "id", "labels", "name", "type"];
const LABEL_KEYS = ["contract", "ownerTaskId", "role", "runId", "sourceRevision"];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isDeepFrozen(value) {
  return !value || typeof value !== "object"
    || Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

function validatePlan(plan) {
  let canonical;
  try {
    if (!isDeepFrozen(plan) || plan?.schema !== ENGINEERING_INBOX_FIXTURE_PLAN_SCHEMA
      || plan.mode !== "plan_only" || plan.qualification !== "not_run") fail("invalid_plan");
    canonical = createEngineeringInboxFixturePlan({
      sourceRevision: plan.identity?.sourceRevision,
      ownerTaskId: plan.identity?.ownerTaskId,
      runId: plan.identity?.runId,
      databaseImage: plan.images?.database?.id,
      postgrestImage: plan.images?.postgrest?.id,
      migrations: plan.migrations?.map(({ path, sha256 }) => ({ path, sha256 })),
    });
  } catch {
    fail("invalid_plan");
  }
  if (!sameData(plan, canonical)
    || plan.resourcePolicy.maxContainers !== 2 || plan.resourcePolicy.maxNetworks !== 1
    || plan.resourcePolicy.runnerDeadlineMs !== 1_800_000
    || plan.resourcePolicy.cleanupDeadlineMs !== 300_000) fail("invalid_plan");
  return canonical;
}

function validateAdapter(adapter) {
  if (!exactKeys(adapter, ADAPTER_KEYS) || ADAPTER_KEYS.some((key) => typeof adapter[key] !== "function")) {
    fail("invalid_adapter");
  }
}

function labels(plan, role) {
  return { contract: plan.schema, ownerTaskId: plan.identity.ownerTaskId, role,
    runId: plan.identity.runId, sourceRevision: plan.identity.sourceRevision };
}

function specs(plan) {
  const prefix = `ovd496-${plan.identity.runId}`;
  return [
    { type: "network", name: `${prefix}-network`, labels: labels(plan, "network"), caps: {
      network: plan.resourcePolicy.network, portPublication: plan.resourcePolicy.portPublication } },
    { type: "container", name: `${prefix}-database`, labels: labels(plan, "database"),
      caps: plan.resourcePolicy.containers.database },
    { type: "container", name: `${prefix}-postgrest`, labels: labels(plan, "postgrest"),
      caps: plan.resourcePolicy.containers.postgrest },
  ];
}

function validTime(value, earliest, deadline) {
  return Number.isSafeInteger(value) && value >= earliest && value <= deadline;
}

function validResource(resource) {
  return exactKeys(resource, RESOURCE_KEYS) && typeof resource.id === "string" && ID.test(resource.id)
    && ["network", "container"].includes(resource.type) && typeof resource.name === "string"
    && exactKeys(resource.labels, LABEL_KEYS) && resource.caps && typeof resource.caps === "object"
    && !Array.isArray(resource.caps);
}

function sameResource(resource, expected, id) {
  return validResource(resource) && typeof id === "string" && resource.id === id && resource.type === expected.type
    && resource.name === expected.name && sameData(resource.labels, expected.labels)
    && sameData(resource.caps, expected.caps);
}

function result(value, kind, earliest, deadline) {
  if (!exactKeys(value, RESULT_KEYS[kind]) || value.settled !== true
    || !validTime(value.completedAtMs, earliest, deadline)) return null;
  return value;
}

function observedCompletion(value, kind, earliest) {
  if (!exactKeys(value, RESULT_KEYS[kind])) return null;
  try {
    return Number.isSafeInteger(value.completedAtMs) && value.completedAtMs >= earliest
      ? value.completedAtMs : null;
  } catch {
    return null;
  }
}

function validatedId(value) {
  try {
    return typeof value === "string" && ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

function possibleResultId(value) {
  try {
    if (!value || typeof value !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "id");
    return descriptor && "value" in descriptor ? validatedId(descriptor.value) : null;
  } catch {
    return null;
  }
}

/** Pure lifecycle orchestration over an injected adapter. No runtime adapter is supplied here. */
export function createEngineeringInboxFixtureLifecycle({ plan, adapter, operation = null,
  signal = { aborted: false }, startTimeMs = 0 }) {
  plan = validatePlan(plan);
  validateAdapter(adapter);
  if (!Number.isSafeInteger(startTimeMs) || startTimeMs < 0
    || !signal || typeof signal !== "object" || !("aborted" in signal)
    || operation !== null && typeof operation !== "function") fail("invalid_lifecycle_options");
  let consumed = false;
  return Object.freeze({
    run() {
      if (consumed) fail("lifecycle_already_consumed");
      consumed = true;
      const expected = specs(plan);
      const calls = [];
      const stages = [];
      const owned = [];
      const possibleCreated = [];
      const cleanupFailures = [];
      let operationFailure = null;
      let cursor = startTimeMs;
      const operationDeadline = startTimeMs + plan.resourcePolicy.runnerDeadlineMs;

      const invoke = (kind, action, deadline = operationDeadline, respectAbort = true) => {
        if (respectAbort && signal.aborted) return { failure: "aborted" };
        calls.push(kind);
        const called = safeCall(action);
        if (called.failure) return called;
        consumeExactNativePromise(called.value);
        const snapshot = snapshotData(called.value);
        if (!snapshot) return { failure: "unsettled_or_late" };
        const began = cursor;
        const observed = observedCompletion(snapshot.value, kind, began);
        if (observed !== null) cursor = observed;
        const checked = result(snapshot.value, kind, began, deadline);
        if (!checked) return { failure: "unsettled_or_late" };
        return { value: checked };
      };

      const inventory = invoke("inventory", () => adapter.inventory());
      if (inventory.failure) operationFailure = `inventory_${inventory.failure}`;
      else if (!Array.isArray(inventory.value.resources)
        || safeCall(() => inventory.value.resources.every(validResource)).value !== true) {
        operationFailure = "inventory_invalid";
      } else if (safeCall(() => inventory.value.resources.some((entry) => expected.some((item) => item.name === entry.name)
        || entry.labels.runId === plan.identity.runId)).value !== false) operationFailure = "inventory_collision";
      else stages.push("inventory_clear");

      for (const spec of expected) {
        if (operationFailure) break;
        if (signal.aborted) { operationFailure = "create_aborted"; break; }
        const createdCall = safeCall(() => { calls.push(`create:${spec.labels.role}`); return adapter.create(deepFreeze(structuredClone(spec))); });
        if (!createdCall.failure) consumeExactNativePromise(createdCall.value);
        const createdSnapshot = createdCall.failure ? null : snapshotData(createdCall.value);
        const began = cursor;
        const observed = createdSnapshot ? observedCompletion(createdSnapshot.value, "create", began) : null;
        if (observed !== null) cursor = observed;
        const created = createdSnapshot ? result(createdSnapshot.value, "create", began, operationDeadline) : null;
        if (!created) {
          possibleCreated.push({ role: spec.labels.role, id: possibleResultId(createdSnapshot?.value) });
          operationFailure = createdCall.failure ? "create_adapter_error" : "create_unsettled_or_late";
          break;
        }
        const createdId = validatedId(created.id);
        if (!createdId || owned.some((entry) => entry.id === createdId)) {
          possibleCreated.push({ role: spec.labels.role, id: createdId });
          operationFailure = "create_ambiguous_identity";
          break;
        }
        const inspected = invoke("inspect", () => adapter.inspect(createdId));
        if (inspected.failure || !sameResource(inspected.value.resource, spec, createdId)) {
          possibleCreated.push({ role: spec.labels.role, id: createdId });
          operationFailure = inspected.failure ? `post_create_inspect_${inspected.failure}` : "post_create_identity_mismatch";
          break;
        }
        owned.push({ id: createdId, spec });
        stages.push(`owned:${spec.labels.role}`);
      }

      if (!operationFailure && operation) {
        const operationContext = deepFreeze({
          identity: { ...plan.identity },
          resources: owned.map(({ id, spec }) => ({ id, type: spec.type, role: spec.labels.role })),
          timing: { startedAtMs: cursor, deadlineMs: operationDeadline },
        });
        const operated = invoke("operation", () => operation(operationContext));
        if (operated.failure) operationFailure = `operation_${operated.failure}`;
        else if (operated.value.succeeded !== true) operationFailure = "operation_failed";
        else stages.push("operation_passed");
      }

      const provisional = { status: "provisional", operationFailure, acceptedResourceCount: owned.length,
        possibleCreatedCount: possibleCreated.length };
      const cleanupStart = cursor;
      const cleanupDeadline = cleanupStart + plan.resourcePolicy.cleanupDeadlineMs;
      for (const entry of [...owned].reverse()) {
        const inspected = invoke("inspect", () => adapter.inspect(entry.id), cleanupDeadline, false);
        if (inspected.failure || !sameResource(inspected.value.resource, entry.spec, entry.id)) {
          cleanupFailures.push({ id: entry.id, family: inspected.failure ? `cleanup_inspect_${inspected.failure}` : "cleanup_identity_drift" });
          continue;
        }
        const removed = invoke("remove", () => adapter.remove(entry.id), cleanupDeadline, false);
        if (removed.failure || removed.value.removed !== true) {
          cleanupFailures.push({ id: entry.id, family: removed.failure ? `cleanup_remove_${removed.failure}` : "cleanup_remove_failed" });
          continue;
        }
        const absent = invoke("inspect", () => adapter.inspect(entry.id), cleanupDeadline, false);
        if (absent.failure || absent.value.resource !== null) {
          cleanupFailures.push({ id: entry.id, family: absent.failure ? `cleanup_verify_${absent.failure}` : "cleanup_residue" });
        } else stages.push(`removed:${entry.spec.labels.role}`);
      }
      if (signal.aborted && !operationFailure) operationFailure = "aborted";
      const cleanupComplete = possibleCreated.length === 0 && cleanupFailures.length === 0
        && owned.every((entry) => stages.includes(`removed:${entry.spec.labels.role}`));
      const status = !operationFailure && cleanupComplete ? "passed" : "failed";
      return deepFreeze({
        schema: "overdrafter.engineering-inbox-fixture-lifecycle-receipt.v1",
        status,
        qualification: "source_contract_only",
        identity: { ...plan.identity },
        operationFailure,
        cleanupStatus: cleanupComplete ? "cleanup_complete" : "cleanup_unproved",
        cleanupFailures,
        possibleCreated,
        resources: owned.map(({ id, spec }) => ({ id, type: spec.type, role: spec.labels.role })),
        stages,
        callCount: calls.length,
        provisional,
        timing: { startTimeMs, completedAtMs: cursor, deadlinesAreSimulated: true },
      });
    },
  });
}
