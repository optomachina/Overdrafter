import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import * as filesystem from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
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
const PRIVATE_COMPLETIONS = new WeakMap();
const PRIVATE_VERIFICATIONS = new WeakSet();
const CLAIMED_SCOPES = new WeakSet();
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const fail = code => { throw new Error(code); };
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const BINDINGS_NAME = "bindings.json";
const RECEIPT_NAME = "receipt.json";
const fileMode = stat => stat.mode & 0o777;
class UnsettledFilesystemError extends Error {
  constructor() { super("cleanup_unproved"); }
}

function currentUid() {
  if (typeof process.getuid !== "function") fail("acquisition_fixture_rejected");
  return process.getuid();
}

function checkPersistenceTime(record, entry = false) {
  const now = record.current();
  if (!Number.isFinite(now) || now < record.closingObservedAt) fail("acquisition_fixture_rejected");
  if (now >= record.deadline) throw new UnsettledFilesystemError();
  if (entry && now - record.closingObservedAt > 30000) fail("acquisition_fixture_rejected");
  return now;
}

async function boundedFilesystem(record, action, disposeLate) {
  const started = checkPersistenceTime(record);
  const remaining = Math.floor(record.deadline - started);
  if (remaining < 1) throw new UnsettledFilesystemError();
  let timer;
  let timedOut = false;
  const operation = Promise.resolve().then(action).then(async value => {
    if (timedOut && disposeLate) await disposeLate(value);
    return value;
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new UnsettledFilesystemError());
    }, Math.min(remaining, 30000));
  });
  try { return await Promise.race([operation, timeout]); }
  catch (error) {
    operation.catch(() => {});
    throw error;
  } finally { clearTimeout(timer); }
}

async function disposeLateHandle(handle) {
  if (!handle) return;
  let timer;
  const close = Promise.resolve().then(() => handle.close());
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new UnsettledFilesystemError()), 30000);
  });
  try { await Promise.race([close, timeout]); }
  catch { close.catch(() => {}); throw new UnsettledFilesystemError(); }
  finally { clearTimeout(timer); }
}

async function closeOwnedHandle(record, handle) {
  if (!handle) return;
  let expired = false;
  let remaining = 1;
  try {
    const now = checkPersistenceTime(record);
    remaining = Math.max(1, Math.min(30000, Math.floor(record.deadline - now)));
  } catch { expired = true; }
  let timer;
  const close = Promise.resolve().then(() => handle.close());
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new UnsettledFilesystemError()), remaining);
  });
  try { await Promise.race([close, timeout]); }
  catch { close.catch(() => {}); throw new UnsettledFilesystemError(); }
  finally { clearTimeout(timer); }
  if (expired) throw new UnsettledFilesystemError();
  checkPersistenceTime(record);
}

async function closePrivateDirectories(record, rootHandle, childHandle) {
  let failed = false;
  for (const handle of [childHandle, rootHandle]) {
    try { await closeOwnedHandle(record, handle); }
    catch { failed = true; }
  }
  if (failed) throw new UnsettledFilesystemError();
}

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function validPrivateDirectory(stat, uid) {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid &&
    fileMode(stat) === PRIVATE_DIRECTORY_MODE;
}

function validPrivateFile(stat, identity, bytes, uid) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1 &&
    fileMode(stat) === PRIVATE_FILE_MODE && stat.size === bytes && sameFilesystemIdentity(stat, identity);
}

async function readPrivateHandle(handle, bytes) {
  const output = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const result = await handle.read(output, offset, bytes - offset, offset);
    if (result.bytesRead === 0) fail("acquisition_fixture_rejected");
    offset += result.bytesRead;
  }
  return output.toString("utf8");
}

async function openPrivateDirectory(record, path, uid) {
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const handle = await boundedFilesystem(record, () => filesystem.open(path, flags), disposeLateHandle);
  try {
    const identity = await boundedFilesystem(record, () => handle.stat());
    if (!validPrivateDirectory(identity, uid)) fail("acquisition_fixture_rejected");
    return { handle, identity };
  } catch (error) {
    await closeOwnedHandle(record, handle);
    throw error;
  }
}

