import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { types } from "node:util";
import { fileURLToPath } from "node:url";
import { createEngineeringInboxFixturePlan } from "./engineering-inbox-fixture-plan.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA = "overdrafter.engineering-inbox-fixture-runtime-inventory-admission.v1";
const RESULT_SCHEMA = "overdrafter.engineering-inbox-fixture-runtime-inventory-result.v1";
const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ABSOLUTE = /^\/(?:[^\0/]+\/)*[^\0/]+$/;
const INHERITED_DOCKER = ["DOCKER_AUTH_CONFIG", "DOCKER_CERT_PATH", "DOCKER_CONFIG", "DOCKER_CONTEXT",
  "DOCKER_HOST", "DOCKER_TLS", "DOCKER_TLS_VERIFY"];
const LIMITS = Object.freeze({ actionMs: 10_000, gracefulStopMs: 250, hardStopMs: 2_000,
  stdoutBytes: 1024 * 1024, stderrBytes: 256 * 1024, envelopeBytes: 512 * 1024 });
const LABEL_KEYS = ["contract", "ownerTaskId", "role", "runId", "sourceRevision"];

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const actual = Reflect.ownKeys(value);
  return actual.every((key) => typeof key === "string")
    && actual.sort().join("\0") === [...keys].sort().join("\0")
    && actual.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor && descriptor.enumerable;
    });
}

function plainCopy(value, seen = new WeakSet(), depth = 0) {
  try {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string" && value.length <= 64 * 1024) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || seen.has(value) || depth > 8) {
      throw failure("invalid_admission");
    }
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 64 || keys.some((key) => typeof key !== "string")) throw failure("invalid_admission");
    const output = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw failure("invalid_admission");
      output[key] = plainCopy(descriptor.value, seen, depth + 1);
    }
    return output;
  } catch {
    throw failure("invalid_admission");
  }
}

function canonicalPlan(plan) {
  try {
    if (!Object.isFrozen(plan)) throw failure("invalid_plan");
    const canonical = createEngineeringInboxFixturePlan({ sourceRevision: plan.identity.sourceRevision,
      ownerTaskId: plan.identity.ownerTaskId, runId: plan.identity.runId,
      databaseImage: plan.images.database.id, postgrestImage: plan.images.postgrest.id,
      migrations: plan.migrations.map(({ path, sha256 }) => ({ path, sha256 })) });
    if (JSON.stringify(plan) !== JSON.stringify(canonical)) throw failure("invalid_plan");
    return canonical;
  } catch (error) {
    if (error?.code === "invalid_plan") throw error;
    throw failure("invalid_plan");
  }
}

function validateAdmission(input, plan) {
  const admission = plainCopy(input);
  const identityKeys = ["hostId", "ownerTaskId", "runId", "sourceRevision", "sourceTree"];
  const dockerKeys = ["client", "configPath", "daemon", "enrollmentReceiptSha256", "socket"];
  const clientKeys = ["path", "sha256"];
  const socketKeys = ["canonicalPath", "device", "inode", "mode", "ownerId", "path"];
  const daemonKeys = ["dockerRootDir", "engineId", "name", "operatingSystem", "osType", "securityOptionsSha256"];
  if (!exact(admission, ["docker", "identity", "limits", "schema"]) || admission.schema !== SCHEMA
    || !exact(admission.identity, identityKeys) || !exact(admission.docker, dockerKeys)
    || !exact(admission.docker.client, clientKeys) || !exact(admission.docker.socket, socketKeys)
    || !exact(admission.docker.daemon, daemonKeys) || !exact(admission.limits, Object.keys(LIMITS))) {
    throw failure("invalid_admission");
  }
  const { identity, docker } = admission;
  if (identity.sourceRevision !== plan.identity.sourceRevision || identity.ownerTaskId !== plan.identity.ownerTaskId
    || identity.runId !== plan.identity.runId || !SHA40.test(identity.sourceRevision)
    || !SHA40.test(identity.sourceTree) || typeof identity.hostId !== "string" || !identity.hostId
    || identity.hostId.length > 256 || !SHA64.test(docker.client.sha256)
    || !SHA64.test(docker.enrollmentReceiptSha256) || !ABSOLUTE.test(docker.client.path)
    || !ABSOLUTE.test(docker.configPath) || !ABSOLUTE.test(docker.socket.path)
    || docker.socket.path !== docker.socket.canonicalPath || !Number.isSafeInteger(docker.socket.device)
    || docker.socket.device < 0 || !Number.isSafeInteger(docker.socket.inode) || docker.socket.inode < 1
    || !Number.isSafeInteger(docker.socket.ownerId) || docker.socket.ownerId < 0
    || typeof docker.socket.mode !== "string" || !/^[0-7]{3,4}$/.test(docker.socket.mode)
    || !Object.values(docker.daemon).every((value) => typeof value === "string" && value.length > 0 && value.length <= 4096)
    || !SHA64.test(docker.daemon.securityOptionsSha256)
    || Object.keys(LIMITS).some((key) => admission.limits[key] !== LIMITS[key])) throw failure("invalid_admission");
  return admission;
}

