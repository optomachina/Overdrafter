import { digest, TARGET } from "./ovd419-job-diagnostic.mjs";
import { OVD410_PRODUCTION_CONTRACT as NETWORK } from "./xometry-stable-egress-contract.mjs";

const REQUIRED_ENV = Object.freeze({
  WORKER_MODE: "simulate",
  WORKER_TEMP_DIR: "/root/.cache/overdrafter-worker",
  XOMETRY_BROWSER_ENGINE: "camoufox",
  PLAYWRIGHT_HEADLESS: "true",
  PLAYWRIGHT_BROWSER_TIMEOUT_MS: "45000",
  PLAYWRIGHT_DISABLE_SANDBOX: "true",
  PLAYWRIGHT_DISABLE_DEV_SHM_USAGE: "true",
});
const SNAPSHOT_ENV = Object.freeze([
  "XOMETRY_PROFILE_SNAPSHOT_BUCKET",
  "XOMETRY_PROFILE_SNAPSHOT_OBJECT",
  "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES",
]);
const reject = () => { throw new Error("cloud_run_task_contract_rejected"); };
function requireValue(value) { if (!value) reject(); }
function shape(value, required, optional = []) {
  requireValue(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  requireValue(required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}

function environment(entries) {
  requireValue(Array.isArray(entries) && entries.length >= 10 && entries.length <= 11);
  const seen = new Set(), values = new Map();
  for (const entry of entries) {
    shape(entry, ["name", "value"]);
    requireValue(typeof entry.value === "string" && !seen.has(entry.name));
    seen.add(entry.name); values.set(entry.name, entry.value);
    if (Object.hasOwn(REQUIRED_ENV, entry.name)) requireValue(entry.value === REQUIRED_ENV[entry.name]);
    else if (entry.name === "PLAYWRIGHT_CAPTURE_TRACE") requireValue(entry.value === "false");
    else if (entry.name === SNAPSHOT_ENV[0]) requireValue(/^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/.test(entry.value));
    else if (entry.name === SNAPSHOT_ENV[1]) requireValue(entry.value.length >= 1 && entry.value.length <= 1024 && !/[\r\n\0*?[\]#]/.test(entry.value));
    else if (entry.name === SNAPSHOT_ENV[2]) requireValue(/^[1-9]\d{0,9}$/.test(entry.value));
    else reject();
  }
  requireValue([...Object.keys(REQUIRED_ENV), ...SNAPSHOT_ENV].every(key => seen.has(key)));
  return Object.freeze({
    bucket: values.get(SNAPSHOT_ENV[0]),
    object: values.get(SNAPSHOT_ENV[1]),
    maxBytes: values.get(SNAPSHOT_ENV[2]),
  });
}

/**
 * Validate the existing OVD-419 diagnostic Job task shape without I/O. This is
 * shared contract groundwork, not acceptance of a full Job, Service or Execution.
 */
export function validateOvd419ProbeTaskContract(value, packet) {
  try {
    shape(value, ["containers", "maxRetries", "serviceAccountName", "timeoutSeconds"]);
    requireValue(value.maxRetries === 0 && value.serviceAccountName === NETWORK.serviceAccount
      && [packet.limits.taskSeconds, String(packet.limits.taskSeconds)].includes(value.timeoutSeconds));
    requireValue(Array.isArray(value.containers) && value.containers.length === 1);
    const container = value.containers[0];
    shape(container, ["image", "command", "args", "env", "resources"], ["name"]);
    if (container.name !== undefined) {
      requireValue([TARGET.service, `${TARGET.service}-1`, TARGET.job, `${TARGET.job}-1`, "worker"].includes(container.name));
    }
    requireValue([packet.image, packet.baselineImage].includes(container.image));
    requireValue(Array.isArray(container.command) && container.command.length === 1 && container.command[0] === "node");
    requireValue(Array.isArray(container.args) && container.args.length === 1
      && container.args[0] === "dist/tools/probeXometryProfileAuth.js");
    const snapshotScope = environment(container.env);
    shape(container.resources, ["limits"]); shape(container.resources.limits, ["cpu", "memory"]);
    requireValue(container.resources.limits.cpu === packet.limits.cpu
      && container.resources.limits.memory === packet.limits.memory);
    return Object.freeze({
      schema: "OVD419-PROBE-TASK-CONTRACT-NOT-AUTHORITY-v1",
      image: container.image,
      snapshotScope,
      resources: Object.freeze({ cpu: container.resources.limits.cpu, memory: container.resources.limits.memory,
        taskSeconds: Number(value.timeoutSeconds), retries: value.maxRetries }),
      taskFingerprint: digest(value),
      privateBindingReady: false,
    });
  } catch { reject(); }
}