async function inspectPrivateRoot(record, rootPath) {
  if (typeof rootPath !== "string" || rootPath.includes("\0") || !isAbsolute(rootPath) ||
      normalize(rootPath) !== rootPath) fail("acquisition_fixture_rejected");
  const uid = currentUid();
  const pathIdentity = await boundedFilesystem(record, () => filesystem.lstat(rootPath));
  const canonical = await boundedFilesystem(record, () => filesystem.realpath(rootPath));
  if (canonical !== rootPath || !validPrivateDirectory(pathIdentity, uid)) fail("acquisition_fixture_rejected");
  const opened = await openPrivateDirectory(record, rootPath, uid);
  if (!sameFilesystemIdentity(pathIdentity, opened.identity)) {
    await closeOwnedHandle(record, opened.handle);
    fail("acquisition_fixture_rejected");
  }
  return { path: rootPath, uid, identity: pathIdentity, handle: opened.handle };
}

async function inspectPrivateDirectory(record, root, path, identity, handle) {
  const descriptorIdentity = await boundedFilesystem(record, () => handle.stat());
  const pathIdentity = await boundedFilesystem(record, () => filesystem.lstat(path));
  const canonical = await boundedFilesystem(record, () => filesystem.realpath(path));
  const rootDescriptor = await boundedFilesystem(record, () => root.handle.stat());
  const rootPath = await boundedFilesystem(record, () => filesystem.lstat(root.path));
  if (canonical !== path || !validPrivateDirectory(pathIdentity, root.uid) ||
      !sameFilesystemIdentity(pathIdentity, identity) || !sameFilesystemIdentity(descriptorIdentity, identity) ||
      !validPrivateDirectory(rootDescriptor, root.uid) || !sameFilesystemIdentity(rootDescriptor, root.identity) ||
      !validPrivateDirectory(rootPath, root.uid) || !sameFilesystemIdentity(rootPath, root.identity)) {
    fail("acquisition_fixture_rejected");
  }
}

async function verifyPrivateFile(record, path, expected, identity) {
  const bytes = Buffer.byteLength(expected, "utf8");
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await boundedFilesystem(record, () => filesystem.open(path, flags), disposeLateHandle);
  let failure;
  try {
    const stat = await boundedFilesystem(record, () => handle.stat());
    if (!validPrivateFile(stat, identity, bytes, currentUid())) fail("acquisition_fixture_rejected");
    if (await boundedFilesystem(record, () => readPrivateHandle(handle, bytes)) !== expected) {
      fail("acquisition_fixture_rejected");
    }
  } catch (error) { failure = error; }
  await closeOwnedHandle(record, handle);
  if (failure) throw failure;
  const pathIdentity = await boundedFilesystem(record, () => filesystem.lstat(path));
  if (!validPrivateFile(pathIdentity, identity, bytes, currentUid())) fail("acquisition_fixture_rejected");
}

async function createPrivateFile(record, path, expected, created) {
  const bytes = Buffer.byteLength(expected, "utf8");
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0);
  const handle = await boundedFilesystem(record, () => filesystem.open(path, flags, PRIVATE_FILE_MODE), disposeLateHandle);
  let identity;
  let failure;
  created.unknownOpen = true;
  try {
    identity = await boundedFilesystem(record, () => handle.stat());
    created.files.set(path, identity);
    created.unknownOpen = false;
    if (!validPrivateFile(identity, identity, 0, currentUid())) fail("acquisition_fixture_rejected");
    await boundedFilesystem(record, () => handle.writeFile(expected, { encoding: "utf8" }));
    const beforeSync = await boundedFilesystem(record, () => handle.stat());
    if (!validPrivateFile(beforeSync, identity, bytes, currentUid()) ||
        await boundedFilesystem(record, () => readPrivateHandle(handle, bytes)) !== expected) {
      fail("acquisition_fixture_rejected");
    }
    await boundedFilesystem(record, () => handle.sync());
    const afterSync = await boundedFilesystem(record, () => handle.stat());
    if (!validPrivateFile(afterSync, identity, bytes, currentUid()) ||
        await boundedFilesystem(record, () => readPrivateHandle(handle, bytes)) !== expected) {
      fail("acquisition_fixture_rejected");
    }
  } catch (error) { failure = error; }
  await closeOwnedHandle(record, handle);
  if (failure) throw failure;
  await verifyPrivateFile(record, path, expected, identity);
  return identity;
}

