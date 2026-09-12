import { createEngineeringInboxFixturePlan, ENGINEERING_INBOX_FIXTURE_PLAN_SCHEMA } from "./engineering-inbox-fixture-plan.mjs";

const ID = /^[0-9a-f]{64}$/;
const ADAPTER_KEYS = ["create", "inspect", "inventory", "remove"];
const RESULT_KEYS = {
  inventory: ["completedAtMs", "resources", "settled"],
  create: ["completedAtMs", "id", "settled"],
  inspect: ["completedAtMs", "resource", "settled"],
  remove: ["completedAtMs", "removed", "settled"],
};
const RESOURCE_KEYS = ["caps", "id", "labels", "name", "type"];
const LABEL_KEYS = ["contract", "ownerTaskId", "role", "runId", "sourceRevision"];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, keys) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")
      || ownKeys.sort().join("\0") !== keys.join("\0")) return false;
    return ownKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor && descriptor.enumerable;
    });
  } catch {
    return false;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isDeepFrozen(value) {
  return !value || typeof value !== "object"
    || Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

function sameData(value, expected, seen = new WeakSet()) {
  try {
    if (Object.is(value, expected)) return true;
    if (!value || !expected || typeof value !== "object" || typeof expected !== "object"
      || Object.getPrototypeOf(value) !== Object.getPrototypeOf(expected) || seen.has(value)) return false;
    seen.add(value);
    const actualKeys = Reflect.ownKeys(value);
    const expectedKeys = Reflect.ownKeys(expected);
    if (actualKeys.length !== expectedKeys.length
      || expectedKeys.some((key) => !actualKeys.includes(key))) return false;
    return expectedKeys.every((key) => {
      const actual = Object.getOwnPropertyDescriptor(value, key);
      const wanted = Object.getOwnPropertyDescriptor(expected, key);
      return actual && wanted && "value" in actual && "value" in wanted
        && sameData(actual.value, wanted.value, seen);
    });
  } catch {
    return false;
  }
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

function safeCall(action) {
  try {
    return { value: action() };
  } catch {
    return { failure: "adapter_error" };
  }
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
export function createEngineeringInboxFixtureLifecycle({ plan, adapter, signal = { aborted: false }, startTimeMs = 0 }) {
  plan = validatePlan(plan);
  validateAdapter(adapter);
  if (!Number.isSafeInteger(startTimeMs) || startTimeMs < 0
    || !signal || typeof signal !== "object" || !("aborted" in signal)) fail("invalid_lifecycle_options");
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
        const began = cursor;
        const observed = observedCompletion(called.value, kind, began);
        if (observed !== null) cursor = observed;
        const checked = result(called.value, kind, began, deadline);
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
        const began = cursor;
        const observed = createdCall.failure ? null : observedCompletion(createdCall.value, "create", began);
        if (observed !== null) cursor = observed;
        const created = createdCall.failure ? null : result(createdCall.value, "create", began, operationDeadline);
        if (!created) {
          possibleCreated.push({ role: spec.labels.role, id: possibleResultId(createdCall.value) });
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
