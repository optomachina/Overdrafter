import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ACQUISITION_LIMITS } from "./ovd419-acquisition-compatibility.mjs";
import { validateSyntheticCompletedExecution } from "./ovd419-acquisition-execution.mjs";
import { validateSyntheticAcquisitionInventory } from "./ovd419-acquisition-inventory.mjs";
import { validateSyntheticFullJob } from "./ovd419-acquisition-job.mjs";
import { validateSyntheticFullService } from "./ovd419-acquisition-service.mjs";
import { parseBoundedSqlJson } from "./ovd419-acquisition-support/official-sql-wrapper.mjs";
import { TARGET } from "./ovd419-job-diagnostic.mjs";

export const SYNTHETIC_FULL_RESOURCE_READER_CONTRACT = Object.freeze({
  requestSchema: "OVD419-SYNTHETIC-FULL-RESOURCE-REQUEST-v1",
  responseSchema: "OVD419-SYNTHETIC-FULL-RESOURCE-RESPONSE-v1",
  handoffSchema: "OVD419-SYNTHETIC-FULL-RESOURCE-OPAQUE-HANDOFF-v1",
  calls: 8,
  perReadMs: ACQUISITION_LIMITS.perReadMs,
  totalDurationMs: ACQUISITION_LIMITS.totalDurationMs,
});

const PRIVATE_HANDOFFS = new WeakMap();
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const fail = code => { throw new Error(code); };

/** Require an ordinary object with exactly the named fields. */
function exactObject(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !actual.every(key => keys.includes(key))) fail(code);
}

/** Require a closed ordinary object with all required and only optional extra fields. */
function closedObject(value, required, optional, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      !required.every(key => Object.hasOwn(value, key)) ||
      !Object.keys(value).every(key => required.includes(key) || optional.includes(key))) fail(code);
}

/** Validate constructor input before defaults can hide a misspelled option. */
function validateOptions(options) {
  exactObject(options, ["transport", "packet", "projectNumber", "perReadMs", "totalDurationMs"], "invalid_full_resource_options");
  if (typeof options.transport !== "function") fail("full_resource_transport_required");
  if (!options.packet || typeof options.packet !== "object" || Array.isArray(options.packet) ||
      Object.getPrototypeOf(options.packet) !== Object.prototype) fail("invalid_full_resource_packet");
  if (typeof options.projectNumber !== "string" || !/^[1-9][0-9]{0,19}$/.test(options.projectNumber)) {
    fail("invalid_full_resource_project_number");
  }
  if (!Number.isSafeInteger(options.perReadMs) || options.perReadMs < 1 ||
      options.perReadMs > SYNTHETIC_FULL_RESOURCE_READER_CONTRACT.perReadMs ||
      !Number.isSafeInteger(options.totalDurationMs) || options.totalDurationMs < 1 ||
      options.totalDurationMs > SYNTHETIC_FULL_RESOURCE_READER_CONTRACT.totalDurationMs) {
    fail("invalid_full_resource_limits");
  }
}

/** Construct one immutable, attributable request for the injected TEST_ONLY transport. */
function resourceRequest(id, sequence, args) {
  const frozenArgs = Object.freeze([...args]);
  return Object.freeze({
    schema: SYNTHETIC_FULL_RESOURCE_READER_CONTRACT.requestSchema,
    mode: "TEST_ONLY",
    id,
    sequence,
    requestSha256: sha256(JSON.stringify(frozenArgs)),
    args: frozenArgs,
  });
}

/** Validate the transport envelope and retain only its exact payload. */
function responsePayload(raw, request) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > ACQUISITION_LIMITS.aggregateTransportBytes) {
    fail("invalid_full_resource_response");
  }
  let response;
  try { response = parseBoundedSqlJson(raw, ACQUISITION_LIMITS.aggregateTransportBytes); }
  catch { fail("invalid_full_resource_response"); }
  if (JSON.stringify(response) !== raw) fail("invalid_full_resource_response");
  exactObject(response, ["schema", "mode", "id", "sequence", "requestSha256", "complete", "settled", "isError", "payload"], "invalid_full_resource_response");
  if (response.schema !== SYNTHETIC_FULL_RESOURCE_READER_CONTRACT.responseSchema ||
      response.mode !== "TEST_ONLY" || response.id !== request.id ||
      response.sequence !== request.sequence || response.requestSha256 !== request.requestSha256 ||
      response.complete !== true || response.settled !== true || response.isError !== false ||
      typeof response.payload !== "string" ||
      Buffer.byteLength(response.payload, "utf8") > ACQUISITION_LIMITS.cloudResponseBytes) {
    fail("invalid_full_resource_response");
  }
  return response.payload;
}

