import { Buffer } from "node:buffer";
import { qualifyPreparation, prepareAcquisitionData } from "./ovd419-acquisition-preparation.mjs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ACQUISITION_IDENTITIES,
  ACQUISITION_LIMITS,
  validateContainmentCompatibility,
} from "./ovd419-acquisition-compatibility.mjs";
import { validateSyntheticCompletedExecution } from "./ovd419-acquisition-execution.mjs";
import { validateSyntheticAcquisitionInventory } from "./ovd419-acquisition-inventory.mjs";
import { validateSyntheticFullJob } from "./ovd419-acquisition-job.mjs";
import {
  validateSyntheticPrincipal,
  validateSyntheticSecretVersionMetadata,
  validateSyntheticSnapshotMetadata,
} from "./ovd419-acquisition-metadata.mjs";
import { validateSyntheticFullService } from "./ovd419-acquisition-service.mjs";
import { parseBoundedSqlJson } from "./ovd419-acquisition-support/official-sql-wrapper.mjs";
import { SYNTHETIC_CATALOGUE_CONTRACT } from "./ovd419-synthetic-catalogue-reader.mjs";
import {
  createSyntheticAcquisitionPrefix,
  SYNTHETIC_PREFIX_CONTRACT,
} from "./ovd419-synthetic-acquisition-prefix.mjs";
import { digest, TARGET } from "./ovd419-job-diagnostic.mjs";
import { OVD410_PRODUCTION_CONTRACT } from "./xometry-stable-egress-contract.mjs";

export const SYNTHETIC_ACQUISITION_READER_CONTRACT = Object.freeze({
  requestSchema: "OVD419-SYNTHETIC-ACQUISITION-REQUEST-v1",
  responseSchema: "OVD419-SYNTHETIC-ACQUISITION-RESPONSE-v1",
  handoffSchema: "OVD419-SYNTHETIC-ACQUISITION-OPAQUE-HANDOFF-v1",
  minimumCalls: 37,
  maximumCalls: ACQUISITION_LIMITS.maximumTotalCalls,
  perReadMs: ACQUISITION_LIMITS.perReadMs,
  totalDurationMs: ACQUISITION_LIMITS.totalDurationMs,
});

const PRIVATE_HANDOFFS = new WeakMap();
const PRIVATE_PREPARATIONS = new WeakMap();
const CLAIMED_SCOPES = new WeakSet();
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const fail = code => { throw new Error(code); };
const NAT_ARGS = Object.freeze([
  "compute", "routers", "get-nat-mapping-info", OVD410_PRODUCTION_CONTRACT.router,
  "--nat-name", OVD410_PRODUCTION_CONTRACT.nat, "--project", TARGET.project,
  "--region", TARGET.region, "--format=json(instanceName)",
]);

function exactObject(value, required, optional = [], code = "invalid_acquisition_options") {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      !required.every(key => Object.hasOwn(value, key)) ||
      !Object.keys(value).every(key => required.includes(key) || optional.includes(key))) fail(code);
}

function freezeJson(value) {
  if (Array.isArray(value)) {
    value.forEach(freezeJson);
  } else if (value && Object.getPrototypeOf(value) === Object.prototype) {
    Object.values(value).forEach(freezeJson);
  }
  return Object.freeze(value);
}