async function cleanupPrivateCreation(record, created) {
  if (created.unknownOpen || (created.directoryAttempted && !created.directory)) {
    throw new UnsettledFilesystemError();
  }
  try {
    const failureTime = checkPersistenceTime(record);
    const cleanupRecord = { ...record, deadline: Math.min(record.deadline, failureTime + 30000) };
    for (const [path, identity] of [...created.files.entries()].reverse()) {
      const stat = await boundedFilesystem(cleanupRecord, () => filesystem.lstat(path));
      if (!validPrivateFile(stat, identity, stat.size, currentUid())) throw new UnsettledFilesystemError();
      await boundedFilesystem(cleanupRecord, () => filesystem.unlink(path));
    }
    if (created.directory) {
      const stat = await boundedFilesystem(cleanupRecord, () => filesystem.lstat(created.path));
      if (!validPrivateDirectory(stat, currentUid()) || !sameFilesystemIdentity(stat, created.directory)) {
        throw new UnsettledFilesystemError();
      }
      if ((await boundedFilesystem(cleanupRecord, () => filesystem.readdir(created.path))).length !== 0) {
        throw new UnsettledFilesystemError();
      }
      await boundedFilesystem(cleanupRecord, () => filesystem.rmdir(created.path));
    }
  } catch { throw new UnsettledFilesystemError(); }
}

async function verifyPrivatePair(record) {
  const root = await inspectPrivateRoot(record, record.root.path);
  let child;
  let failure;
  try {
    if (!sameFilesystemIdentity(root.identity, record.root.identity)) fail("acquisition_fixture_rejected");
    child = await openPrivateDirectory(record, record.path, root.uid);
    if (!sameFilesystemIdentity(child.identity, record.directory)) fail("acquisition_fixture_rejected");
    await inspectPrivateDirectory(record, root, record.path, record.directory, child.handle);
    await verifyPrivateFile(record, join(record.path, BINDINGS_NAME), record.data.bindingsJson, record.bindingsIdentity);
    await verifyPrivateFile(record, join(record.path, RECEIPT_NAME), record.data.receiptJson, record.receiptIdentity);
    await inspectPrivateDirectory(record, root, record.path, record.directory, child.handle);
    checkPersistenceTime(record);
  } catch (error) { failure = error; }
  try { await closePrivateDirectories(record, root.handle, child?.handle); }
  catch (error) { failure = error; }
  if (failure) throw failure;
}

async function persistPrivateAcquisitionFixture(record, rootPath) {
  const created = { directoryAttempted: false, directory: null, path: null, files: new Map(), unknownOpen: false };
  let root;
  let child;
  try {
    checkPersistenceTime(record, true);
    root = await inspectPrivateRoot(record, rootPath);
    const childName = `ovd419-acquisition-${record.data.receiptSha256.slice(0, 24)}`;
    created.path = join(root.path, childName);
    await boundedFilesystem(record, () => filesystem.mkdir(created.path, { mode: PRIVATE_DIRECTORY_MODE }));
    created.directoryAttempted = true;
    created.directory = await boundedFilesystem(record, () => filesystem.lstat(created.path));
    if (!validPrivateDirectory(created.directory, root.uid)) fail("acquisition_fixture_rejected");
    child = await openPrivateDirectory(record, created.path, root.uid);
    if (!sameFilesystemIdentity(child.identity, created.directory)) fail("acquisition_fixture_rejected");
    await inspectPrivateDirectory(record, root, created.path, created.directory, child.handle);
    const bindingsIdentity = await createPrivateFile(record, join(created.path, BINDINGS_NAME), record.data.bindingsJson, created);
    const receiptIdentity = await createPrivateFile(record, join(created.path, RECEIPT_NAME), record.data.receiptJson, created);
    const persisted = Object.freeze({ ...record, root: { path: root.path, uid: root.uid, identity: root.identity },
      path: created.path, directory: created.directory, bindingsIdentity, receiptIdentity });
    await verifyPrivateFile(record, join(created.path, BINDINGS_NAME), record.data.bindingsJson, bindingsIdentity);
    await verifyPrivateFile(record, join(created.path, RECEIPT_NAME), record.data.receiptJson, receiptIdentity);
    await inspectPrivateDirectory(record, root, created.path, created.directory, child.handle);
    const closingChild = child; child = null;
    const closingRoot = root; root = null;
    await closePrivateDirectories(record, closingRoot.handle, closingChild.handle);
    await verifyPrivatePair(persisted);
    return persisted;
  } catch (error) {
    try { await closePrivateDirectories(record, root?.handle, child?.handle); }
    catch { throw new UnsettledFilesystemError(); }
    if (error instanceof UnsettledFilesystemError) throw error;
    if (created.directoryAttempted) await cleanupPrivateCreation(record, created);
    fail("acquisition_fixture_rejected");
  }
}