function assertEnvironment() {
  if (INHERITED_DOCKER.some((key) => Object.hasOwn(process.env, key))) {
    throw failure("inherited_docker_configuration");
  }
}

function processEnvironment(admission) {
  return Object.freeze({ DOCKER_CONFIG: admission.docker.configPath,
    DOCKER_HOST: `unix://${admission.docker.socket.canonicalPath}`, LANG: "C", LC_ALL: "C" });
}

function terminateGroup(child, signal) {
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) return false;
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function runCommand(admission, args, deadlineAt, signal) {
  if (signal?.aborted) return Promise.reject(failure("aborted"));
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(failure("timed_out"));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(admission.docker.client.path, args, { cwd: ROOT, detached: true,
        env: processEnvironment(admission), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      reject(failure("child_failed"));
      return;
    }
    let stdout = Buffer.alloc(0), stderrBytes = 0;
    let childClosed = false, stdoutClosed = false, stderrClosed = false, exitCode = null;
    let stopReason = null, operationFailure = null, settled = false;
    const timers = new Set();
    const later = (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; };
    const clear = () => { for (const timer of timers) clearTimeout(timer); timers.clear();
      signal?.removeEventListener?.("abort", onAbort); };
    const finish = () => {
      if (settled || !childClosed || !stdoutClosed || !stderrClosed) return;
      settled = true;
      clear();
      if (stopReason) reject(failure(stopReason));
      else if (operationFailure) reject(failure(operationFailure));
      else if (exitCode !== 0) reject(failure("child_failed"));
      else resolve(stdout.toString("utf8"));
    };
    const hardStop = () => {
      if (childClosed && stdoutClosed && stderrClosed) return;
      terminateGroup(child, "SIGKILL");
      later(() => {
        if (settled || childClosed && stdoutClosed && stderrClosed) return finish();
        settled = true;
        clear();
        reject(failure("process_stop_unproved"));
      }, LIMITS.hardStopMs);
    };
    const stop = (reason) => {
      if (stopReason || settled) return;
      stopReason = reason;
      terminateGroup(child, "SIGTERM");
      later(hardStop, LIMITS.gracefulStopMs);
    };
    const onAbort = () => stop("aborted");
    signal?.addEventListener?.("abort", onAbort, { once: true });
    later(() => stop("timed_out"), remaining);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdout.length + data.length > LIMITS.stdoutBytes) { operationFailure = "output_limit"; stop("output_limit"); return; }
      stdout = Buffer.concat([stdout, data]);
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > LIMITS.stderrBytes) { operationFailure = "output_limit"; stop("output_limit"); }
    });
    child.stdout.once("error", () => { operationFailure = "child_failed"; stop("child_failed"); });
    child.stderr.once("error", () => { operationFailure = "child_failed"; stop("child_failed"); });
    child.stdout.once("close", () => { stdoutClosed = true; finish(); });
    child.stderr.once("close", () => { stderrClosed = true; finish(); });
    child.once("error", () => { operationFailure = "child_failed"; });
    child.once("close", (code) => { childClosed = true; exitCode = code; finish(); });
  });
}

function parseJson(text, code = "invalid_envelope") {
  if (Buffer.byteLength(text) > LIMITS.envelopeBytes) throw failure("output_limit");
  try { return JSON.parse(text); } catch { throw failure(code); }
}

function parseLines(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.map((line) => parseJson(line));
}

function hashSecurityOptions(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length > 4096)) {
    throw failure("daemon_identity_unproved");
  }
  return createHash("sha256").update(JSON.stringify([...value].sort())).digest("hex");
}

function validateDaemon(info, expected) {
  const actual = { dockerRootDir: info?.DockerRootDir, engineId: info?.ID, name: info?.Name,
    operatingSystem: info?.OperatingSystem, osType: info?.OSType,
    securityOptionsSha256: hashSecurityOptions(info?.SecurityOptions) };
  if (Object.keys(actual).some((key) => actual[key] !== expected[key])) throw failure("daemon_identity_unproved");
}

function listIdentity(row, type) {
  const id = row?.ID;
  const name = type === "container" ? row?.Names : row?.Name;
  if (typeof id !== "string" || !SHA64.test(id) || typeof name !== "string" || !name) return null;
  return { id, name, type };
}

function candidates(rows, runRows, type, expectedNames) {
  const selected = new Map();
  const add = (row, sourceSeen) => {
    const identity = listIdentity(row, type);
    if (!identity || sourceSeen.has(identity.id)) throw failure("inventory_uncertain");
    sourceSeen.add(identity.id);
    const prior = selected.get(identity.id);
    if (prior && prior.name !== identity.name) throw failure("inventory_uncertain");
    selected.set(identity.id, identity);
  };
  const listed = new Set();
  for (const row of rows) {
    const name = type === "container" ? row?.Names : row?.Name;
    if (typeof name === "string" && expectedNames.has(name)) add(row, listed);
  }
  const filtered = new Set();
  for (const row of runRows) add(row, filtered);
  return [...selected.values()];
}