function validateOptions(options) {
  exactObject(options,
    ["transport", "qualification", "packet", "projectNumber", "snapshotScope", "secretReference"],
    ["perReadMs", "totalDurationMs", "clock", "preparation"]);
  if (typeof options.transport !== "function") fail("acquisition_transport_required");
  exactObject(options.qualification,
    ["mode", "acquisitionSourceCommit", "inputManifestSha256", "invocationId"]);
  if (options.qualification.mode !== "TEST_ONLY" ||
      !/^[0-9a-f]{40}$/.test(options.qualification.acquisitionSourceCommit) ||
      !/^[0-9a-f]{64}$/.test(options.qualification.inputManifestSha256) ||
      !/^TEST_ONLY_[A-Za-z0-9_-]{1,80}$/.test(options.qualification.invocationId)) {
    fail("invalid_acquisition_qualification");
  }
  if (!options.packet || typeof options.packet !== "object" || Array.isArray(options.packet) ||
      Object.getPrototypeOf(options.packet) !== Object.prototype) fail("invalid_acquisition_packet");
  if (!/^[1-9]\d{0,19}$/.test(options.projectNumber)) fail("invalid_acquisition_project_number");
  exactObject(options.snapshotScope, ["bucket", "object", "maxBytes"]);
  if (typeof options.snapshotScope.bucket !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/.test(options.snapshotScope.bucket) ||
      typeof options.snapshotScope.object !== "string" || options.snapshotScope.object.length === 0 ||
      options.snapshotScope.object.length > 1024 || /[\r\n\0]/.test(options.snapshotScope.object) ||
      typeof options.snapshotScope.maxBytes !== "string" || !/^[1-9]\d{0,9}$/.test(options.snapshotScope.maxBytes)) {
    fail("invalid_acquisition_snapshot_scope");
  }
  exactObject(options.secretReference, ["name", "key"]);
  if (options.secretReference.name !== "supabase-service-role-key" ||
      !(options.secretReference.key === "latest" || /^[1-9]\d{0,18}$/.test(options.secretReference.key))) {
    fail("invalid_acquisition_secret_reference");
  }
  if (!Number.isSafeInteger(options.perReadMs) || options.perReadMs < 1 ||
      options.perReadMs > SYNTHETIC_ACQUISITION_READER_CONTRACT.perReadMs ||
      !Number.isSafeInteger(options.totalDurationMs) || options.totalDurationMs < 1 ||
      options.totalDurationMs > SYNTHETIC_ACQUISITION_READER_CONTRACT.totalDurationMs) {
    fail("invalid_acquisition_limits");
  }
  exactObject(options.clock, ["now"]);
  if (typeof options.clock.now !== "function") fail("invalid_acquisition_clock");
}

function requestEnvelope(id, sequence, requestSha256, provenance, args) {
  return Object.freeze({
    schema: SYNTHETIC_ACQUISITION_READER_CONTRACT.requestSchema,
    mode: "TEST_ONLY",
    id,
    sequence,
    requestSha256,
    provenance,
    args: args === null ? null : Object.freeze([...args]),
  });
}

function validateResponse(raw, request, maximumPayloadBytes) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > ACQUISITION_LIMITS.aggregateTransportBytes) {
    fail("invalid_acquisition_response");
  }
  let response;
  try { response = parseBoundedSqlJson(raw, ACQUISITION_LIMITS.aggregateTransportBytes); }
  catch { fail("invalid_acquisition_response"); }
  if (JSON.stringify(response) !== raw) fail("invalid_acquisition_response");
  exactObject(response,
    ["schema", "mode", "id", "sequence", "requestSha256", "provenance", "complete", "settled", "isError", "payload"],
    [], "invalid_acquisition_response");
  exactObject(response.provenance, Object.keys(request.provenance), [], "acquisition_provenance_mismatch");
  if (response.schema !== SYNTHETIC_ACQUISITION_READER_CONTRACT.responseSchema ||
      response.mode !== "TEST_ONLY" || response.id !== request.id ||
      response.sequence !== request.sequence || response.requestSha256 !== request.requestSha256 ||
      !Object.keys(request.provenance).every(key => response.provenance[key] === request.provenance[key]) ||
      response.complete !== true || response.settled !== true || response.isError !== false ||
      typeof response.payload !== "string" ||
      Buffer.byteLength(response.payload, "utf8") > maximumPayloadBytes) {
    fail("invalid_acquisition_response");
  }
  return { payload: response.payload, responseBytes: Buffer.byteLength(raw, "utf8") };
}

function assertStable(first, second, code) {
  if (first.sha256 !== second.sha256) fail(code);
}

function validateResourceAgreement({ job, service, inventory, execution }, snapshotScope, secretReference) {
  const j = job.projection;
  const s = service.projection;
  const e = execution.projection;
  if (j.latestCompletedExecution.name !== inventory.selected.name ||
      j.identity.uid !== e.ownerJob.uid || j.image !== s.image || j.image !== e.image ||
      JSON.stringify(j.snapshotScope) !== JSON.stringify(s.snapshotScope) ||
      JSON.stringify(j.snapshotScope) !== JSON.stringify(e.snapshotScope) ||
      JSON.stringify(j.snapshotScope) !== JSON.stringify(snapshotScope) ||
      JSON.stringify(j.resources) !== JSON.stringify(e.resources) ||
      j.taskFingerprint !== e.taskFingerprint ||
      JSON.stringify(s.secretReference) !== JSON.stringify(secretReference)) {
    fail("acquisition_resource_agreement_rejected");
  }
}

