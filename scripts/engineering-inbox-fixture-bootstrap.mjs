import { createHash } from "node:crypto";
import { types } from "node:util";
import { createEngineeringInboxFixtureLifecycle } from "./engineering-inbox-fixture-lifecycle.mjs";

const ADAPTER_KEYS = ["migration", "prerequisites", "suite"];
const PREREQUISITE_KEYS = ["completedAtMs", "databaseImage", "databaseReady", "databaseResourceId",
  "manifest", "manifestFingerprint", "migrationCount", "networkResourceId", "postgrestImage", "postgrestReady",
  "postgrestResourceId", "settled", "sourceRevision"];
const MIGRATION_KEYS = ["applied", "completedAtMs", "index", "path", "previousSha256", "settled", "sha256"];
const SUITE_KEYS = ["accessAssertions", "completedAtMs", "concurrentDuplicateSends", "conflictWinners",
  "conflictingSends", "databaseResourceId", "headPath", "headSha256", "outcome",
  "revokedWaitingSend", "settled", "suite"];
const APPLICATION_KEYS = ["completedAtMs", "settled", "succeeded"];
const SUITE_CONTRACT = Object.freeze({ suite: "test:engineering-inbox", accessAssertions: 34,
  concurrentDuplicateSends: 5, conflictingSends: 2, conflictWinners: 1, revokedWaitingSend: "denied" });
const TRUSTED_PROMISE = Promise;
const TRUSTED_PROMISE_PROTOTYPE = Promise.prototype;
const NATIVE_PROMISE_THEN = TRUSTED_PROMISE_PROTOTYPE.then;
const PROMISE_CONSTRUCTOR_DESCRIPTOR = Object.getOwnPropertyDescriptor(TRUSTED_PROMISE_PROTOTYPE, "constructor");
const PROMISE_SPECIES_DESCRIPTOR = Object.getOwnPropertyDescriptor(TRUSTED_PROMISE, Symbol.species);
const SNAPSHOT_LIMITS = Object.freeze({ array: 512, depth: 32, keys: 1024, nodes: 8192, string: 64 * 1024 });

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, keys) {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const actual = Reflect.ownKeys(value);
    if (actual.some((key) => typeof key !== "string")
      || actual.sort().join("\0") !== keys.join("\0")) return false;
    return actual.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor && descriptor.enumerable;
    });
  } catch {
    return false;
  }
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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeCall(action) {
  try {
    return { value: action() };
  } catch {
    return { failure: "adapter_error" };
  }
}

function sameDescriptor(value, expected) {
  if (!value || !expected) return value === expected;
  return value.configurable === expected.configurable && value.enumerable === expected.enumerable
    && value.get === expected.get && value.set === expected.set
    && value.value === expected.value && value.writable === expected.writable;
}

function consumeExactNativePromise(value) {
  try {
    if (types.isProxy(value) || !types.isPromise(value)
      || Object.getPrototypeOf(value) !== TRUSTED_PROMISE_PROTOTYPE
      || Object.getOwnPropertyDescriptor(value, "constructor")
      || !sameDescriptor(Object.getOwnPropertyDescriptor(TRUSTED_PROMISE_PROTOTYPE, "constructor"),
        PROMISE_CONSTRUCTOR_DESCRIPTOR)
      || !sameDescriptor(Object.getOwnPropertyDescriptor(TRUSTED_PROMISE, Symbol.species),
        PROMISE_SPECIES_DESCRIPTOR)) return false;
    Reflect.apply(NATIVE_PROMISE_THEN, value, [() => undefined, () => undefined]);
    return true;
  } catch {
    return false;
  }
}

function snapshotData(value, state = { nodes: 0, seen: new WeakSet() }, depth = 0) {
  try {
    if (value === null || typeof value === "boolean") return { value };
    if (typeof value === "string" && value.length <= SNAPSHOT_LIMITS.string) return { value };
    if (typeof value === "number" && Number.isSafeInteger(value)) return { value };
    if (!value || typeof value !== "object" || types.isProxy(value)
      || depth > SNAPSHOT_LIMITS.depth || state.seen.has(value)
      || ++state.nodes > SNAPSHOT_LIMITS.nodes) return null;
    state.seen.add(value);
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return null;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor?.value;
      if (!("value" in (lengthDescriptor ?? {})) || !Number.isSafeInteger(length)
        || length < 0 || length > SNAPSHOT_LIMITS.array || keys.length !== length + 1
        || keys.some((key) => typeof key !== "string") || !keys.includes("length")) return null;
      const output = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
        const child = snapshotData(descriptor.value, state, depth + 1);
        if (!child) return null;
        output.push(child.value);
      }
      return { value: output };
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || keys.length > SNAPSHOT_LIMITS.keys || keys.some((key) => typeof key !== "string")) return null;
    const output = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      const child = snapshotData(descriptor.value, state, depth + 1);
      if (!child) return null;
      Object.defineProperty(output, key, { value: child.value, enumerable: true, writable: true, configurable: true });
    }
    return { value: output };
  } catch {
    return null;
  }
}

