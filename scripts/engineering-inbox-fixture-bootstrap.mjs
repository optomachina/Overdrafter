import { createHash } from "node:crypto";
import { createEngineeringInboxFixtureLifecycle } from "./engineering-inbox-fixture-lifecycle.mjs";
import { consumeExactNativePromise, deepFreeze, exactKeys, safeCall, sameData,
  snapshotData } from "./engineering-inbox-fixture-boundary.mjs";

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

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
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
