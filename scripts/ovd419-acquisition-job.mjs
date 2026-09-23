import { createHash } from "node:crypto";
import { ACQUISITION_LIMITS } from "./ovd419-acquisition-compatibility.mjs";
import { parseBoundedSqlJson } from "./ovd419-acquisition-support/official-sql-wrapper.mjs";
import { validateOvd419ProbeTaskContract } from "./ovd419-cloud-run-task-contract.mjs";
import {
  validateOvd419ResourceAnnotations,
  validateOvd419ResourceLabels,
  validateOvd419TemplateMetadata,
} from "./ovd419-cloud-run-metadata-contract.mjs";
import { digest, TARGET } from "./ovd419-job-diagnostic.mjs";

const reject = () => { throw new Error("acquisition_full_job_rejected"); };
function requireValue(value) { if (!value) reject(); }
function shape(value, fields) {
  requireValue(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Object.keys(value);
  requireValue(keys.length === fields.length && keys.every(key => fields.includes(key)));
}
function integer(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum);
}
function boundedToken(value, maximum = 128) {
  requireValue(typeof value === "string" && value.length >= 1 && Buffer.byteLength(value) <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value));
}
function instant(value) {
  requireValue(typeof value === "string");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  requireValue(match && !value.startsWith("0000-"));
  const milliseconds = Date.parse(`${match[1]}Z`);
  requireValue(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === `${match[1]}.000Z`);
  return BigInt(milliseconds) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}
function frozen(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

function resourceMetadata(value, projectNumber) {
  shape(value, ["annotations", "creationTimestamp", "generation", "labels", "name", "namespace",
    "resourceVersion", "selfLink", "uid"]);
  requireValue(value.name === TARGET.job && value.namespace === projectNumber);
  requireValue(value.selfLink === `/apis/run.googleapis.com/v1/namespaces/${projectNumber}/jobs/${TARGET.job}`);
  requireValue(typeof value.uid === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.uid));
  requireValue(typeof value.resourceVersion === "string" && /^[A-Za-z0-9+/_=-]{1,256}$/.test(value.resourceVersion));
  integer(value.generation, 1);
  instant(value.creationTimestamp);
  validateOvd419ResourceLabels(value.labels);
  validateOvd419ResourceAnnotations(value.annotations, { allowServerAttribution: true });
}

function supportedTask(value, packet) {
  shape(value, ["containers", "maxRetries", "serviceAccountName", "timeoutSeconds"]);
  requireValue(typeof value.timeoutSeconds === "string");
  requireValue(Array.isArray(value.containers) && value.containers.length === 1);
  const container = value.containers[0];
  shape(container, ["args", "command", "env", "image", "resources"]);
  requireValue(Array.isArray(container.args) && Array.isArray(container.command) && Array.isArray(container.env));
  shape(container.resources, ["limits"]);
  shape(container.resources.limits, ["cpu", "memory"]);
  return validateOvd419ProbeTaskContract(value, packet);
}

function status(value, generation, createdAt) {
  shape(value, ["conditions", "executionCount", "latestCreatedExecution", "observedGeneration"]);
  integer(value.executionCount, 1);
  requireValue(value.observedGeneration === generation);
  requireValue(Array.isArray(value.conditions) && value.conditions.length >= 1 && value.conditions.length <= 16);
  const types = new Set();
  for (const condition of value.conditions) {
    shape(condition, ["status", "type"]);
    requireValue(["True", "False", "Unknown"].includes(condition.status));
    requireValue(typeof condition.type === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(condition.type)
      && !types.has(condition.type));
    types.add(condition.type);
  }
  const latest = value.latestCreatedExecution;
  shape(latest, ["completionStatus", "completionTimestamp", "creationTimestamp", "name"]);
  requireValue(["EXECUTION_SUCCEEDED", "EXECUTION_FAILED", "EXECUTION_CANCELLED"].includes(latest.completionStatus));
  requireValue(typeof latest.name === "string" && /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(latest.name)
    && latest.name.startsWith(`${TARGET.job}-`));
  const executionCreatedAt = instant(latest.creationTimestamp);
  const completedAt = instant(latest.completionTimestamp);
  requireValue(executionCreatedAt >= createdAt && completedAt >= executionCreatedAt);
  return {
    latestCompletedExecution: {
      name: latest.name,
      createdAt: latest.creationTimestamp,
      completedAt: latest.completionTimestamp,
      completionStatus: latest.completionStatus,
    },
    executionCount: value.executionCount,
  };
}

/**
 * Interpret a complete synthetic Cloud Run Job read using the D089-observed
 * structure and existing diagnostic semantics. This performs no I/O and never
 * establishes transport, full-acquisition, or private-binding authority.
 */
export function validateSyntheticFullJob(raw, options) {
  try {
    shape(options, ["mode", "packet", "projectNumber"]);
    requireValue(options.mode === "TEST_ONLY" && options.packet !== null
      && typeof options.packet === "object" && Object.getPrototypeOf(options.packet) === Object.prototype);
    requireValue(typeof options.projectNumber === "string" && /^[1-9]\d{0,19}$/.test(options.projectNumber));
    const value = parseBoundedSqlJson(raw, ACQUISITION_LIMITS.cloudResponseBytes);
    shape(value, ["apiVersion", "kind", "metadata", "spec", "status"]);
    requireValue(value.apiVersion === "run.googleapis.com/v1" && value.kind === "Job");
    resourceMetadata(value.metadata, options.projectNumber);
    shape(value.spec, ["template"]);
    shape(value.spec.template, ["metadata", "spec"]);
    shape(value.spec.template.metadata, ["annotations", "labels"]);
    validateOvd419TemplateMetadata(value.spec.template.metadata, { network: true });
    shape(value.spec.template.spec, ["parallelism", "taskCount", "template"]);
    requireValue(value.spec.template.spec.parallelism === 1 && value.spec.template.spec.taskCount === 1);
    shape(value.spec.template.spec.template, ["spec"]);
    const task = supportedTask(value.spec.template.spec.template.spec, options.packet);
    const state = status(value.status, value.metadata.generation, instant(value.metadata.creationTimestamp));
    return frozen({
      schema: "OVD419-SYNTHETIC-FULL-JOB-NOT-AUTHORITY-v1",
      kind: "job",
      raw,
      sha256: createHash("sha256").update(raw).digest("hex"),
      projection: {
        identity: {
          name: value.metadata.name,
          uid: value.metadata.uid,
          generation: value.metadata.generation,
          resourceVersion: value.metadata.resourceVersion,
          projectNumber: options.projectNumber,
        },
        image: task.image,
        snapshotScope: { ...task.snapshotScope },
        resources: { ...task.resources },
        taskFingerprint: task.taskFingerprint,
        configurationFingerprint: digest({ name: value.metadata.name, spec: value.spec }),
        statusFingerprint: digest(value.status),
        ...state,
      },
      transportQualified: false,
      fullAcquisitionQualified: false,
      privateBindingReady: false,
    });
  } catch { reject(); }
}
