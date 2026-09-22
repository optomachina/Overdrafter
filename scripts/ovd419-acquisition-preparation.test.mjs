// @vitest-environment node
import { readFileSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compatibilityFixture } from "./ovd419-acquisition-test-fixtures.mjs";
import { fullJobFixtures, fullServiceFixtures, completedExecutionFixtures, prefixEgressFixtures } from "./ovd419-reader-test-fixtures.mjs";
import { digest, TARGET } from "./ovd419-job-diagnostic.mjs";
import { createSyntheticAcquisitionReader, isSyntheticAcquisitionHandoff,
  isSyntheticAcquisitionPreparation, isSyntheticAcquisitionCompletion,
  isSyntheticAcquisitionVerification, SYNTHETIC_ACQUISITION_READER_CONTRACT } from "./ovd419-synthetic-acquisition-reader.mjs";

const filesystemHarness = vi.hoisted(() => ({ original: null, persistenceExpected: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal();
  filesystemHarness.original = original;
  const creation = Object.fromEntries(["mkdir", "mkdtemp", "open", "writeFile", "lstat", "unlink"].map(name =>
    [name, vi.fn((...args) => original[name](...args))]));
  return { ...original, ...creation };
});

const privateSchemaJson = readFileSync(new URL("./ovd419-acquisition-schemas/private-bindings-v2.schema.json", import.meta.url), "utf8");
const receiptSchemaJson = readFileSync(new URL("./ovd419-acquisition-schemas/offline-acquisition-result.schema.json", import.meta.url), "utf8");
const hash = raw => createHash("sha256").update(raw).digest("hex");

// Real validators throughout: combine existing in-memory fixtures and bind the
// completed Execution's historical producer claims to this exact synthetic packet.
function fixture({ mutate = () => {}, totalDurationMs = 900000 } = {}) {
  const e = completedExecutionFixtures.fixture();
  const packet = e.p;
  const job = fullJobFixtures.fixture().value;
  job.metadata.uid = packet.baseline.job.uid;
  job.spec.template.spec.template.spec = structuredClone(e.baseTask);
  const service = fullServiceFixtures.fixture().value;
  service.spec.template.spec.containers[0].env.find(x => x.name === "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES").value = "1000";
  const scope = { bucket: "fixture-bucket", object: "fixture/profile.tar.gz", maxBytes: "1000" };
  const principal = "TEST_ONLY_operator@example.invalid";
  const snapshot = { generation: "1", metageneration: "2", etag: "TEST_ONLY_etag" };
  const identity = value => ({ uid: value.metadata.uid, generation: value.metadata.generation,
    resourceVersion: value.metadata.resourceVersion, configuration: digest({ name: value.metadata.name, spec: value.spec }) });
  packet.baseline.job = identity(job);
  packet.baseline.service = identity(service);
  packet.baseline.snapshot = digest(snapshot);
  packet.baseline.account = digest({ ...scope, principal });
  packet.baseline.inventory = [e.value.metadata.name];
  const candidate = structuredClone(job);
  candidate.spec.template.spec.template.spec.containers[0].image = packet.image;
  packet.candidateConfiguration = digest({ name: candidate.metadata.name, spec: candidate.spec });
  mutate({ job, service, packet, snapshot });
  Object.assign(e.precondition, { packetSha256: digest(packet), snapshotFingerprint: packet.baseline.snapshot,
    jobIdentity: { uid: job.metadata.uid, generation: 2, configurationFingerprint: packet.candidateConfiguration },
    executionInventory: { totalCount: packet.baseline.inventory.length, fingerprint: digest(packet.baseline.inventory) } });
  e.value.spec.template.spec.containers[0].env.find(x => x.name === "OVD419_EXPECTED_PRECONDITIONS_B64").value =
    Buffer.from(JSON.stringify(e.precondition)).toString("base64url");
  const inventory = [{ metadata: { name: e.value.metadata.name, uid: e.value.metadata.uid,
    creationTimestamp: e.value.metadata.creationTimestamp, labels: { "run.googleapis.com/job": TARGET.job } },
  status: { completionTime: e.value.status.completionTime, runningCount: 0 } }];
  const eg = prefixEgressFixtures.compliantEgress();
  eg.service = structuredClone(service); eg.job = structuredClone(job);
  const egress = [eg.service, eg.job, eg.iamPolicy, eg.jobIamPolicy, eg.projectIamPolicy,
    eg.network, eg.subnet, eg.router, eg.nat, eg.address, eg.routes, eg.policyBasedRoutes,
    eg.natMappings, eg.jobExecutions, eg.service, eg.job, eg.router, eg.nat];
  const compatibility = compatibilityFixture();
  const qualification = { mode: "TEST_ONLY", acquisitionSourceCommit: "a".repeat(40),
    inputManifestSha256: "b".repeat(64), invocationId: "TEST_ONLY_preparation" };
  const token = Object.freeze({});
  const preparation = { scope: token, epochMs: Date.parse("2026-09-10T16:00:00.000Z"),
    acquisitionSourceCommit: qualification.acquisitionSourceCommit, inputManifestSha256: qualification.inputManifestSha256,
    packetSha256: digest(packet), privateSchemaJson, receiptSchemaJson };
  let now = 0;
  const transport = vi.fn(async request => {
    let payload;
    if (request.id === "catalogue") payload = compatibility.input.observations[0].payload;
    else if (request.id.startsWith("containment")) payload = compatibility.input.observations[1].payload;
    else if (/^E\d\d$/.test(request.id)) payload = JSON.stringify(egress[Number(request.id.slice(1)) - 1]);
    else if (request.id.startsWith("IAM")) payload = JSON.stringify({ includedPermissions: ["run.jobs.get", "run.executions.list"] });
    else if (request.id.startsWith("principal")) payload = JSON.stringify([{ account: principal, status: "ACTIVE" }]);
    else if (request.id.startsWith("snapshot")) payload = JSON.stringify(snapshot);
    else if (request.id.startsWith("secretVersion")) payload = JSON.stringify({ name: "projects/123456789/secrets/supabase-service-role-key/versions/1", state: "ENABLED" });
    else if (request.id.startsWith("fullJob")) payload = JSON.stringify(job);
    else if (request.id.startsWith("fullService")) payload = JSON.stringify(service);
    else if (request.id.startsWith("fullInventory")) payload = JSON.stringify(inventory);
    else if (request.id.startsWith("completedExecution")) payload = JSON.stringify(e.value);
    else if (request.id === "closingE13") payload = "[]";
    else throw new Error("TEST_ONLY_unexpected_request");
    return JSON.stringify({ schema: SYNTHETIC_ACQUISITION_READER_CONTRACT.responseSchema,
      mode: "TEST_ONLY", id: request.id, sequence: request.sequence, requestSha256: request.requestSha256,
      provenance: request.provenance, complete: true, settled: true, isError: false, payload });
  });
  const input = { transport, qualification, packet, projectNumber: "123456789", snapshotScope: scope,
    secretReference: { name: "supabase-service-role-key", key: "latest" }, preparation,
    clock: Object.freeze({ now: () => now }), totalDurationMs };
  const binding = {
    schema: "OVD419-PRIVATE-BINDING-DATA-NOT-AUTHORITY-v2", capturedAt: "2026-09-10T16:00:00.000Z",
    readPlanSha256: "58f007868ada20901080b914cfeb0c7f90d1169166a62bdb25314a4ea3bc5354",
    baseline: { job: identity(job), service: identity(service), snapshot: digest(snapshot),
      account: digest({ ...scope, principal }), secretVersion: "1", inventory: [e.value.metadata.name],
      controls: digest(JSON.parse(compatibility.input.observations[1].payload)[0].evidence.controls),
      egress: digest({ iamPolicy: eg.iamPolicy, jobIamPolicy: eg.jobIamPolicy, projectIamPolicy: eg.projectIamPolicy,
        network: eg.network, subnet: eg.subnet, router: eg.router, nat: eg.nat, address: eg.address,
        routes: eg.routes, policyBasedRoutes: eg.policyBasedRoutes, confirmRouter: eg.router, confirmNat: eg.nat }) },
    candidateConfiguration: packet.candidateConfiguration, snapshotScope: { ...scope, ...snapshot }, principal,
    resources: { cpu: "2", memory: "4Gi", taskSeconds: 600, tasks: 1, parallelism: 1, retries: 0 },
    compatibility: { catalogue: true, executionRepresentation: true, baselineSafeForTemporaryManifest: true, controlsEncodingVerified: true },
    catalogueFingerprint: digest(JSON.parse(compatibility.input.observations[0].payload)[0].evidence),
    completedExecutionRepresentationFingerprint: hash(JSON.stringify(e.value)),
    acquisitionSourceCommit: qualification.acquisitionSourceCommit,
    diagnosticSourceCommit: "e9c1073c47277f7ba7709655d94d4a399e78fffa",
    inputManifestSha256: qualification.inputManifestSha256,
  };
  return { input, token, transport, setNow: value => { now = value; }, egress, job, packet, binding };
}

afterEach(() => {
  if (!filesystemHarness.persistenceExpected) {
    for (const name of ["mkdir", "mkdtemp", "open", "writeFile"]) expect(filesystem[name]).not.toHaveBeenCalled();
  }
  filesystemHarness.persistenceExpected = false;
  vi.clearAllMocks();
});

describe("private acquisition preparation", () => {
  it("prepares a complete real-validator fixture once without exposing private bytes or creating files", async () => {
    const creation = ["mkdir", "mkdtemp", "open", "writeFile"].map(name => filesystem[name]);
    const f = fixture(); const reader = createSyntheticAcquisitionReader(f.input);
    const handoff = await reader.read();
    const prepared = reader.prepare(handoff, f.token);
    expect(f.transport).toHaveBeenCalledTimes(37);
    expect(prepared).toMatchObject({ mode: "TEST_ONLY", transportQualified: false, privateBindingReady: false });
    expect(prepared.bindingsSha256).toBe(digest(f.binding));
    expect(prepared.bindingsBytes).toBe(Buffer.byteLength(JSON.stringify(f.binding)));
    const expectedReceipt = { schema: "OVD419-SYNTHETIC-ACQUISITION-RESULT-NOT-AUTHORITY-v1", mode: "TEST_ONLY",
      bindingsSha256: digest(f.binding), bindingsBytes: Buffer.byteLength(JSON.stringify(f.binding)),
      acquisitionSourceCommit: f.binding.acquisitionSourceCommit, diagnosticSourceCommit: f.binding.diagnosticSourceCommit,
      inputManifestSha256: f.binding.inputManifestSha256, readPlanSha256: f.binding.readPlanSha256,
      handoffSha256: handoff.handoffSha256, transportQualified: false, privateBindingReady: false };
    expect(prepared.receiptSha256).toBe(digest(expectedReceipt));
    expect(prepared.receiptBytes).toBe(Buffer.byteLength(JSON.stringify(expectedReceipt)));
    expect(prepared.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.bindingsBytes).toBeGreaterThan(1000);
    expect(prepared.bindingsBytes).toBeLessThan(1048576);
    expect(JSON.stringify(prepared)).not.toMatch(/operator|fixture-bucket|profile\.tar|bindingsJson|receiptJson/);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(isSyntheticAcquisitionHandoff(handoff)).toBe(false);
    expect(isSyntheticAcquisitionPreparation(prepared)).toBe(true);
    expect(isSyntheticAcquisitionPreparation({ ...prepared })).toBe(false);
    expect(() => reader.prepare(handoff, f.token)).toThrow("acquisition_fixture_rejected");
    creation.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it("rejects forged/foreign handles without consuming another reader's handle", async () => {
    const a = fixture(); const b = fixture();
    const ra = createSyntheticAcquisitionReader(a.input); const rb = createSyntheticAcquisitionReader(b.input);
    const ha = await ra.read(); const hb = await rb.read();
    expect(() => ra.prepare({ ...ha }, a.token)).toThrow("acquisition_fixture_rejected");
    expect(() => ra.prepare(hb, a.token)).toThrow("acquisition_fixture_rejected");
    expect(isSyntheticAcquisitionPreparation(rb.prepare(hb, b.token))).toBe(true);
    expect(isSyntheticAcquisitionPreparation(ra.prepare(ha, a.token))).toBe(true);
    expect(() => createSyntheticAcquisitionReader(a.input)).toThrow("acquisition_fixture_rejected");
  });

  it("permanently consumes an owned handle when its scope token is wrong", async () => {
    const f = fixture(); const reader = createSyntheticAcquisitionReader(f.input); const h = await reader.read();
    expect(() => reader.prepare(h, {})).toThrow("acquisition_fixture_rejected");
    expect(isSyntheticAcquisitionHandoff(h)).toBe(false);
    expect(() => reader.prepare(h, f.token)).toThrow("acquisition_fixture_rejected");
  });

  it.each([{ now: 30001, totalDurationMs: 900000 }, { now: 1000, totalDurationMs: 1000 }])(
    "keeps the original clock when its method is replaced (%j)", async ({ now, totalDurationMs }) => {
      const f = fixture({ totalDurationMs });
      f.input.clock = { ...f.input.clock };
      const reader = createSyntheticAcquisitionReader(f.input); const h = await reader.read();
      f.setNow(now);
      const replacement = vi.fn(() => 0);
      f.input.clock.now = replacement;
      expect(() => reader.prepare(h, f.token)).toThrow("acquisition_fixture_rejected");
      expect(replacement).not.toHaveBeenCalled();
      expect(isSyntheticAcquisitionHandoff(h)).toBe(false);
    });

  it.each([30000.1, -1, NaN, Infinity])("rejects stale or invalid clocks (%s) and permanently consumes the attempt", async now => {
    const f = fixture(); const reader = createSyntheticAcquisitionReader(f.input); const h = await reader.read();
    f.setNow(now);
    expect(() => reader.prepare(h, f.token)).toThrow("acquisition_fixture_rejected");
    f.setNow(0);
    expect(() => reader.prepare(h, f.token)).toThrow("acquisition_fixture_rejected");
  });

  it("accepts the freshness boundary but rejects the original deadline boundary", async () => {
    const f = fixture(); const reader = createSyntheticAcquisitionReader(f.input); const h = await reader.read();
    f.setNow(30000); expect(isSyntheticAcquisitionPreparation(reader.prepare(h, f.token))).toBe(true);
    const d = fixture({ totalDurationMs: 1000 }); const rd = createSyntheticAcquisitionReader(d.input); const hd = await rd.read();
    d.setNow(1000); expect(() => rd.prepare(hd, d.token)).toThrow("acquisition_fixture_rejected");
  });

  it.each(["privateSchemaJson", "receiptSchemaJson", "packetSha256", "acquisitionSourceCommit", "inputManifestSha256"])("rejects changed qualified %s before transport", field => {
    const f = fixture(); f.input.preparation[field] += " ";
    expect(() => createSyntheticAcquisitionReader(f.input)).toThrow("acquisition_fixture_rejected");
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("does not repair a wrong candidate digest, and burns preparation on rejection", async () => {
    const f = fixture({ mutate: ({ packet }) => { packet.candidateConfiguration = "c".repeat(64); } });
    const reader = createSyntheticAcquisitionReader(f.input); const h = await reader.read();
    expect(() => reader.prepare(h, f.token)).toThrow("acquisition_fixture_rejected");
    expect(isSyntheticAcquisitionHandoff(h)).toBe(false);
  });

  it("checks the baseline digest independently when candidate and baseline images match", async () => {
    const f = fixture({ mutate: ({ packet, job }) => {
      packet.image = packet.baselineImage;
      packet.candidateConfiguration = digest({ name: job.metadata.name, spec: job.spec });
      packet.baseline.job.configuration = "c".repeat(64);
    } });
    const reader = createSyntheticAcquisitionReader(f.input); const h = await reader.read();
    expect(() => reader.prepare(h, f.token)).toThrow("acquisition_fixture_rejected");
    expect(isSyntheticAcquisitionHandoff(h)).toBe(false);
  });

  it("rejects prefix/full-resource version drift at preparation", async () => {
    const f = fixture(); f.egress[0].metadata.resourceVersion = "TEST_ONLY_old";
    const reader = createSyntheticAcquisitionReader(f.input); const h = await reader.read();
    expect(() => reader.prepare(h, f.token)).toThrow("acquisition_fixture_rejected");
  });

  it("pins the vendored schema bytes and does not permit unqualified reader preparation", async () => {
    expect(hash(privateSchemaJson)).toBe("2321e4c430ba7d50eca583a1c31709df5e115d9a23bcbc43ea490779d038471f");
    expect(hash(receiptSchemaJson)).toBe("24719b225bd01ea150ab66afa2322a3b41f0ab85065cd9420796671437c89cc7");
    const f = fixture(); delete f.input.preparation;
    const reader = createSyntheticAcquisitionReader(f.input); const h = await reader.read();
    expect(() => reader.prepare(h, f.token)).toThrow("acquisition_fixture_rejected");
  });
});

async function persistenceFixture(options = {}) {
  filesystemHarness.persistenceExpected = true;
  const temporaryRoot = await filesystem.mkdtemp(join(tmpdir(), "ovd516-fixture-"));
  const root = await filesystem.realpath(temporaryRoot);
  await filesystem.chmod(root, 0o700);
  const f = fixture(options);
  const reader = createSyntheticAcquisitionReader(f.input);
  const handoff = await reader.read();
  const prepared = reader.prepare(handoff, f.token);
  return { f, reader, prepared, root };
}

async function removePersistenceRoot(root) {
  await filesystemHarness.original.rm(root, { recursive: true, force: true });
}

describe("private acquisition filesystem persistence", () => {
  it("writes an exact private pair and requires the live completion for fresh verification", async () => {
    const { f, reader, prepared, root } = await persistenceFixture();
    try {
      const completion = await reader.persist(prepared, f.token, root);
      expect(completion).toMatchObject({ mode: "TEST_ONLY", transportQualified: false, privateBindingReady: false });
      expect(isSyntheticAcquisitionCompletion(completion)).toBe(true);
      expect(isSyntheticAcquisitionCompletion({ ...completion })).toBe(false);

      const children = await filesystem.readdir(root);
      expect(children).toHaveLength(1);
      const child = join(root, children[0]);
      expect((await filesystem.lstat(child)).mode & 0o777).toBe(0o700);
      expect((await filesystem.readdir(child)).sort()).toEqual(["bindings.json", "receipt.json"]);
      for (const name of ["bindings.json", "receipt.json"]) {
        expect((await filesystem.lstat(join(child, name))).mode & 0o777).toBe(0o600);
      }
      const bindings = await filesystem.readFile(join(child, "bindings.json"), "utf8");
      const receipt = await filesystem.readFile(join(child, "receipt.json"), "utf8");
      expect(hash(bindings)).toBe(prepared.bindingsSha256);
      expect(hash(receipt)).toBe(prepared.receiptSha256);
      expect(JSON.parse(receipt)).toMatchObject({ bindingsSha256: prepared.bindingsSha256,
        transportQualified: false, privateBindingReady: false });
      expect(receipt).not.toMatch(/operator|fixture-bucket|profile\.tar|secret/i);

      const verified = await reader.verify(completion, f.token);
      expect(verified).toMatchObject({ mode: "TEST_ONLY", bindingsSha256: prepared.bindingsSha256,
        receiptSha256: prepared.receiptSha256, transportQualified: false, privateBindingReady: false });
      expect(isSyntheticAcquisitionVerification(verified)).toBe(true);
      expect(isSyntheticAcquisitionVerification({ ...verified })).toBe(false);
    } finally { await removePersistenceRoot(root); }
  });

  it("does not expose a raw filesystem writer entrypoint", async () => {
    const readerModule = await import("./ovd419-synthetic-acquisition-reader.mjs");
    expect(readerModule).not.toHaveProperty("persistAcquisitionFixture");
    expect(readerModule).not.toHaveProperty("verifyAcquisitionFixture");
    await expect(import("./ovd419-acquisition-fixture-writer.mjs?must-remain-private"))
      .rejects.toThrow();
  });

  it("rejects forged and reused preparations without creating another child", async () => {
    const { f, reader, prepared, root } = await persistenceFixture();
    try {
      await expect(reader.persist({ ...prepared }, f.token, root)).rejects.toThrow("acquisition_fixture_rejected");
      expect(await filesystem.readdir(root)).toEqual([]);
      await reader.persist(prepared, f.token, root);
      await expect(reader.persist(prepared, f.token, root)).rejects.toThrow("acquisition_fixture_rejected");
      expect(await filesystem.readdir(root)).toHaveLength(1);
    } finally { await removePersistenceRoot(root); }
  });

  it("admits at most one concurrent persistence claim", async () => {
    const { f, reader, prepared, root } = await persistenceFixture();
    try {
      const first = reader.persist(prepared, f.token, root);
      const second = reader.persist(prepared, f.token, root);
      await expect(second).rejects.toThrow("acquisition_fixture_rejected");
      expect(isSyntheticAcquisitionCompletion(await first)).toBe(true);
      expect(await filesystem.readdir(root)).toHaveLength(1);
    } finally { await removePersistenceRoot(root); }
  });

  it("preserves a colliding completed child byte-for-byte", async () => {
    const first = await persistenceFixture();
    try {
      await first.reader.persist(first.prepared, first.f.token, first.root);
      const child = join(first.root, (await filesystem.readdir(first.root))[0]);
      const before = Object.fromEntries(await Promise.all(["bindings.json", "receipt.json"].map(async name =>
        [name, await filesystem.readFile(join(child, name), "utf8")] )));
      const second = fixture();
      const reader = createSyntheticAcquisitionReader(second.input);
      const prepared = reader.prepare(await reader.read(), second.token);
      await expect(reader.persist(prepared, second.token, first.root)).rejects.toThrow("acquisition_fixture_rejected");
      expect(await filesystem.readFile(join(child, "bindings.json"), "utf8")).toBe(before["bindings.json"]);
      expect(await filesystem.readFile(join(child, "receipt.json"), "utf8")).toBe(before["receipt.json"]);
    } finally { await removePersistenceRoot(first.root); }
  });

  it("cleans its settled partial write after an injected receipt-open failure", async () => {
    const { f, reader, prepared, root } = await persistenceFixture();
    const originalOpen = filesystemHarness.original.open;
    filesystem.open.mockImplementation(async (path, ...args) => {
      if (basename(path) === "receipt.json") throw new Error("TEST_ONLY_receipt_open_failed");
      return originalOpen(path, ...args);
    });
    try {
      await expect(reader.persist(prepared, f.token, root)).rejects.toThrow("acquisition_fixture_rejected");
      expect(await filesystem.readdir(root)).toEqual([]);
    } finally { await removePersistenceRoot(root); }
  });

  it.each([
    ["bindings.json", "writeFile", "acquisition_fixture_rejected"],
    ["bindings.json", "sync", "acquisition_fixture_rejected"],
    ["bindings.json", "read", "acquisition_fixture_rejected"],
    ["receipt.json", "writeFile", "acquisition_fixture_rejected"],
    ["receipt.json", "sync", "acquisition_fixture_rejected"],
    ["receipt.json", "close", "cleanup_unproved"],
  ])("never returns completion after a settled %s %s failure", async (file, method, errorCode) => {
    const { f, reader, prepared, root } = await persistenceFixture();
    const originalOpen = filesystemHarness.original.open;
    let injected = false;
    filesystem.open.mockImplementation(async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (basename(path) !== file || injected) return handle;
      return new Proxy(handle, { get(target, property) {
        if (property === method) return async (...methodArgs) => {
          injected = true;
          if (method === "writeFile") {
            await target.writeFile("TEST_ONLY_partial", { encoding: "utf8" });
          }
          if (method === "close") await target.close();
          throw new Error(`TEST_ONLY_${method}_failed`);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    try {
      await expect(reader.persist(prepared, f.token, root)).rejects.toThrow(errorCode);
      expect(injected).toBe(true);
      if (errorCode === "cleanup_unproved") {
        expect(await filesystem.readdir(root)).toHaveLength(1);
      } else {
        expect(await filesystem.readdir(root)).toEqual([]);
      }
      expect(filesystem.mkdir).toHaveBeenCalledTimes(1);
      expect(isSyntheticAcquisitionCompletion(prepared)).toBe(false);
    } finally {
      filesystem.open.mockImplementation((...args) => originalOpen(...args));
      await removePersistenceRoot(root);
    }
  });

  it("rechecks the original clock before creation", async () => {
    const { f, reader, prepared, root } = await persistenceFixture();
    try {
      f.setNow(30000.1);
      await expect(reader.persist(prepared, f.token, root)).rejects.toThrow("acquisition_fixture_rejected");
      expect(await filesystem.readdir(root)).toEqual([]);
    } finally { await removePersistenceRoot(root); }
  });

  it("applies closing freshness only at writer admission while retaining the original deadline", async () => {
    const { f, reader, prepared, root } = await persistenceFixture();
    const originalMkdir = filesystemHarness.original.mkdir;
    f.setNow(29999);
    filesystem.mkdir.mockImplementation(async (...args) => {
      const result = await originalMkdir(...args);
      f.setNow(30001);
      return result;
    });
    try {
      expect(isSyntheticAcquisitionCompletion(await reader.persist(prepared, f.token, root))).toBe(true);
    } finally { await removePersistenceRoot(root); }
  });

  it("reports cleanup_unproved when child creation succeeds but identity capture fails", async () => {
    const { f, reader, prepared, root } = await persistenceFixture();
    const originalLstat = filesystemHarness.original.lstat;
    let injected = false;
    filesystem.lstat.mockImplementation(async (path, ...args) => {
      if (!injected && basename(path).startsWith("ovd419-acquisition-")) {
        injected = true;
        throw new Error("TEST_ONLY_child_lstat_failed");
      }
      return originalLstat(path, ...args);
    });
    try {
      await expect(reader.persist(prepared, f.token, root)).rejects.toThrow("cleanup_unproved");
      expect(injected).toBe(true);
      expect(await filesystem.readdir(root)).toHaveLength(1);
    } finally { await removePersistenceRoot(root); }
  });

  it("requires the retained child directory descriptor to close before settlement", async () => {
    const { f, reader, prepared, root } = await persistenceFixture();
    const originalOpen = filesystemHarness.original.open;
    let injected = false;
    filesystem.open.mockImplementation(async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (injected || !basename(path).startsWith("ovd419-acquisition-")) return handle;
      injected = true;
      return new Proxy(handle, { get(target, property) {
        if (property === "close") return async () => {
          await target.close();
          throw new Error("TEST_ONLY_directory_close_failed");
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    try {
      await expect(reader.persist(prepared, f.token, root)).rejects.toThrow("cleanup_unproved");
      expect(injected).toBe(true);
      expect(await filesystem.readdir(root)).toHaveLength(1);
    } finally { await removePersistenceRoot(root); }
  });

  it("closes a file handle that arrives after its bounded open times out", async () => {
    const { f, reader, prepared, root } = await persistenceFixture({ totalDurationMs: 100 });
    const originalOpen = filesystemHarness.original.open;
    const close = vi.fn();
    let delayed = false;
    filesystem.open.mockImplementation(async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (delayed || basename(path) !== "bindings.json") return handle;
      delayed = true;
      const proxy = new Proxy(handle, { get(target, property) {
        if (property === "close") return async () => { close(); await target.close(); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      await new Promise(resolve => setTimeout(resolve, 150));
      return proxy;
    });
    try {
      await expect(reader.persist(prepared, f.token, root)).rejects.toThrow("cleanup_unproved");
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1), { timeout: 500 });
    } finally { await removePersistenceRoot(root); }
  });

  it("refuses settlement when directory close crosses the original deadline", async () => {
    const { f, reader, prepared, root } = await persistenceFixture({ totalDurationMs: 1000 });
    const originalOpen = filesystemHarness.original.open;
    let injected = false;
    filesystem.open.mockImplementation(async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (injected || !basename(path).startsWith("ovd419-acquisition-")) return handle;
      injected = true;
      return new Proxy(handle, { get(target, property) {
        if (property === "close") return async () => { await target.close(); f.setNow(1000); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    try {
      await expect(reader.persist(prepared, f.token, root)).rejects.toThrow("cleanup_unproved");
      expect(injected).toBe(true);
    } finally { await removePersistenceRoot(root); }
  });

  it("uses one fixed cleanup deadline across the entire cleanup attempt", async () => {
    const { f, reader, prepared, root } = await persistenceFixture();
    const originalOpen = filesystemHarness.original.open;
    const originalUnlink = filesystemHarness.original.unlink;
    let injected = false;
    filesystem.open.mockImplementation(async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (basename(path) !== "receipt.json" || injected) return handle;
      return new Proxy(handle, { get(target, property) {
        if (property === "sync") return async () => {
          injected = true;
          f.setNow(10);
          throw new Error("TEST_ONLY_receipt_sync_failed");
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    filesystem.unlink.mockImplementation(async (...args) => {
      const result = await originalUnlink(...args);
      f.setNow(30010);
      return result;
    });
    try {
      await expect(reader.persist(prepared, f.token, root)).rejects.toThrow("cleanup_unproved");
      const child = join(root, (await filesystem.readdir(root))[0]);
      expect(await filesystem.readdir(child)).toEqual(["bindings.json"]);
    } finally { await removePersistenceRoot(root); }
  });

  it("rejects a non-private root and a wrong scope with zero creation", async () => {
    const wrongRoot = await persistenceFixture();
    try {
      await filesystem.chmod(wrongRoot.root, 0o755);
      await expect(wrongRoot.reader.persist(wrongRoot.prepared, wrongRoot.f.token, wrongRoot.root))
        .rejects.toThrow("acquisition_fixture_rejected");
      expect(await filesystem.readdir(wrongRoot.root)).toEqual([]);
    } finally { await removePersistenceRoot(wrongRoot.root); }

    const wrongScope = await persistenceFixture();
    try {
      await expect(wrongScope.reader.persist(wrongScope.prepared, {}, wrongScope.root))
        .rejects.toThrow("acquisition_fixture_rejected");
      await expect(wrongScope.reader.persist(wrongScope.prepared, wrongScope.f.token, wrongScope.root))
        .rejects.toThrow("acquisition_fixture_rejected");
      expect(await filesystem.readdir(wrongScope.root)).toEqual([]);
    } finally { await removePersistenceRoot(wrongScope.root); }
  });

  it("rejects a symlink root before creating a child", async () => {
    const value = await persistenceFixture();
    const link = `${value.root}-link`;
    await filesystem.symlink(value.root, link);
    try {
      await expect(value.reader.persist(value.prepared, value.f.token, link))
        .rejects.toThrow("acquisition_fixture_rejected");
      expect(await filesystem.readdir(value.root)).toEqual([]);
      expect(filesystem.mkdir).not.toHaveBeenCalled();
    } finally {
      await filesystem.unlink(link);
      await removePersistenceRoot(value.root);
    }
  });

  it("fails closed without cleanup when a filesystem operation never settles", async () => {
    const { f, reader, prepared, root } = await persistenceFixture({ totalDurationMs: 100 });
    const originalOpen = filesystemHarness.original.open;
    filesystem.open.mockImplementation((path, ...args) => {
      if (basename(path) === "receipt.json") return new Promise(() => {});
      return originalOpen(path, ...args);
    });
    try {
      await expect(reader.persist(prepared, f.token, root)).rejects.toThrow("cleanup_unproved");
      const children = await filesystem.readdir(root);
      expect(children).toHaveLength(1);
      expect(await filesystem.readdir(join(root, children[0]))).toEqual(["bindings.json"]);
    } finally { await removePersistenceRoot(root); }
  });

  it("rejects post-success byte tampering during fresh verification", async () => {
    const { f, reader, prepared, root } = await persistenceFixture();
    try {
      const completion = await reader.persist(prepared, f.token, root);
      const child = join(root, (await filesystem.readdir(root))[0]);
      await filesystem.writeFile(join(child, "receipt.json"), "{}", { mode: 0o600 });
      await expect(reader.verify(completion, f.token)).rejects.toThrow("acquisition_fixture_rejected");
      expect(isSyntheticAcquisitionCompletion(completion)).toBe(false);
    } finally { await removePersistenceRoot(root); }
  });

  it("preserves cleanup_unproved when fresh verification I/O never settles", async () => {
    const { f, reader, prepared, root } = await persistenceFixture({ totalDurationMs: 100 });
    const originalOpen = filesystemHarness.original.open;
    try {
      const completion = await reader.persist(prepared, f.token, root);
      filesystem.open.mockImplementation((path, ...args) => {
        if (basename(path) === "receipt.json") return new Promise(() => {});
        return originalOpen(path, ...args);
      });
      await expect(reader.verify(completion, f.token)).rejects.toThrow("cleanup_unproved");
    } finally { await removePersistenceRoot(root); }
  });

  it("rejects semantically equivalent but byte-reordered receipt content", async () => {
    const { f, reader, prepared, root } = await persistenceFixture();
    try {
      const completion = await reader.persist(prepared, f.token, root);
      const child = join(root, (await filesystem.readdir(root))[0]);
      const receiptPath = join(child, "receipt.json");
      const receipt = JSON.parse(await filesystem.readFile(receiptPath, "utf8"));
      const reordered = JSON.stringify(Object.fromEntries(Object.entries(receipt).reverse()));
      expect(JSON.parse(reordered)).toEqual(receipt);
      await filesystem.writeFile(receiptPath, reordered, { mode: 0o600 });
      await expect(reader.verify(completion, f.token)).rejects.toThrow("acquisition_fixture_rejected");
    } finally { await removePersistenceRoot(root); }
  });
});
