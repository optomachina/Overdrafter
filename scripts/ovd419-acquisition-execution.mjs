import { createHash } from "node:crypto";
import { ACQUISITION_LIMITS } from "./ovd419-acquisition-compatibility.mjs";
import { parseBoundedSqlJson } from "./ovd419-acquisition-support/official-sql-wrapper.mjs";
import { validateOvd419ResourceAnnotations } from "./ovd419-cloud-run-metadata-contract.mjs";
import { validateOvd419ProbeTaskContract } from "./ovd419-cloud-run-task-contract.mjs";
import { compareCodeUnits, digest, TARGET } from "./ovd419-job-diagnostic.mjs";

const reject = () => { throw new Error("acquisition_completed_execution_rejected"); };
const HASH = /^[0-9a-f]{64}$/;
function requireValue(value) { if (!value) reject(); }
function shape(value, required, optional = []) {
  requireValue(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  requireValue(required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
function integer(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum);
}
function token(value, maximum = 256) {
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
function canonicalBase64(value, maximumBytes) {
  requireValue(typeof value === "string" && value.length >= 4
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value));
  const bytes = Buffer.from(value, "base64");
  requireValue(bytes.length >= 1 && bytes.length <= maximumBytes && bytes.toString("base64") === value);
  return bytes;
}
function canonicalBase64UrlJson(value) {
  requireValue(typeof value === "string" && value.length >= 2 && value.length <= 87382
    && /^[A-Za-z0-9_-]+$/.test(value));
  const bytes = Buffer.from(value, "base64url");
  requireValue(bytes.length >= 2 && bytes.length <= 65536 && bytes.toString("base64url") === value);
  const text = bytes.toString("utf8");
  requireValue(Buffer.from(text).equals(bytes));
  return parseBoundedSqlJson(text, 65536);
}

function packetBindings(packet) {
  shape(packet, ["schema", "evidencePath", "proposalSha256", "candidateConfiguration", "ownerTask",
    "sourceCommit", "target", "image", "baselineImage", "baselineBuild", "attempts", "retries",
    "dependencyRiskAccepted", "expiresAt", "limits", "baseline", "artifacts", "trees"]);
  requireValue(typeof packet.artifacts?.runtimeModule?.sha256 === "string"
    && HASH.test(packet.artifacts.runtimeModule.sha256));
  requireValue(typeof packet.candidateConfiguration === "string" && HASH.test(packet.candidateConfiguration));
  requireValue(typeof packet.image === "string" && typeof packet.baselineImage === "string");
  requireValue(typeof packet.limits?.cpu === "string" && typeof packet.limits.memory === "string");
  integer(packet.limits.taskSeconds, 1, 900);
  requireValue(typeof packet.baseline?.snapshot === "string" && HASH.test(packet.baseline.snapshot));
  requireValue(typeof packet.baseline?.job?.uid === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(packet.baseline.job.uid)
    && typeof packet.baseline.job.configuration === "string" && HASH.test(packet.baseline.job.configuration));
  requireValue(Array.isArray(packet.baseline.inventory) && packet.baseline.inventory.length <= 1000
    && packet.baseline.inventory.every(name => typeof name === "string"
      && /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(name))
    && new Set(packet.baseline.inventory).size === packet.baseline.inventory.length);
  instant(packet.expiresAt);
}

function executionLabels(value, ownerUid) {
  const names = ["cloud.googleapis.com/location", "run.googleapis.com/job",
    "run.googleapis.com/jobGeneration", "run.googleapis.com/jobResourceVersion",
    "run.googleapis.com/jobUid", "run.googleapis.com/satisfiesPzs"];
  shape(value, names);
  requireValue(value[names[0]] === TARGET.region && value[names[1]] === TARGET.job
    && typeof value[names[2]] === "string" && /^[1-9]\d{0,18}$/.test(value[names[2]])
    && typeof value[names[3]] === "string" && /^[A-Za-z0-9+/_=-]{1,256}$/.test(value[names[3]])
    && typeof value[names[4]] === "string" && value[names[4]] === ownerUid
    && value[names[5]] === "true");
  const generation = Number(value[names[2]]);
  integer(generation, 1);
  return { generation, resourceVersion: value[names[3]] };
}

function metadata(value, options) {
  shape(value, ["annotations", "creationTimestamp", "generation", "labels", "name", "namespace",
    "ownerReferences", "resourceVersion", "selfLink", "uid"]);
  const selected = options.selected;
  shape(selected, ["name", "uid"]);
  requireValue(typeof selected.name === "string" && /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(selected.name)
    && selected.name.startsWith(`${TARGET.job}-`));
  requireValue(typeof selected.uid === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(selected.uid));
  requireValue(value.name === selected.name && value.uid === selected.uid && value.namespace === options.projectNumber);
  requireValue(value.selfLink === `/apis/run.googleapis.com/v1/namespaces/${options.projectNumber}/executions/${selected.name}`);
  requireValue(typeof value.resourceVersion === "string" && /^[A-Za-z0-9+/_=-]{1,256}$/.test(value.resourceVersion));
  integer(value.generation, 1);
  const created = instant(value.creationTimestamp);
  requireValue(Array.isArray(value.ownerReferences) && value.ownerReferences.length === 1);
  const owner = value.ownerReferences[0];
  shape(owner, ["apiVersion", "blockOwnerDeletion", "controller", "kind", "name", "uid"]);
  requireValue(owner.apiVersion === "run.googleapis.com/v1" && owner.kind === "Job"
    && owner.name === TARGET.job && owner.blockOwnerDeletion === true && owner.controller === true
    && typeof owner.uid === "string" && owner.uid === options.packet.baseline.job.uid);
  const job = executionLabels(value.labels, owner.uid);
  validateOvd419ResourceAnnotations(value.annotations, { network: true, allowServerAttribution: true });
  return { created, owner, job };
}

function preconditions(value, packet, owner, job) {
  shape(value, ["project", "region", "job", "packetSha256", "runtimeModuleSha256", "expiresAt",
    "snapshotFingerprint", "jobIdentity", "executionInventory"]);
  requireValue(value.project === TARGET.project && value.region === TARGET.region && value.job === TARGET.job);
  requireValue(typeof value.packetSha256 === "string" && value.packetSha256 === digest(packet));
  requireValue(typeof value.runtimeModuleSha256 === "string"
    && value.runtimeModuleSha256 === packet.artifacts.runtimeModule.sha256);
  requireValue(typeof value.expiresAt === "string" && value.expiresAt === packet.expiresAt);
  requireValue(typeof value.snapshotFingerprint === "string"
    && value.snapshotFingerprint === digest(packet.baseline.snapshot));
  shape(value.jobIdentity, ["uid", "generation", "configurationFingerprint"]);
  requireValue(value.jobIdentity.uid === owner.uid && value.jobIdentity.generation === job.generation
    && typeof value.jobIdentity.configurationFingerprint === "string"
    && [packet.candidateConfiguration, packet.baseline.job.configuration]
      .includes(value.jobIdentity.configurationFingerprint));
  shape(value.executionInventory, ["totalCount", "fingerprint"]);
  const inventory = [...packet.baseline.inventory].sort(compareCodeUnits);
  requireValue(value.executionInventory.totalCount === inventory.length
    && typeof value.executionInventory.fingerprint === "string"
    && value.executionInventory.fingerprint === digest(inventory));
}

function realizedTask(value, packet, owner, job) {
  shape(value, ["containers", "maxRetries", "serviceAccountName", "timeoutSeconds"]);
  requireValue(Array.isArray(value.containers) && value.containers.length === 1);
  const container = value.containers[0];
  shape(container, ["args", "command", "env", "image", "resources"]);
  requireValue(Array.isArray(container.command) && container.command.length === 1 && container.command[0] === "node");
  requireValue(Array.isArray(container.args) && container.args.length === 3
    && container.args[0] === "--input-type=module" && container.args[1] === "-e"
    && typeof container.args[2] === "string");
  const prefix = 'await import("data:text/javascript;base64,';
  requireValue(container.args[2].startsWith(prefix) && container.args[2].endsWith('")'));
  const encodedModule = container.args[2].slice(prefix.length, -2);
  const moduleBytes = canonicalBase64(encodedModule, 262144);
  const moduleSha256 = createHash("sha256").update(moduleBytes).digest("hex");
  requireValue(moduleSha256 === packet.artifacts.runtimeModule.sha256);
  requireValue(Array.isArray(container.env));
  const special = container.env.filter(entry => entry?.name === "OVD419_EXPECTED_PRECONDITIONS_B64");
  requireValue(special.length === 1);
  shape(special[0], ["name", "value"]);
  const decoded = canonicalBase64UrlJson(special[0].value);
  preconditions(decoded, packet, owner, job);
  const base = structuredClone(value);
  base.containers[0].args = ["dist/tools/probeXometryProfileAuth.js"];
  base.containers[0].env = base.containers[0].env
    .filter(entry => entry.name !== "OVD419_EXPECTED_PRECONDITIONS_B64");
  const task = validateOvd419ProbeTaskContract(base, packet);
  return {
    task,
    invocationFingerprint: digest(value),
    preconditionFingerprint: digest(decoded),
    runtimeModuleSha256: moduleSha256,
  };
}

function logUri(value, executionName) {
  requireValue(typeof value === "string" && value.length <= 8192);
  let parsed;
  try { parsed = new URL(value); } catch { reject(); }
  requireValue(parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
    && parsed.port === "" && parsed.hostname === "console.cloud.google.com" && parsed.hash === ""
    && parsed.pathname === "/logs/viewer" && parsed.href === value
    && [...parsed.searchParams.keys()].length === 2
    && parsed.searchParams.get("project") === TARGET.project);
  const filter = parsed.searchParams.get("advancedFilter");
  requireValue(typeof filter === "string" && filter.includes('resource.type="cloud_run_job"')
    && filter.includes(`resource.labels.job_name="${TARGET.job}"`)
    && filter.includes(`resource.labels.location="${TARGET.region}"`)
    && filter.includes(`labels."run.googleapis.com/execution_name"="${executionName}"`));
  return value;
}

function status(value, generation, createdAt, executionName) {
  shape(value, ["completionTime", "conditions", "failedCount", "logUri", "observedGeneration", "startTime"]);
  requireValue(value.observedGeneration === generation && value.failedCount === 1);
  const started = instant(value.startTime), completed = instant(value.completionTime);
  requireValue(started >= createdAt && completed >= started);
  requireValue(Array.isArray(value.conditions) && value.conditions.length === 4);
  const expected = new Map([["ResourcesAvailable", "True"], ["Started", "True"],
    ["ContainerReady", "True"], ["Completed", "False"]]);
  const seen = new Set();
  for (const condition of value.conditions) {
    shape(condition, ["lastTransitionTime", "message", "status", "type"], ["reason"]);
    requireValue(typeof condition.type === "string" && expected.has(condition.type) && !seen.has(condition.type)
      && condition.status === expected.get(condition.type));
    requireValue(typeof condition.message === "string" && Buffer.byteLength(condition.message) <= 2048
      && !/[\u0000-\u001f\u007f]/.test(condition.message));
    const transitioned = instant(condition.lastTransitionTime);
    requireValue(transitioned >= createdAt && transitioned <= completed);
    if (condition.type === "Completed") token(condition.reason, 256);
    else requireValue(condition.reason === undefined);
    seen.add(condition.type);
  }
  requireValue(seen.size === expected.size);
  const uri = logUri(value.logUri, executionName);
  return { started, completed, uri };
}

/**
 * Interpret one complete selected terminal failed Execution using D089-observed
 * structure and the retained diagnostic invocation contract. No bytes execute.
 */
export function validateSyntheticCompletedExecution(raw, options) {
  try {
    shape(options, ["mode", "packet", "projectNumber", "selected"]);
    requireValue(options.mode === "TEST_ONLY" && typeof options.projectNumber === "string"
      && /^[1-9]\d{0,19}$/.test(options.projectNumber));
    packetBindings(options.packet);
    const value = parseBoundedSqlJson(raw, ACQUISITION_LIMITS.cloudResponseBytes);
    shape(value, ["apiVersion", "kind", "metadata", "spec", "status"]);
    requireValue(value.apiVersion === "run.googleapis.com/v1" && value.kind === "Execution");
    const identity = metadata(value.metadata, options);
    shape(value.spec, ["parallelism", "taskCount", "template"]);
    requireValue(value.spec.parallelism === 1 && value.spec.taskCount === 1);
    shape(value.spec.template, ["spec"]);
    const realized = realizedTask(value.spec.template.spec, options.packet, identity.owner, identity.job);
    const state = status(value.status, value.metadata.generation, identity.created, value.metadata.name);
    return frozen({
      schema: "OVD419-SYNTHETIC-COMPLETED-EXECUTION-NOT-AUTHORITY-v1",
      kind: "execution",
      raw,
      sha256: createHash("sha256").update(raw).digest("hex"),
      projection: {
        identity: { name: value.metadata.name, uid: value.metadata.uid,
          generation: value.metadata.generation, resourceVersion: value.metadata.resourceVersion,
          projectNumber: options.projectNumber },
        ownerJob: { name: identity.owner.name, uid: identity.owner.uid,
          generation: identity.job.generation, resourceVersion: identity.job.resourceVersion },
        image: realized.task.image,
        snapshotScope: { ...realized.task.snapshotScope },
        resources: { ...realized.task.resources },
        taskFingerprint: realized.task.taskFingerprint,
        invocationFingerprint: realized.invocationFingerprint,
        preconditionFingerprint: realized.preconditionFingerprint,
        runtimeModuleSha256: realized.runtimeModuleSha256,
        configurationFingerprint: digest({ name: value.metadata.name, spec: value.spec }),
        statusFingerprint: digest(value.status),
        failedCount: value.status.failedCount,
        createdAt: value.metadata.creationTimestamp,
        startedAt: value.status.startTime,
        completedAt: value.status.completionTime,
        logUri: state.uri,
        logUriFingerprint: digest(state.uri),
      },
      transportQualified: false,
      fullAcquisitionQualified: false,
      privateBindingReady: false,
    });
  } catch { reject(); }
}
