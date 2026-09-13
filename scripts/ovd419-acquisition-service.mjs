import { createHash } from "node:crypto";
import { ACQUISITION_LIMITS } from "./ovd419-acquisition-compatibility.mjs";
import { parseBoundedSqlJson } from "./ovd419-acquisition-support/official-sql-wrapper.mjs";
import {
  validateOvd419ResourceLabels,
  validateOvd419ServiceRootAnnotations,
  validateOvd419ServiceTemplateMetadata,
} from "./ovd419-cloud-run-metadata-contract.mjs";
import { digest, TARGET } from "./ovd419-job-diagnostic.mjs";
import { isImmutableImage, OVD410_PRODUCTION_CONTRACT as NETWORK } from "./xometry-stable-egress-contract.mjs";

const PRODUCTION_SUPABASE_URL = "https://ozuatdcakezjtevztjlr.supabase.co";
const reject = () => { throw new Error("acquisition_full_service_rejected"); };
function requireValue(value) { if (!value) reject(); }
function shape(value, fields) {
  requireValue(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Object.keys(value);
  requireValue(keys.length === fields.length && keys.every(key => fields.includes(key)));
}
function integer(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum);
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
function serviceUrl(value) {
  requireValue(typeof value === "string" && value.length <= 2048);
  let parsed;
  try { parsed = new URL(value); } catch { reject(); }
  requireValue(parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
    && parsed.port === "" && parsed.pathname === "/" && parsed.search === "" && parsed.hash === ""
    && parsed.origin === value
    && parsed.hostname.startsWith(`${TARGET.service}-`) && parsed.hostname.endsWith(".run.app"));
  return value;
}

function status(value, generation, createdAt) {
  shape(value, ["address", "conditions", "latestCreatedRevisionName", "latestReadyRevisionName",
    "observedGeneration", "traffic", "url"]);
  requireValue(value.observedGeneration === generation);
  shape(value.address, ["url"]);
  const url = serviceUrl(value.url);
  requireValue(value.address.url === url);
  requireValue(typeof value.latestReadyRevisionName === "string"
    && /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(value.latestReadyRevisionName)
    && value.latestReadyRevisionName.startsWith(`${TARGET.service}-`)
    && value.latestCreatedRevisionName === value.latestReadyRevisionName);
  requireValue(Array.isArray(value.traffic) && value.traffic.length === 1);
  shape(value.traffic[0], ["latestRevision", "percent", "revisionName"]);
  requireValue(value.traffic[0].latestRevision === true && value.traffic[0].percent === 100
    && value.traffic[0].revisionName === value.latestReadyRevisionName);
  requireValue(Array.isArray(value.conditions) && value.conditions.length >= 1 && value.conditions.length <= 16);
  const types = new Set();
  for (const condition of value.conditions) {
    shape(condition, ["lastTransitionTime", "status", "type"]);
    requireValue(["True", "False", "Unknown"].includes(condition.status));
    requireValue(typeof condition.type === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(condition.type)
      && !types.has(condition.type));
    requireValue(instant(condition.lastTransitionTime) >= createdAt);
    types.add(condition.type);
  }
  requireValue(value.conditions.some(condition => condition.type === "Ready" && condition.status === "True"));
  return { url, readyRevision: value.latestReadyRevisionName };
}

function resourceMetadata(value, projectNumber, url) {
  shape(value, ["annotations", "creationTimestamp", "generation", "labels", "name", "namespace",
    "resourceVersion", "selfLink", "uid"]);
  requireValue(value.name === TARGET.service && value.namespace === projectNumber);
  requireValue(value.selfLink === `/apis/serving.knative.dev/v1/namespaces/${projectNumber}/services/${TARGET.service}`);
  requireValue(typeof value.uid === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.uid));
  requireValue(typeof value.resourceVersion === "string" && /^[A-Za-z0-9+/_=-]{1,256}$/.test(value.resourceVersion));
  integer(value.generation, 1);
  instant(value.creationTimestamp);
  validateOvd419ResourceLabels(value.labels);
  validateOvd419ServiceRootAnnotations(value.annotations, url);
}