function expectedLabels(plan, role) {
  return { contract: plan.schema, ownerTaskId: plan.identity.ownerTaskId, role,
    runId: plan.identity.runId, sourceRevision: plan.identity.sourceRevision };
}

function sameLabels(actual, expected) {
  return actual && Object.keys(actual).sort().join("\0") === LABEL_KEYS.join("\0")
    && LABEL_KEYS.every((key) => actual[key] === expected[key]);
}

function classifyInspect(value, candidate, plan, networkName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "inventory_uncertain";
  const role = candidate.name.endsWith("-database") ? "database"
    : candidate.name.endsWith("-postgrest") ? "postgrest" : candidate.name.endsWith("-network") ? "network" : null;
  const actualLabels = value.Labels ?? value.Config?.Labels;
  if (!role || value.Id !== candidate.id || value.Name?.replace(/^\//, "") !== candidate.name
    || !sameLabels(actualLabels, expectedLabels(plan, role))) return "inventory_drift";
  if (candidate.type === "network") return value.Internal === true ? "inventory_exact" : "inventory_drift";
  const caps = plan.resourcePolicy.containers[role];
  const host = value.HostConfig;
  const expectedMemory = caps.memoryBytes;
  if (!host || value.Config?.Image !== plan.images[role].id || host.Memory !== expectedMemory
    || host.NanoCpus !== caps.cpuCount * 1_000_000_000 || host.PidsLimit !== caps.pids
    || host.ReadonlyRootfs !== caps.readOnlyRoot || host.Privileged !== false
    || host.NetworkMode !== networkName || !(host.Binds == null || Array.isArray(host.Binds) && host.Binds.length === 0)
    || !Array.isArray(value.Mounts) || value.Mounts.length > 0) return "inventory_drift";
  const tmpfs = host.Tmpfs;
  if (!tmpfs || Object.keys(tmpfs).sort().join("\0") !== [...caps.tmpfs].sort().join("\0")) return "inventory_drift";
  const bindings = host.PortBindings ?? {};
  if (role === "database" && Object.keys(bindings).length !== 0) return "inventory_drift";
  if (role === "postgrest") {
    if (Object.keys(bindings).length !== 1 || !Array.isArray(bindings["3000/tcp"])
      || bindings["3000/tcp"].length !== 1) return "inventory_drift";
    const binding = bindings["3000/tcp"][0];
    const port = Number(binding?.HostPort);
    if (!["127.0.0.1", "::1"].includes(binding?.HostIp)
      || !Number.isSafeInteger(port) || port < 1 || port > 65535) return "inventory_drift";
  }
  return "inventory_exact";
}

/** Source-only async inventory boundary. Runtime endpoint and process behavior remain unqualified. */
export async function inspectEngineeringInboxFixtureInventory({ plan, admission, signal = new AbortController().signal }) {
  plan = canonicalPlan(plan);
  admission = validateAdmission(admission, plan);
  assertEnvironment();
  const deadlineAt = Date.now() + LIMITS.actionMs;
  const run = (args) => runCommand(admission, args, deadlineAt, signal);
  const info = parseJson(await run(["info", "--format", "{{json .}}"]));
  validateDaemon(info, admission.docker.daemon);
  const containerRows = parseLines(await run(["container", "ls", "--all", "--no-trunc", "--format", "{{json .}}"]));
  const runFilter = `label=runId=${plan.identity.runId}`;
  const runContainers = parseLines(await run(["container", "ls", "--all", "--no-trunc", "--filter", runFilter,
    "--format", "{{json .}}"]));
  const networkRows = parseLines(await run(["network", "ls", "--no-trunc", "--format", "{{json .}}"]));
  const runNetworks = parseLines(await run(["network", "ls", "--no-trunc", "--filter", runFilter,
    "--format", "{{json .}}"]));
  const prefix = `ovd496-${plan.identity.runId}`;
  const networkName = `${prefix}-network`;
  const containerCandidates = candidates(containerRows, runContainers, "container",
    new Set([`${prefix}-database`, `${prefix}-postgrest`]));
  const networkCandidates = candidates(networkRows, runNetworks, "network", new Set([networkName]));
  const selected = [...containerCandidates, ...networkCandidates];
  const inspected = [];
  for (const type of ["container", "network"]) {
    const group = selected.filter((entry) => entry.type === type);
    if (!group.length) continue;
    const values = parseJson(await run([type, "inspect", ...group.map(({ id }) => id)]));
    if (!Array.isArray(values) || values.length !== group.length) throw failure("inventory_uncertain");
    for (const entry of group) {
      const value = values.find((item) => item?.Id === entry.id);
      const classification = classifyInspect(value, entry, plan, networkName);
      if (classification === "inventory_uncertain") throw failure(classification);
      inspected.push({ classification, id: entry.id, name: entry.name, type: entry.type });
    }
  }
  return structuredClone({ schema: RESULT_SCHEMA, qualification: "source_contract_only",
    admissionEvidence: "unverified", collisionStatus: inspected.length ? "collision" : "clear",
    candidateCount: inspected.length, candidates: inspected });
}

export const ENGINEERING_INBOX_RUNTIME_INVENTORY_LIMITS = LIMITS;
