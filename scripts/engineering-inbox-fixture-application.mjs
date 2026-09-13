import { types } from "node:util";
import { createEngineeringInboxFixtureBootstrap } from "./engineering-inbox-fixture-bootstrap.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MANIFEST_KEYS = ["body", "conversationId", "expectedMessageId", "expectedRequestId", "expectedRevision",
  "idempotencyKey", "inputSnapshotId", "organizationId", "projectId"];
const TRANSPORT_KEYS = ["readiness", "request"];
const RESULT_KEYS = ["body", "completedAtMs", "settled", "status"];
const RECEIPT_KEYS = ["conversationId", "inputSnapshotId", "messageId", "requestId", "revision"];
const READY_KEYS = ["databaseResourceId", "postgrestResourceId", "ready", "sourceRevision"];
const TRUSTED_PROMISE = Promise;
const TRUSTED_PROTOTYPE = Promise.prototype;
const NATIVE_THEN = TRUSTED_PROTOTYPE.then;
const CONSTRUCTOR_DESCRIPTOR = Object.getOwnPropertyDescriptor(TRUSTED_PROTOTYPE, "constructor");
const SPECIES_DESCRIPTOR = Object.getOwnPropertyDescriptor(TRUSTED_PROMISE, Symbol.species);
const LIMITS = Object.freeze({ array: 512, depth: 32, keys: 1024, nodes: 8192, string: 64 * 1024 });

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function exactKeys(value, keys) {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const actual = Reflect.ownKeys(value);
    if (actual.some((key) => typeof key !== "string") || actual.sort().join("\0") !== keys.join("\0")) return false;
    return actual.every((key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor && descriptor.enumerable; });
  } catch { return false; }
}
function sameDescriptor(value, expected) {
  return Boolean(value && expected) && value.configurable === expected.configurable
    && value.enumerable === expected.enumerable && value.get === expected.get && value.set === expected.set
    && value.value === expected.value && value.writable === expected.writable;
}
function consumeExactPromise(value) {
  try {
    if (types.isProxy(value) || !types.isPromise(value) || Object.getPrototypeOf(value) !== TRUSTED_PROTOTYPE
      || Object.getOwnPropertyDescriptor(value, "constructor")
      || !sameDescriptor(Object.getOwnPropertyDescriptor(TRUSTED_PROTOTYPE, "constructor"), CONSTRUCTOR_DESCRIPTOR)
      || !sameDescriptor(Object.getOwnPropertyDescriptor(TRUSTED_PROMISE, Symbol.species), SPECIES_DESCRIPTOR)) return;
    Reflect.apply(NATIVE_THEN, value, [() => undefined, () => undefined]);
  } catch { /* Exotic executable values remain outside the host-event containment guarantee. */ }
}
function snapshot(value, state = { nodes: 0, seen: new WeakSet() }, depth = 0) {
  try {
    if (value === null || typeof value === "boolean") return { value };
    if (typeof value === "string" && value.length <= LIMITS.string) return { value };
    if (typeof value === "number" && Number.isSafeInteger(value)) return { value };
    if (!value || typeof value !== "object" || types.isProxy(value) || depth > LIMITS.depth
      || state.seen.has(value) || ++state.nodes > LIMITS.nodes) return null;
    state.seen.add(value);
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return null;
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > LIMITS.array || keys.length !== length + 1
        || keys.some((key) => typeof key !== "string") || !keys.includes("length")) return null;
      const output = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
        const child = snapshot(descriptor.value, state, depth + 1);
        if (!child) return null;
        output.push(child.value);
      }
      return { value: output };
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || keys.length > LIMITS.keys
      || keys.some((key) => typeof key !== "string")) return null;
    const output = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      const child = snapshot(descriptor.value, state, depth + 1);
      if (!child) return null;
      Object.defineProperty(output, key, { value: child.value, enumerable: true, writable: true, configurable: true });
    }
    return { value: output };
  } catch { return null; }
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function validBody(body) {
  if (typeof body !== "string" || !body.trim() || body.includes("\0")) return false;
  const characters = Array.from(body);
  return characters.length <= 4000 && new TextEncoder().encode(body).length <= 8000
    && !characters.some((character) => character.length === 1 && /[\uD800-\uDFFF]/.test(character));
}
function validateManifest(manifest) {
  const copied = snapshot(manifest);
  if (!copied || !exactKeys(copied.value, MANIFEST_KEYS)) fail("invalid_application_manifest");
  manifest = copied.value;
  const identities = [manifest.organizationId, manifest.projectId, manifest.conversationId,
    manifest.inputSnapshotId, manifest.idempotencyKey, manifest.expectedMessageId, manifest.expectedRequestId];
  if (identities.some((value) => typeof value !== "string" || !UUID.test(value)
    || value === "00000000-0000-0000-0000-000000000000") || new Set(identities).size !== 7
    || !Number.isSafeInteger(manifest.expectedRevision) || manifest.expectedRevision < 0
    || manifest.expectedRevision >= Number.MAX_SAFE_INTEGER || !validBody(manifest.body)) fail("invalid_application_manifest");
  return deepFreeze(manifest);
}
function validateTransport(transport) {
  if (!exactKeys(transport, TRANSPORT_KEYS) || TRANSPORT_KEYS.some((key) => typeof transport[key] !== "function")) {
    fail("invalid_application_transport");
  }
}
function safeCall(action) { try { return { value: action() }; } catch { return { failure: true }; } }