function directEnvironment(entry, value) {
  shape(entry, ["name", "value"]);
  requireValue(entry.value === value);
}
function snapshotEnvironment(entry, name) {
  shape(entry, ["name", "value"]);
  requireValue(typeof entry.value === "string");
  if (name === "XOMETRY_PROFILE_SNAPSHOT_BUCKET") {
    requireValue(/^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/.test(entry.value));
  } else if (name === "XOMETRY_PROFILE_SNAPSHOT_OBJECT") {
    requireValue(typeof entry.value === "string" && entry.value.length >= 1 && entry.value.length <= 1024
      && !/[\r\n\0*?[\]#]/.test(entry.value));
  } else requireValue(/^[1-9]\d{0,9}$/.test(entry.value));
}

function environment(entries, packet) {
  requireValue(Array.isArray(entries) && entries.length === 19);
  const byName = new Map();
  for (const entry of entries) {
    requireValue(entry !== null && typeof entry === "object" && Object.getPrototypeOf(entry) === Object.prototype
      && typeof entry.name === "string" && !byName.has(entry.name));
    byName.set(entry.name, entry);
  }
  const fixed = {
    SUPABASE_URL: PRODUCTION_SUPABASE_URL,
    WORKER_MODE: "live",
    WORKER_LIVE_ADAPTERS: "xometry",
    WORKER_NAME: TARGET.service,
    WORKER_POLL_INTERVAL_MS: "5000",
    WORKER_BUILD_VERSION: packet.baselineBuild,
    WORKER_HTTP_HOST: "0.0.0.0",
    WORKER_TEMP_DIR: "/root/.cache/overdrafter-worker",
    QUOTE_ARTIFACT_BUCKET: "quote-artifacts",
    PLAYWRIGHT_HEADLESS: "true",
    PLAYWRIGHT_CAPTURE_TRACE: "false",
    PLAYWRIGHT_BROWSER_TIMEOUT_MS: "45000",
    PLAYWRIGHT_DISABLE_SANDBOX: "true",
    PLAYWRIGHT_DISABLE_DEV_SHM_USAGE: "true",
    XOMETRY_BROWSER_ENGINE: "camoufox",
  };
  const snapshots = ["XOMETRY_PROFILE_SNAPSHOT_BUCKET", "XOMETRY_PROFILE_SNAPSHOT_OBJECT",
    "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES"];
  const expected = new Set([...Object.keys(fixed), ...snapshots, "SUPABASE_SERVICE_ROLE_KEY"]);
  requireValue(byName.size === expected.size && [...byName.keys()].every(name => expected.has(name)));
  for (const [name, value] of Object.entries(fixed)) directEnvironment(byName.get(name), value);
  for (const name of snapshots) snapshotEnvironment(byName.get(name), name);
  const secret = byName.get("SUPABASE_SERVICE_ROLE_KEY");
  shape(secret, ["name", "valueFrom"]); shape(secret.valueFrom, ["secretKeyRef"]);
  shape(secret.valueFrom.secretKeyRef, ["key", "name"]);
  const reference = secret.valueFrom.secretKeyRef;
  requireValue(reference.name === "supabase-service-role-key"
    && typeof reference.key === "string"
    && (reference.key === "latest" || /^[1-9]\d{0,18}$/.test(reference.key))
    && ["latest", packet.baseline.secretVersion].includes(reference.key));
  return {
    workerBuild: byName.get("WORKER_BUILD_VERSION").value,
    snapshotScope: {
      bucket: byName.get(snapshots[0]).value,
      object: byName.get(snapshots[1]).value,
      maxBytes: byName.get(snapshots[2]).value,
    },
    secretReference: { name: reference.name, key: reference.key },
  };
}

function container(value, packet) {
  shape(value, ["env", "image", "ports", "resources", "startupProbe"]);
  requireValue(isImmutableImage(value.image) && value.image === packet.baselineImage);
  requireValue(Array.isArray(value.ports) && value.ports.length === 1);
  shape(value.ports[0], ["containerPort", "name"]);
  requireValue(value.ports[0].containerPort === 8080 && value.ports[0].name === "http1");
  shape(value.resources, ["limits"]); shape(value.resources.limits, ["cpu", "memory"]);
  requireValue(value.resources.limits.cpu === "2" && value.resources.limits.memory === "2Gi");
  shape(value.startupProbe, ["failureThreshold", "periodSeconds", "tcpSocket", "timeoutSeconds"]);
  shape(value.startupProbe.tcpSocket, ["port"]);
  integer(value.startupProbe.failureThreshold, 1, 10);
  integer(value.startupProbe.periodSeconds, 1, 240);
  integer(value.startupProbe.timeoutSeconds, 1, 240);
  requireValue(value.startupProbe.timeoutSeconds <= value.startupProbe.periodSeconds
    && value.startupProbe.tcpSocket.port === value.ports[0].containerPort);
  return { ...environment(value.env, packet),
    resources: { cpu: "2", memory: "2Gi", port: 8080 },
    startupProbeFingerprint: digest(value.startupProbe) };
}

/**
 * Interpret a complete synthetic Cloud Run Service read using D089-observed
 * structure and existing worker/egress semantics. No I/O or authority is added.
 */
export function validateSyntheticFullService(raw, options) {
  try {
    shape(options, ["mode", "packet", "projectNumber"]);
    requireValue(options.mode === "TEST_ONLY" && options.packet !== null
      && typeof options.packet === "object" && Object.getPrototypeOf(options.packet) === Object.prototype);
    requireValue(typeof options.packet.baselineBuild === "string"
      && /^[0-9a-f]{40}$/.test(options.packet.baselineBuild));
    requireValue(typeof options.packet.baseline?.secretVersion === "string"
      && /^[1-9]\d{0,18}$/.test(options.packet.baseline.secretVersion));
    requireValue(typeof options.projectNumber === "string" && /^[1-9][0-9]{0,19}$/.test(options.projectNumber));
    const value = parseBoundedSqlJson(raw, ACQUISITION_LIMITS.cloudResponseBytes);
    shape(value, ["apiVersion", "kind", "metadata", "spec", "status"]);
    requireValue(value.apiVersion === "serving.knative.dev/v1" && value.kind === "Service");
    const state = status(value.status, value.metadata?.generation, instant(value.metadata?.creationTimestamp));
    resourceMetadata(value.metadata, options.projectNumber, state.url);
    shape(value.spec, ["template", "traffic"]);
    requireValue(Array.isArray(value.spec.traffic) && value.spec.traffic.length === 1);
    shape(value.spec.traffic[0], ["latestRevision", "percent"]);
    requireValue(value.spec.traffic[0].latestRevision === true && value.spec.traffic[0].percent === 100);
    shape(value.spec.template, ["metadata", "spec"]);
    validateOvd419ServiceTemplateMetadata(value.spec.template.metadata);
    const template = value.spec.template.spec;
    shape(template, ["containerConcurrency", "containers", "serviceAccountName", "timeoutSeconds"]);
    requireValue(template.containerConcurrency === 1 && template.serviceAccountName === NETWORK.serviceAccount
      && template.timeoutSeconds === 3600 && Array.isArray(template.containers) && template.containers.length === 1);
    const service = container(template.containers[0], options.packet);
    return frozen({
      schema: "OVD419-SYNTHETIC-FULL-SERVICE-NOT-AUTHORITY-v1",
      kind: "service",
      raw,
      sha256: createHash("sha256").update(raw).digest("hex"),
      projection: {
        identity: { name: value.metadata.name, uid: value.metadata.uid, generation: value.metadata.generation,
          resourceVersion: value.metadata.resourceVersion, projectNumber: options.projectNumber },
        image: template.containers[0].image,
        workerBuild: service.workerBuild,
        snapshotScope: service.snapshotScope,
        secretReference: service.secretReference,
        resources: { ...service.resources, timeoutSeconds: template.timeoutSeconds,
          containerConcurrency: template.containerConcurrency },
        startupProbeFingerprint: service.startupProbeFingerprint,
        configurationFingerprint: digest({ name: value.metadata.name, spec: value.spec }),
        statusFingerprint: digest(value.status),
        readyRevision: state.readyRevision,
        url: state.url,
      },
      transportQualified: false,
      fullAcquisitionQualified: false,
      privateBindingReady: false,
    });
  } catch { reject(); }
}