async function verifyPrivateAcquisitionFixture(record) {
  try {
    await verifyPrivatePair(record);
    return true;
  } catch (error) {
    if (error instanceof UnsettledFilesystemError) throw error;
    fail("acquisition_fixture_rejected");
  }
}
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

function validateResponse(raw, request, maximumPayloadBytes, maximumResponseBytes) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maximumResponseBytes) {
    fail("invalid_acquisition_response");
  }
  let response;
  try { response = parseBoundedSqlJson(raw, maximumResponseBytes); }
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

/** Membership only: a completion still requires fresh exact-pair verification. */
export function isSyntheticAcquisitionCompletion(value) {
  return value !== null && typeof value === "object" && PRIVATE_COMPLETIONS.has(value);
}

/** Membership only for a fresh, same-process verification result. */
export function isSyntheticAcquisitionVerification(value) {
  return value !== null && typeof value === "object" && PRIVATE_VERIFICATIONS.has(value);
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
    /** Consume one prepared capability and persist its exact TEST_ONLY pair. */
    async persist(prepared, scope, root) {
      const retained = PRIVATE_PREPARATIONS.get(prepared);
      if (retained?.owner !== owner) fail("acquisition_fixture_rejected");
      PRIVATE_PREPARATIONS.delete(prepared);
      if (scope !== retained.qualified.scope) fail("acquisition_fixture_rejected");
      let persisted;
      try {
        persisted = await persistPrivateAcquisitionFixture(retained, root);
      } catch (error) {
        if (error?.message === "cleanup_unproved") fail("cleanup_unproved");
        fail("acquisition_fixture_rejected");
      }
      const result = Object.freeze({ schema: "OVD419-SYNTHETIC-SETTLED-FIXTURE-NOT-AUTHORITY-v1",
        mode: "TEST_ONLY", bindingsSha256: retained.data.bindingsSha256,
        bindingsBytes: retained.data.bindingsBytes, receiptSha256: retained.data.receiptSha256,
        receiptBytes: retained.data.receiptBytes, transportQualified: false, privateBindingReady: false });
      PRIVATE_COMPLETIONS.set(result, Object.freeze({ ...persisted, owner }));
      return result;
    },
    /** Consume one live completion and freshly verify its exact private pair. */
    async verify(completion, scope) {
      const retained = PRIVATE_COMPLETIONS.get(completion);
      if (retained?.owner !== owner) fail("acquisition_fixture_rejected");
      PRIVATE_COMPLETIONS.delete(completion);
      if (scope !== retained.qualified.scope) fail("acquisition_fixture_rejected");
      await verifyPrivateAcquisitionFixture(retained);
      const result = Object.freeze({ schema: "OVD419-SYNTHETIC-VERIFIED-FIXTURE-NOT-AUTHORITY-v1",
        mode: "TEST_ONLY", bindingsSha256: retained.data.bindingsSha256,
        bindingsBytes: retained.data.bindingsBytes, receiptSha256: retained.data.receiptSha256,
        receiptBytes: retained.data.receiptBytes, transportQualified: false, privateBindingReady: false });
      PRIVATE_VERIFICATIONS.add(result);
      return result;
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
          const response = validateResponse(raw, request, maximumPayloadBytes, maximumResponseBytes);
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