/** Source-only HTTP-like composition over a closed fake transport. */
export function createEngineeringInboxFixtureApplication({ plan, lifecycleAdapter, bootstrapAdapter,
  transport, manifest, signal = { aborted: false }, startTimeMs = 0 }) {
  manifest = validateManifest(manifest);
  validateTransport(transport);
  let consumed = false;
  let state = null;
  const application = (context) => {
    let cursor = context.timing.startedAtMs;
    const deadline = context.timing.deadlineMs;
    state = { failure: null, readinessStatus: "not_run", applicationStatus: "not_run", stages: [] };
    const finish = (failure, succeeded = false) => {
      state.failure = failure;
      return { completedAtMs: cursor, settled: true, succeeded };
    };
    const invoke = (kind, action) => {
      if (signal.aborted) return { failure: `${kind}_aborted` };
      const called = safeCall(action);
      if (called.failure) return { failure: `${kind}_adapter_error` };
      consumeExactPromise(called.value);
      const copied = snapshot(called.value);
      if (!copied || !exactKeys(copied.value, RESULT_KEYS)) return { failure: `${kind}_unsettled_or_late` };
      const result = copied.value;
      const began = cursor;
      if (Number.isSafeInteger(result.completedAtMs) && result.completedAtMs >= began) cursor = result.completedAtMs;
      if (result.settled !== true || !Number.isSafeInteger(result.completedAtMs)
        || result.completedAtMs < began || result.completedAtMs > deadline) {
        return { failure: `${kind}_unsettled_or_late` };
      }
      return { value: result };
    };
    const database = context.resources.find(({ role }) => role === "database");
    const postgrest = context.resources.find(({ role }) => role === "postgrest");
    const readinessRequest = deepFreeze({ kind: "postgrest_readiness",
      sourceRevision: context.identity.sourceRevision, databaseResourceId: database.id,
      postgrestResourceId: postgrest.id });
    const ready = invoke("readiness", () => transport.readiness(readinessRequest));
    if (ready.failure) return finish(ready.failure);
    const readyBody = ready.value.body;
    if (ready.value.status !== 200 || !exactKeys(readyBody, READY_KEYS) || readyBody.ready !== true
      || readyBody.sourceRevision !== readinessRequest.sourceRevision
      || readyBody.databaseResourceId !== readinessRequest.databaseResourceId
      || readyBody.postgrestResourceId !== readinessRequest.postgrestResourceId) return finish("readiness_mismatch");
    state.readinessStatus = "passed";
    state.stages.push("readiness_passed");
    const request = deepFreeze({ kind: "engineering_inbox_rpc", method: "POST",
      path: "/rest/v1/rpc/api_submit_engineering_message", body: {
        p_organization_id: manifest.organizationId, p_project_id: manifest.projectId,
        p_conversation_id: manifest.conversationId, p_input_snapshot_id: manifest.inputSnapshotId,
        p_expected_revision: manifest.expectedRevision, p_idempotency_key: manifest.idempotencyKey,
        p_body: manifest.body } });
    state.applicationStatus = "delivery_unknown";
    const submitted = invoke("application", () => transport.request(request));
    if (submitted.failure) return finish(submitted.failure);
    const receipt = submitted.value.body;
    if (submitted.value.status !== 200 || !exactKeys(receipt, RECEIPT_KEYS)
      || receipt.conversationId !== manifest.conversationId || receipt.inputSnapshotId !== manifest.inputSnapshotId
      || receipt.messageId !== manifest.expectedMessageId || receipt.requestId !== manifest.expectedRequestId
      || receipt.revision !== manifest.expectedRevision + 1) return finish("application_delivery_unknown");
    state.applicationStatus = "recorded";
    state.stages.push("application_recorded");
    return finish(null, true);
  };
  const bootstrap = createEngineeringInboxFixtureBootstrap({ plan, lifecycleAdapter, bootstrapAdapter,
    application, signal, startTimeMs });
  return Object.freeze({ run() {
    if (consumed) fail("application_already_consumed");
    consumed = true;
    const receipt = bootstrap.run();
    const applicationFailure = state ? state.failure : "application_not_started";
    const passed = applicationFailure === null && state.applicationStatus === "recorded"
      && receipt.status === "passed" && receipt.cleanupStatus === "cleanup_complete";
    return deepFreeze({ schema: "overdrafter.engineering-inbox-fixture-application-receipt.v1",
      status: passed ? "passed" : "failed", qualification: "source_contract_only",
      readinessStatus: state?.readinessStatus ?? "not_run",
      applicationStatus: state?.applicationStatus ?? "not_run", applicationFailure,
      bootstrapFailure: receipt.bootstrapFailure, lifecycleOperationFailure: receipt.lifecycleOperationFailure,
      cleanupStatus: receipt.cleanupStatus,
      cleanupFailureFamilies: receipt.cleanupFailures.map(({ family }) => family),
      stages: state?.stages ?? [], timing: { ...receipt.timing } });
  } });
}