function validateBootstrapAdapter(adapter) {
  if (!exactKeys(adapter, ADAPTER_KEYS) || ADAPTER_KEYS.some((key) => typeof adapter[key] !== "function")) {
    fail("invalid_bootstrap_adapter");
  }
}

function fingerprint(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function validResult(value, keys, earliest, deadline) {
  return exactKeys(value, keys) && value.settled === true
    && Number.isSafeInteger(value.completedAtMs)
    && value.completedAtMs >= earliest && value.completedAtMs <= deadline;
}

function observedCompletion(value, keys, earliest) {
  if (!exactKeys(value, keys)) return null;
  try {
    return Number.isSafeInteger(value.completedAtMs) && value.completedAtMs >= earliest
      ? value.completedAtMs : null;
  } catch {
    return null;
  }
}

/** Compose synthetic bootstrap stages inside the proven-owned lifecycle window. No runtime adapter is supplied. */
export function createEngineeringInboxFixtureBootstrap({ plan, lifecycleAdapter, bootstrapAdapter,
  application = null, signal = { aborted: false }, startTimeMs = 0 }) {
  validateBootstrapAdapter(bootstrapAdapter);
  if (application !== null && typeof application !== "function") fail("invalid_application_hook");
  let consumed = false;
  let state = null;

  const operation = (context) => {
    const manifest = plan.migrations.map(({ path, sha256 }, index) => ({ index, path, sha256 }));
    const network = context.resources.find(({ role }) => role === "network");
    const database = context.resources.find(({ role }) => role === "database");
    const postgrest = context.resources.find(({ role }) => role === "postgrest");
    let cursor = context.timing.startedAtMs;
    const deadline = context.timing.deadlineMs;
    state = { attempted: true, failure: null, stages: [], migrations: [], suite: null, completedAtMs: cursor };

    const finish = (failure, succeeded = false) => {
      state.failure = failure;
      state.completedAtMs = cursor;
      return { completedAtMs: cursor, settled: true, succeeded };
    };
    const invoke = (kind, keys, action) => {
      if (signal.aborted) return { failure: `${kind}_aborted` };
      const called = safeCall(action);
      if (called.failure) return { failure: `${kind}_${called.failure}` };
      consumeExactNativePromise(called.value);
      const snapshot = snapshotData(called.value);
      if (!snapshot) return { failure: `${kind}_unsettled_or_late` };
      const began = cursor;
      const observed = observedCompletion(snapshot.value, keys, began);
      if (observed !== null) cursor = observed;
      if (!validResult(snapshot.value, keys, began, deadline)) return { failure: `${kind}_unsettled_or_late` };
      return { value: snapshot.value };
    };

    const prerequisiteRequest = deepFreeze({
      sourceRevision: context.identity.sourceRevision,
      databaseImage: plan.images.database.id,
      postgrestImage: plan.images.postgrest.id,
      databaseResourceId: database?.id ?? null,
      networkResourceId: network?.id ?? null,
      postgrestResourceId: postgrest?.id ?? null,
      migrationCount: manifest.length,
      manifestFingerprint: fingerprint(manifest),
      manifest,
    });
    const prerequisite = invoke("prerequisites", PREREQUISITE_KEYS,
      () => bootstrapAdapter.prerequisites(prerequisiteRequest));
    if (prerequisite.failure) return finish(prerequisite.failure);
    const prerequisiteExpected = { ...prerequisiteRequest, databaseReady: true, postgrestReady: true };
    const prerequisiteData = { sourceRevision: prerequisite.value.sourceRevision,
      databaseImage: prerequisite.value.databaseImage, postgrestImage: prerequisite.value.postgrestImage,
      databaseResourceId: prerequisite.value.databaseResourceId,
      networkResourceId: prerequisite.value.networkResourceId,
      postgrestResourceId: prerequisite.value.postgrestResourceId,
      migrationCount: prerequisite.value.migrationCount,
      manifestFingerprint: prerequisite.value.manifestFingerprint, manifest: prerequisite.value.manifest,
      databaseReady: prerequisite.value.databaseReady, postgrestReady: prerequisite.value.postgrestReady };
    if (!sameData(prerequisiteData, prerequisiteExpected)) return finish("prerequisites_identity_mismatch");
    state.stages.push("prerequisites_passed");

    for (const entry of manifest) {
      const previousSha256 = entry.index === 0 ? null : manifest[entry.index - 1].sha256;
      const request = deepFreeze({ databaseResourceId: database.id, index: entry.index,
        count: manifest.length, path: entry.path, sha256: entry.sha256, previousSha256 });
      const migrated = invoke("migration", MIGRATION_KEYS, () => bootstrapAdapter.migration(request));
      if (migrated.failure) return finish(migrated.failure);
      if (migrated.value.applied !== true || migrated.value.index !== entry.index
        || migrated.value.path !== entry.path || migrated.value.sha256 !== entry.sha256
        || migrated.value.previousSha256 !== previousSha256) return finish("migration_identity_mismatch");
      state.migrations.push({ index: entry.index, path: entry.path, sha256: entry.sha256 });
      state.stages.push(`migration:${entry.index}`);
    }

    const head = manifest.at(-1);
    const suiteRequest = deepFreeze({ ...SUITE_CONTRACT, databaseResourceId: database.id,
      headPath: head.path, headSha256: head.sha256 });
    const suite = invoke("suite", SUITE_KEYS, () => bootstrapAdapter.suite(suiteRequest));
    if (suite.failure) return finish(suite.failure);
    const suiteData = { suite: suite.value.suite, accessAssertions: suite.value.accessAssertions,
      concurrentDuplicateSends: suite.value.concurrentDuplicateSends,
      conflictingSends: suite.value.conflictingSends, conflictWinners: suite.value.conflictWinners,
      revokedWaitingSend: suite.value.revokedWaitingSend,
      databaseResourceId: suite.value.databaseResourceId,
      headPath: suite.value.headPath, headSha256: suite.value.headSha256 };
    if (suite.value.outcome !== "passed" || !sameData(suiteData, suiteRequest)) return finish("suite_contract_mismatch");
    state.suite = { ...SUITE_CONTRACT, outcome: "passed", headPath: head.path, headSha256: head.sha256 };
    state.stages.push("suite_passed");
    if (application) {
      const applicationContext = deepFreeze({ identity: { ...context.identity },
        resources: context.resources.map((resource) => ({ ...resource })),
        manifestHead: { path: head.path, sha256: head.sha256 }, suite: { ...state.suite },
        timing: { startedAtMs: cursor, deadlineMs: deadline } });
      const applied = invoke("application", APPLICATION_KEYS, () => application(applicationContext));
      if (applied.failure) return finish(applied.failure);
      if (applied.value.succeeded !== true) return finish("application_failed");
      state.stages.push("application_passed");
    }
    return finish(null, true);
  };

  const lifecycle = createEngineeringInboxFixtureLifecycle({ plan, adapter: lifecycleAdapter,
    operation, signal, startTimeMs });
  return Object.freeze({
    run() {
      if (consumed) fail("bootstrap_already_consumed");
      consumed = true;
      const lifecycleReceipt = lifecycle.run();
      const bootstrapFailure = state?.failure ?? (state?.attempted ? null : "bootstrap_not_started");
      const passed = bootstrapFailure === null && state?.suite?.outcome === "passed"
        && lifecycleReceipt.status === "passed" && lifecycleReceipt.cleanupStatus === "cleanup_complete";
      return deepFreeze({
        schema: "overdrafter.engineering-inbox-fixture-bootstrap-receipt.v1",
        status: passed ? "passed" : "failed",
        qualification: "source_contract_only",
        identity: { ...lifecycleReceipt.identity },
        bootstrapFailure,
        lifecycleOperationFailure: lifecycleReceipt.operationFailure,
        cleanupStatus: lifecycleReceipt.cleanupStatus,
        cleanupFailures: lifecycleReceipt.cleanupFailures,
        migrations: state?.migrations ?? [],
        suite: state?.suite ?? null,
        stages: state?.stages ?? [],
        lifecycleStages: lifecycleReceipt.stages,
        timing: { startTimeMs, completedAtMs: lifecycleReceipt.timing.completedAtMs,
          deadlinesAreSimulated: true },
      });
    },
  });
}