/** Compare exact resources across both finite passes. */
function stablePair(first, second) {
  if (first.sha256 !== second.sha256) fail("full_resource_changed_between_passes");
}

/** Enforce resource agreement without treating a historical Execution as the current Job revision. */
function validateAgreement({ job, service, inventory, execution }) {
  const jobProjection = job.projection;
  const serviceProjection = service.projection;
  const executionProjection = execution.projection;
  if (jobProjection.latestCompletedExecution.name !== inventory.selected.name ||
      jobProjection.identity.uid !== executionProjection.ownerJob.uid ||
      jobProjection.image !== serviceProjection.image || jobProjection.image !== executionProjection.image ||
      JSON.stringify(jobProjection.snapshotScope) !== JSON.stringify(serviceProjection.snapshotScope) ||
      JSON.stringify(jobProjection.snapshotScope) !== JSON.stringify(executionProjection.snapshotScope) ||
      JSON.stringify(jobProjection.resources) !== JSON.stringify(executionProjection.resources) ||
      jobProjection.taskFingerprint !== executionProjection.taskFingerprint) {
    fail("full_resource_agreement_rejected");
  }
}

/** Return whether a value is a live in-memory reader handoff; this slice has no unwrapping API. */
export function isSyntheticFullResourceHandoff(value) {
  return value !== null && typeof value === "object" && PRIVATE_HANDOFFS.has(value);
}

/**
 * Read and validate the two-pass eight-call full-resource slice through an
 * injected TEST_ONLY transport. Raw resources remain in a module-private weak
 * handoff and are never exposed by the returned receipt.
 */
