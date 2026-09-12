import { constants } from "node:fs";
import { lstat, realpath, mkdtemp, open, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { digest, TARGET } from "./ovd419-job-diagnostic.mjs";
import { runWithinBudget } from "./ovd419-diagnostic-budget.mjs";
import { OVD410_PRODUCTION_CONTRACT as NETWORK } from "./xometry-stable-egress-contract.mjs";
import { validateOvd419ProbeTaskContract } from "./ovd419-cloud-run-task-contract.mjs";

function reject() { throw new Error("diagnostic_manifest_rejected"); }
function requireValue(value) { if (!value) reject(); }
function shape(value, required, optional = []) {
  requireValue(value && Object.getPrototypeOf(value) === Object.prototype);
  requireValue(required.every((k) => Object.hasOwn(value, k)) && Object.keys(value).every((k) => required.includes(k) || optional.includes(k)));
}
function labels(value) {
  shape(value, [], ["cloud.googleapis.com/location", "run.googleapis.com/satisfiesPzs"]);
  for (const [key, v] of Object.entries(value)) requireValue(v === (key === "cloud.googleapis.com/location" ? TARGET.region : "true"));
}
// Only the supported one-interface/two-string-field JSON grammar is admitted.
// Decode each key token before comparing; JSON.parse of the whole object would
// silently discard earlier duplicate keys while leaving their bytes in the file.
function networkInterface(value) {
  const stringToken = /"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  let offset = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(value[offset] ?? "") && offset < value.length) offset += 1; };
  const punctuation = (expected) => {
    whitespace(); requireValue(value[offset] === expected); offset += 1;
  };
  const string = () => {
    whitespace(); stringToken.lastIndex = offset;
    const token = stringToken.exec(value); requireValue(token !== null);
    offset = stringToken.lastIndex;
    // Native token decoding also rejects unescaped control characters.
    try { return JSON.parse(token[0]); } catch { reject(); }
  };
  punctuation("["); punctuation("{");
  const firstKey = string(); punctuation(":"); const firstValue = string();
  punctuation(",");
  const secondKey = string(); punctuation(":"); const secondValue = string();
  punctuation("}"); punctuation("]"); whitespace(); requireValue(offset === value.length);
  requireValue(firstKey !== secondKey && [firstKey, secondKey].every((key) => ["network", "subnetwork"].includes(key)));
  return { [firstKey]: firstValue, [secondKey]: secondValue };
}
function annotations(value, network = false) {
  const routing = ["run.googleapis.com/network-interfaces", "run.googleapis.com/vpc-access-egress"];
  const fixed = { "run.googleapis.com/client-name": ["gcloud"], "run.googleapis.com/launch-stage": ["GA", "BETA"], "run.googleapis.com/execution-environment": ["gen2"] };
  shape(value, network ? routing : [], [...Object.keys(fixed), "run.googleapis.com/client-version", "run.googleapis.com/operation-id"]);
  for (const [key, v] of Object.entries(value)) {
    if (Object.hasOwn(fixed, key)) requireValue(fixed[key].includes(v));
    else if (key === "run.googleapis.com/client-version") requireValue(typeof v === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v));
    else if (key === "run.googleapis.com/operation-id") requireValue(typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v));
    else if (key === "run.googleapis.com/vpc-access-egress") requireValue(v === "all-traffic");
    else {
      requireValue(typeof v === "string" && v.length <= 1024);
      const entry = networkInterface(v);
      for (const [field, name, scope] of [["network", NETWORK.network, "global/networks"], ["subnetwork", NETWORK.subnet, `regions/${TARGET.region}/subnetworks`]]) {
        const resource = `projects/${TARGET.project}/${scope}/${name}`;
        requireValue([name, resource, `https://www.googleapis.com/compute/v1/${resource}`].includes(entry[field]));
      }
    }
  }
}
function templateMetadata(value, network) {
  shape(value, network ? ["annotations"] : [], network ? ["labels"] : ["labels", "annotations"]);
  if (value.labels !== undefined) labels(value.labels);
  if (value.annotations !== undefined) annotations(value.annotations, network);
}
/** Validate the entire outgoing resource before serialization/persistence; never strip fields. */
export function validatePrivateManifest(value, packet) {
  shape(value, ["apiVersion", "kind", "metadata", "spec"]);
  requireValue(value.apiVersion === "run.googleapis.com/v1" && value.kind === "Job");
  shape(value.metadata, ["name", "resourceVersion"], ["labels", "annotations"]);
  requireValue(value.metadata.name === TARGET.job && typeof value.metadata.resourceVersion === "string" && /^[A-Za-z0-9+/_=-]{1,256}$/.test(value.metadata.resourceVersion));
  if (value.metadata.labels !== undefined) labels(value.metadata.labels);
  if (value.metadata.annotations !== undefined) annotations(value.metadata.annotations);
  shape(value.spec, ["template"]); const execution = value.spec.template;
  shape(execution, ["metadata", "spec"]); templateMetadata(execution.metadata, true);
  shape(execution.spec, ["taskCount", "template"], ["parallelism"]);
  requireValue(execution.spec.taskCount === 1 && (execution.spec.parallelism === undefined || execution.spec.parallelism === 1));
  shape(execution.spec.template, ["spec"], ["metadata"]);
  if (execution.spec.template.metadata !== undefined) templateMetadata(execution.spec.template.metadata, false);
  const task = execution.spec.template.spec;
  let taskContract;
  try { taskContract = validateOvd419ProbeTaskContract(task, packet); } catch { reject(); }
  const expected = taskContract.image === packet.image ? packet.candidateConfiguration : packet.baseline.job.configuration;
  requireValue(digest({ name: value.metadata.name, spec: value.spec }) === expected);
  const bytes = Buffer.from(JSON.stringify(value)); requireValue(bytes.length <= 64 * 1024); return bytes;
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sameInode = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
function owned(metadata, mode, directory = false) {
  requireValue(metadata.uid === process.getuid() && (metadata.mode & 0o7777) === mode && (directory ? metadata.isDirectory() : metadata.isFile() && metadata.nlink === 1));
}

/**
 * Create a private, inode-bound file after validation. Verification must be repeated
 * immediately before command use. Cleanup never follows a substituted path or
 * recursively deletes unknown entries. The same-user OS account remains trusted.
 */
export async function createPrivateManifest(value, packet, { signal, parent = tmpdir(), deadlineAt = Infinity, now = Date.now, evidence = {} } = {}) {
  const bytes = validatePrivateManifest(value, packet); evidence.validated = true;
  let directory, file, directoryStat, fileStat, handle, disposal;
  evidence.directoryCreated = false; evidence.fileCreated = false; evidence.verifiedBeforeCommand = false; evidence.cleanup = "not_created";
  const checkSignal = () => { if (signal?.aborted) reject(); };
  const cleanup = async () => {
    evidence.cleanup = "unproved";
    try {
      await runWithinBudget(async () => {
        try {
          if (!directory) return;
          const d = await lstat(directory); owned(d, 0o700, true); requireValue(sameInode(d, directoryStat));
          if (fileStat) {
            const f = await lstat(file); requireValue(f.isFile() && f.nlink === 1 && f.uid === process.getuid() && sameInode(f, fileStat));
            await unlink(file);
          }
          await rmdir(directory);
        } finally { if (handle) { await handle.close(); handle = null; } }
      // A later mutation can exhaust preparation time; local cleanup has its own bound.
      }, { timeoutMs: packet.limits.readMs, now });
      evidence.cleanup = "removed"; return true;
    } catch { return false; }
  };
  const dispose = () => { disposal ??= cleanup(); return disposal; };
  const verify = async () => {
    checkSignal(); const d = await lstat(directory); owned(d, 0o700, true); requireValue(sameInode(d, directoryStat));
    requireValue(await realpath(directory) === directory && await realpath(file) === file);
    const before = await lstat(file); owned(before, 0o600); requireValue(sameInode(before, fileStat) && before.size === bytes.length);
    const descriptor = await handle.stat(); owned(descriptor, 0o600); requireValue(sameInode(descriptor, before));
    const observed = Buffer.alloc(bytes.length); const read = await handle.read(observed, 0, observed.length, 0);
    const after = await lstat(file); requireValue(sameInode(after, before) && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && read.bytesRead === bytes.length && hash(observed) === hash(bytes));
    checkSignal();
  };
  try {
    checkSignal(); const root = await realpath(parent), parentStat = await lstat(root);
    const parentMode = parentStat.mode & 0o7777;
    requireValue(parentStat.isDirectory() && (parentStat.uid === process.getuid() && parentMode === 0o700 || parentStat.uid === 0 && parentMode === 0o1777));
    directory = await mkdtemp(path.join(root, "ovd419-diagnostic-manifest-")); evidence.directoryCreated = true; evidence.cleanup = "unproved";
    directoryStat = await lstat(directory); owned(directoryStat, 0o700, true); checkSignal();
    file = path.join(directory, "job.json");
    handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    evidence.fileCreated = true; fileStat = await handle.stat(); owned(fileStat, 0o600); checkSignal();
    await handle.writeFile(bytes); await handle.sync(); checkSignal(); await verify();
    return Object.freeze({ path: file, verify, dispose });
  } catch {
    if (directory) await dispose();
    reject();
  }
}