/** Membership only: callers must not interpret this as freshness or readiness. */
export function isSyntheticAcquisitionPreparation(value) {
  return value !== null && typeof value === "object" && PRIVATE_PREPARATIONS.has(value);
}

/** Return whether a handle is still available; this is not a freshness check. */
export function isSyntheticAcquisitionHandoff(value) {
  return value !== null && typeof value === "object" && PRIVATE_HANDOFFS.has(value);
}

/**
 * Compose the reviewed synthetic prefix and pure resource interpreters into the
 * complete finite offline acquisition. The injected transport is the only I/O
 * seam; no default transport, credential discovery, writer or runtime entrypoint
 * exists. Accepted raw bytes remain only in a module-private weak handoff.
 */
export function createSyntheticAcquisitionReader(input = {}) {
  exactObject(input,
    ["transport", "qualification", "packet", "projectNumber", "snapshotScope", "secretReference"],
    ["perReadMs", "totalDurationMs", "clock", "preparation"]);
  const options = {
    transport: input.transport,
    qualification: freezeJson(structuredClone(input.qualification)),
    packet: freezeJson(structuredClone(input.packet)),
    projectNumber: input.projectNumber,
    snapshotScope: freezeJson(structuredClone(input.snapshotScope)),
    secretReference: freezeJson(structuredClone(input.secretReference)),
    perReadMs: input.perReadMs ?? SYNTHETIC_ACQUISITION_READER_CONTRACT.perReadMs,
    totalDurationMs: input.totalDurationMs ?? SYNTHETIC_ACQUISITION_READER_CONTRACT.totalDurationMs,
    clock: input.clock ?? Object.freeze({ now: performance.now.bind(performance) }),
  };
  validateOptions(options);
  // Retain the original callable and receiver through reading and preparation;
  // replacing the caller's clock method must not restart elapsed-time checks.
  const clockNow = options.clock.now.bind(options.clock);
  const qualified = input.preparation === undefined ? null
    : qualifyPreparation(input.preparation, options.qualification, options.packet);
  if (qualified) {
    if (CLAIMED_SCOPES.has(qualified.scope)) fail("acquisition_fixture_rejected");
    CLAIMED_SCOPES.add(qualified.scope);
  }
  const owner = Object.freeze({});
  let consumed = false;

  return Object.freeze({
    /** Claim this reader's handle once and retain exact private output bytes in
     * memory. No filesystem API or public raw-data unwrap is provided. */
    prepare(handle, scope) {
      const retained = PRIVATE_HANDOFFS.get(handle);
      if (retained?.owner !== owner) {
        fail("acquisition_fixture_rejected");
      }
      // Claim before validation: failures consume the attempt, and there is no
      // await/reentrancy window in which a second preparation can be admitted.
      PRIVATE_HANDOFFS.delete(handle);
      try {
        if (!qualified || scope !== qualified.scope) fail("acquisition_fixture_rejected");
        const checkTime = () => {
          const now = retained.current();
          if (now >= retained.deadline || now - retained.closingObservedAt > 30000) {
            fail("acquisition_fixture_rejected");
          }
          return now;
        };
        checkTime();
        const capturedMs = qualified.epochMs + Math.floor(retained.closingObservedAt - retained.started);
        if (!Number.isSafeInteger(capturedMs)) fail("acquisition_fixture_rejected");
        const capturedAt = new Date(capturedMs).toISOString();
        const data = prepareAcquisitionData(retained, { qualified, packet: options.packet, capturedAt }, handle);
        checkTime();
        const result = Object.freeze({ schema: "OVD419-SYNTHETIC-PREPARED-FIXTURE-NOT-AUTHORITY-v1",
          mode: "TEST_ONLY", bindingsSha256: data.bindingsSha256, bindingsBytes: data.bindingsBytes,
          receiptSha256: data.receiptSha256, receiptBytes: data.receiptBytes,
          transportQualified: false, privateBindingReady: false });
        PRIVATE_PREPARATIONS.set(result, Object.freeze({ data, owner, qualified, current: retained.current,
          deadline: retained.deadline, closingObservedAt: retained.closingObservedAt }));
        return result;
      } catch { fail("acquisition_fixture_rejected"); }
    },
    async read() {
      if (consumed) fail("acquisition_request_budget_exhausted");
      consumed = true;
      const started = clockNow();
      if (!Number.isFinite(started) || started < 0) fail("invalid_acquisition_clock");
      let previousNow = started;
      let sequence = 0;
      let receivedBytes = 0;
      let cloudCalls = 0;
      let sqlCalls = 0;
      const sequenceById = new Map();

      const current = () => {
        const value = clockNow();
        if (!Number.isFinite(value) || value < previousNow) fail("invalid_acquisition_clock");
        previousNow = value;
        return value;
      };

      const dispatch = async ({ id, requestSha256, provenance, args, maximumPayloadBytes, kind,
        interpret = payload => payload }) => {
        const before = current();
        const remaining = options.totalDurationMs - (before - started);
        if (remaining <= 0) fail("acquisition_total_timeout");
        const request = requestEnvelope(id, sequence, requestSha256, provenance, args);
        sequenceById.set(id, sequence);
        sequence += 1;
        if (sequence > ACQUISITION_LIMITS.maximumTotalCalls) fail("acquisition_call_budget_exhausted");
        if (kind === "sql") sqlCalls += 1;
        else cloudCalls += 1;
        if (sqlCalls > ACQUISITION_LIMITS.maximumSqlCalls || cloudCalls > ACQUISITION_LIMITS.maximumCloudCommands) {
          fail("acquisition_call_budget_exhausted");
        }
        const controller = new AbortController();
        const timeoutMs = Math.min(options.perReadMs, remaining);
        let timer;
        try {
          const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("acquisition_read_timeout"));
            }, timeoutMs);
          });
          const maximumResponseBytes = Math.min(
            ACQUISITION_LIMITS.aggregateTransportBytes - receivedBytes,
            maximumPayloadBytes + ACQUISITION_LIMITS.sqlWrapperAllowanceBytes,
          );
          const operation = Promise.resolve().then(() => options.transport(request, Object.freeze({
            signal: controller.signal,
            maxBytes: maximumResponseBytes,
          }))).catch(() => fail("acquisition_transport_failed"));
          const raw = await Promise.race([operation, deadline]);
          if (current() - before >= timeoutMs) fail("acquisition_read_timeout");
          const response = validateResponse(raw, request, maximumPayloadBytes);
          if (response.responseBytes > maximumResponseBytes) fail("invalid_acquisition_response");
          receivedBytes += response.responseBytes;
          if (receivedBytes > ACQUISITION_LIMITS.aggregateTransportBytes) {
            fail("acquisition_aggregate_byte_limit");
          }
          const interpreted = interpret(response.payload);
          if (current() - before >= timeoutMs) fail("acquisition_read_timeout");
          if (current() - started >= options.totalDurationMs) fail("acquisition_total_timeout");
          return interpreted;
        } catch (error) {
          controller.abort();
          throw error;
        } finally {
          clearTimeout(timer);
        }
      };

      let prefixProvenance;
      const prefixReader = createSyntheticAcquisitionPrefix({
        qualification: options.qualification,
        perReadMs: options.perReadMs,
        totalDurationMs: options.totalDurationMs,
        transport: async (innerRequest, context) => {
          if (innerRequest.sequence !== sequence) fail("acquisition_sequence_mismatch");
          const payload = await dispatch({
            id: innerRequest.id,
            requestSha256: innerRequest.requestSha256,
            provenance: innerRequest.provenance,
            args: innerRequest.args ?? null,
            maximumPayloadBytes: context.maxBytes,
            kind: innerRequest.id === "catalogue" || innerRequest.id === "containmentOpening" ? "sql" : "cloud",
          });
          prefixProvenance ??= innerRequest.provenance;
          const schema = innerRequest.id === "catalogue"
            ? SYNTHETIC_CATALOGUE_CONTRACT.responseSchema
            : SYNTHETIC_PREFIX_CONTRACT.responseSchema;
          return JSON.stringify({
            schema,
            mode: "TEST_ONLY",
            id: innerRequest.id,
            sequence: innerRequest.sequence,
            requestSha256: innerRequest.requestSha256,
            provenance: innerRequest.provenance,
            complete: true,
            settled: true,
            isError: false,
            payload,
          });
        },
      });
      const prefix = await prefixReader.read();
      if (prefix.prefixQualified !== true || prefix.fullAcquisitionQualified !== false ||
          prefix.usage.calls !== sequence || prefix.usage.cloudCalls !== cloudCalls ||
          prefix.usage.sqlCalls !== sqlCalls ||
          JSON.stringify(prefix.provenance) !== JSON.stringify(prefixProvenance)) {
        fail("acquisition_prefix_rejected");
      }
      const provenance = prefix.provenance;

      const command = (id, args, interpret, maximumPayloadBytes = ACQUISITION_LIMITS.cloudResponseBytes) =>
        dispatch({ id, requestSha256: sha256(JSON.stringify(args)), provenance, args,
          maximumPayloadBytes, kind: "cloud", interpret });
      const principalArgs = ["auth", "list", "--filter=status:ACTIVE", "--format=json(account,status)"];
      const snapshotArgs = ["storage", "objects", "describe",
        `gs://${options.snapshotScope.bucket}/${options.snapshotScope.object}`,
        "--format=json(generation,metageneration,etag)"];
      const secretArgs = ["secrets", "versions", "describe", options.secretReference.key,
        "--secret=supabase-service-role-key", "--project", TARGET.project, "--format=json(name,state)"];
      const metadataOptions = { mode: "TEST_ONLY" };
      const secretOptions = { ...metadataOptions, projectNumber: options.projectNumber,
        referenceKey: options.secretReference.key };
      const principalOpening = await command("principalOpening", principalArgs,
        raw => validateSyntheticPrincipal(raw, metadataOptions));
      const snapshotOpening = await command("snapshotOpening", snapshotArgs,
        raw => validateSyntheticSnapshotMetadata(raw, metadataOptions));
      const secretOpening = await command("secretVersionOpening", secretArgs,
        raw => validateSyntheticSecretVersionMetadata(raw, secretOptions));
      const principalClosing = await command("principalClosing", principalArgs,
        raw => validateSyntheticPrincipal(raw, metadataOptions));
      const snapshotClosing = await command("snapshotClosing", snapshotArgs,
        raw => validateSyntheticSnapshotMetadata(raw, metadataOptions));
      const secretClosing = await command("secretVersionClosing", secretArgs,
        raw => validateSyntheticSecretVersionMetadata(raw, secretOptions));
      assertStable(principalOpening, principalClosing, "acquisition_metadata_changed");
      assertStable(snapshotOpening, snapshotClosing, "acquisition_metadata_changed");
      assertStable(secretOpening, secretClosing, "acquisition_metadata_changed");
      if (digest({ ...options.snapshotScope, principal: principalOpening.projection.principal }) !==
          options.packet.baseline?.account || digest(snapshotOpening.projection) !== options.packet.baseline?.snapshot ||
          secretOpening.projection.secretVersion !== options.packet.baseline?.secretVersion) {
        fail("acquisition_metadata_agreement_rejected");
      }

      const containmentClosing = await dispatch({
        id: "containmentClosing",
        requestSha256: ACQUISITION_IDENTITIES.containmentQuerySha256,
        provenance,
        args: null,
        maximumPayloadBytes: ACQUISITION_LIMITS.sqlPayloadBytes + ACQUISITION_LIMITS.sqlWrapperAllowanceBytes,
        kind: "sql",
        interpret: validateContainmentCompatibility,
      });
      if (containmentClosing.fingerprint !== prefix.containmentFingerprint ||
          containmentClosing.controls !== prefix.controlsFingerprint) fail("acquisition_containment_changed");

      const jobArgs = ["run", "jobs", "describe", TARGET.job, "--project", TARGET.project,
        "--region", TARGET.region, "--format=json"];
      const serviceArgs = ["run", "services", "describe", TARGET.service, "--project", TARGET.project,
        "--region", TARGET.region, "--format=json"];
      const inventoryArgs = ["run", "jobs", "executions", "list", "--job", TARGET.job,
        "--project", TARGET.project, "--region", TARGET.region, "--limit=1001",
        `--filter=metadata.labels.run.googleapis.com/job=${TARGET.job}`,
        "--format=json(metadata.name,metadata.uid,metadata.creationTimestamp,metadata.labels,status.completionTime,status.runningCount)"];
      const executionArgs = name => ["run", "jobs", "executions", "describe", name,
        "--project", TARGET.project, "--region", TARGET.region, "--format=json"];
      const resourceOptions = { mode: "TEST_ONLY", packet: options.packet, projectNumber: options.projectNumber };
      const readPass = async (pass, retainedInventory = null) => {
        const result = {};
        result.job = await command(`fullJobPass${pass}`, jobArgs,
          raw => validateSyntheticFullJob(raw, resourceOptions));
        result.service = await command(`fullServicePass${pass}`, serviceArgs,
          raw => validateSyntheticFullService(raw, resourceOptions));
        result.inventory = await command(`fullInventoryPass${pass}`, inventoryArgs,
          raw => validateSyntheticAcquisitionInventory(raw, metadataOptions));
        if (retainedInventory) {
          if (JSON.stringify(retainedInventory.ids) !== JSON.stringify(result.inventory.ids) ||
              JSON.stringify(retainedInventory.selected) !== JSON.stringify(result.inventory.selected)) {
            fail("acquisition_inventory_changed");
          }
          assertStable(retainedInventory, result.inventory, "acquisition_resource_changed");
        }
        const selected = (retainedInventory ?? result.inventory).selected;
        result.execution = await command(`completedExecutionPass${pass}`,
          executionArgs(selected.name),
          raw => validateSyntheticCompletedExecution(raw, { ...resourceOptions, selected }));
        validateResourceAgreement(result, options.snapshotScope, options.secretReference);
        return Object.freeze(result);
      };
      const first = await readPass(1);
      const second = await readPass(2, first.inventory);
      assertStable(first.job, second.job, "acquisition_resource_changed");
      assertStable(first.service, second.service, "acquisition_resource_changed");
      assertStable(first.execution, second.execution, "acquisition_resource_changed");

      await command("closingE13", NAT_ARGS, raw => {
        let value;
        try { value = parseBoundedSqlJson(raw, ACQUISITION_LIMITS.cloudResponseBytes); }
        catch { fail("acquisition_closing_egress_rejected"); }
        if (!Array.isArray(value) || value.length !== 0) fail("acquisition_closing_egress_rejected");
        return value;
      });
      const closingObservedAt = current();
      if (sequence < SYNTHETIC_ACQUISITION_READER_CONTRACT.minimumCalls ||
          sequence > SYNTHETIC_ACQUISITION_READER_CONTRACT.maximumCalls ||
          sequenceById.get("containmentClosing") !== cloudCalls - 7 ||
          sequenceById.get("closingE13") !== cloudCalls + 2 || sqlCalls !== 3 ||
          cloudCalls + sqlCalls !== sequence) fail("acquisition_call_budget_mismatch");
      const elapsedMs = current() - started;
      if (elapsedMs >= options.totalDurationMs) fail("acquisition_total_timeout");

      const handoffSha256 = sha256(JSON.stringify({
        provenance,
        catalogue: prefix.catalogueFingerprint,
        iam: prefix.iamFingerprint,
        egress: prefix.egressFingerprint,
        containment: containmentClosing.fingerprint,
        principal: principalOpening.sha256,
        snapshot: snapshotOpening.sha256,
        secret: secretOpening.sha256,
        job: first.job.sha256,
        service: first.service.sha256,
        inventory: first.inventory.sha256,
        execution: first.execution.sha256,
      }));
      const receipt = Object.freeze({
        schema: SYNTHETIC_ACQUISITION_READER_CONTRACT.handoffSchema,
        mode: "TEST_ONLY",
        handoffSha256,
        usage: Object.freeze({ calls: sequence, cloudCalls, sqlCalls, receivedBytes, elapsedMs }),
        completeAcquisitionQualified: true,
        transportQualified: false,
        privateBindingReady: false,
      });
      PRIVATE_HANDOFFS.set(receipt, Object.freeze({ owner, current, started, deadline: started + options.totalDurationMs,
        closingObservedAt, prefix, principalOpening, principalClosing,
        snapshotOpening, snapshotClosing, secretOpening, secretClosing, containmentClosing, first, second }));
      return receipt;
    },
  });
}