export function createSyntheticFullResourceReader(input = {}) {
  closedObject(input, ["transport", "packet", "projectNumber"], ["perReadMs", "totalDurationMs"],
    "invalid_full_resource_options");
  const {
    transport,
    packet,
    projectNumber,
    perReadMs = SYNTHETIC_FULL_RESOURCE_READER_CONTRACT.perReadMs,
    totalDurationMs = SYNTHETIC_FULL_RESOURCE_READER_CONTRACT.totalDurationMs,
  } = input;
  const options = { transport, packet, projectNumber, perReadMs, totalDurationMs };
  validateOptions(options);
  let consumed = false;

  return Object.freeze({
    async read() {
      if (consumed) fail("full_resource_request_budget_exhausted");
      consumed = true;
      const started = performance.now();
      let receivedBytes = 0;
      let sequence = 0;

      /** Dispatch one serial read and include transport plus validation in its deadline. */
      const dispatch = async (id, args, validate) => {
        const remainingMs = totalDurationMs - (performance.now() - started);
        if (remainingMs <= 0) fail("full_resource_total_timeout");
        const readStarted = performance.now();
        const controller = new AbortController();
        let timer;
        const request = resourceRequest(id, sequence, args);
        sequence += 1;
        try {
          const timeoutMs = Math.min(perReadMs, remainingMs);
          const timedOut = new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("full_resource_read_timeout"));
            }, timeoutMs);
          });
          const operation = Promise.resolve().then(() => transport(request, Object.freeze({
              signal: controller.signal,
              maxBytes: ACQUISITION_LIMITS.cloudResponseBytes,
            }))).catch(() => fail("full_resource_transport_failed"));
          const raw = await Promise.race([operation, timedOut]);
          const payload = responsePayload(raw, request);
          receivedBytes += Buffer.byteLength(payload, "utf8");
          if (receivedBytes > ACQUISITION_LIMITS.aggregateTransportBytes) fail("full_resource_aggregate_byte_limit");
          const interpreted = validate(payload);
          if (performance.now() - readStarted >= perReadMs) fail("full_resource_read_timeout");
          if (performance.now() - started >= totalDurationMs) fail("full_resource_total_timeout");
          return interpreted;
        } catch (error) {
          controller.abort();
          throw error;
        } finally {
          clearTimeout(timer);
        }
      };

      const jobArgs = ["run", "jobs", "describe", TARGET.job, "--project", TARGET.project,
        "--region", TARGET.region, "--format=json"];
      const serviceArgs = ["run", "services", "describe", TARGET.service, "--project", TARGET.project,
        "--region", TARGET.region, "--format=json"];
      const inventoryArgs = ["run", "jobs", "executions", "list", "--job", TARGET.job,
        "--project", TARGET.project, "--region", TARGET.region, "--limit=1001",
        "--filter=metadata.labels.run.googleapis.com/job=" + TARGET.job,
        "--format=json(metadata.name,metadata.uid,metadata.creationTimestamp,metadata.labels,status.completionTime,status.runningCount)"];
      const executionArgs = name => ["run", "jobs", "executions", "describe", name,
        "--project", TARGET.project, "--region", TARGET.region, "--format=json"];
      const jobOptions = { mode: "TEST_ONLY", packet, projectNumber };

      const first = {};
      first.job = await dispatch("fullJobPass1", jobArgs, raw => validateSyntheticFullJob(raw, jobOptions));
      first.service = await dispatch("fullServicePass1", serviceArgs, raw => validateSyntheticFullService(raw, jobOptions));
      first.inventory = await dispatch("fullInventoryPass1", inventoryArgs,
        raw => validateSyntheticAcquisitionInventory(raw, { mode: "TEST_ONLY" }));
      first.execution = await dispatch("completedExecutionPass1", executionArgs(first.inventory.selected.name),
        raw => validateSyntheticCompletedExecution(raw, { ...jobOptions, selected: first.inventory.selected }));
      validateAgreement(first);

      const second = {};
      second.job = await dispatch("fullJobPass2", jobArgs, raw => validateSyntheticFullJob(raw, jobOptions));
      stablePair(first.job, second.job);
      second.service = await dispatch("fullServicePass2", serviceArgs, raw => validateSyntheticFullService(raw, jobOptions));
      stablePair(first.service, second.service);
      second.inventory = await dispatch("fullInventoryPass2", inventoryArgs,
        raw => validateSyntheticAcquisitionInventory(raw, { mode: "TEST_ONLY" }));
      if (JSON.stringify(second.inventory.ids) !== JSON.stringify(first.inventory.ids) ||
          JSON.stringify(second.inventory.selected) !== JSON.stringify(first.inventory.selected)) {
        fail("full_resource_inventory_changed_between_passes");
      }
      stablePair(first.inventory, second.inventory);
      second.execution = await dispatch("completedExecutionPass2", executionArgs(first.inventory.selected.name),
        raw => validateSyntheticCompletedExecution(raw, { ...jobOptions, selected: first.inventory.selected }));
      stablePair(first.execution, second.execution);
      validateAgreement(second);
      if (sequence !== SYNTHETIC_FULL_RESOURCE_READER_CONTRACT.calls) fail("full_resource_call_budget_mismatch");

      const handoffSha256 = sha256(JSON.stringify({
        job: first.job.sha256,
        service: first.service.sha256,
        inventory: first.inventory.sha256,
        execution: first.execution.sha256,
      }));
      const elapsedMs = performance.now() - started;
      if (elapsedMs >= totalDurationMs) fail("full_resource_total_timeout");
      const receipt = Object.freeze({
        schema: SYNTHETIC_FULL_RESOURCE_READER_CONTRACT.handoffSchema,
        mode: "TEST_ONLY",
        handoffSha256,
        usage: Object.freeze({ calls: sequence, receivedBytes, elapsedMs }),
        fullResourceShapeQualified: true,
        transportQualified: false,
        fullAcquisitionQualified: false,
        privateBindingReady: false,
      });
      PRIVATE_HANDOFFS.set(receipt, Object.freeze({
        first: Object.freeze(first),
        second: Object.freeze(second),
      }));
      return receipt;
    },
  });
}
