// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateNativeArtifactHandler } from "./native-artifact-runtime";
import { PREPARE_NATIVE_ARTIFACT_OUTPUTS_SQL } from "./native-artifact-mapping";
import { ARTIFACT_ISOLATION_SQL, ARTIFACT_ATTEMPT_LOCK_SQL, ARTIFACT_AUTHORITY_LOCK_SQL, ARTIFACT_STORAGE_LOCK_SQL, ARTIFACT_AUTHORITY_SQL, ARTIFACT_INPUT_SQL, ARTIFACT_LOCK_SQL, ARTIFACT_OUTPUT_SQL, ARTIFACT_REGISTER_SQL,
  type PrivateArtifactSql, type PrivateArtifactStorage } from "./native-artifact-repository";
import { type NativeArtifactScope } from "./native-artifact-transport";

const id = (n: number) => `51900000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const scope: NativeArtifactScope = { organizationId: id(1), projectId: id(2), workerId: id(3), installationId: id(4),
  bootId: id(5), sessionId: id(6), taskId: id(7), attemptId: id(8), fence: 9,
  inputSnapshotId: id(10), candidateSnapshotId: id(11), predecessorAttemptId: id(12) };
const bytes = new TextEncoder().encode("inert artifact bytes");
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const token = `odw_${"a".repeat(64)}`;
const endpoint = "https://inert.test/functions/v1/engineering-worker-artifact";
function request(direction: "input" | "output", role = "result", patch: Partial<NativeArtifactScope> = {}) {
  return new Request(endpoint, { method: direction === "input" ? "GET" : "PUT",
    headers: { authorization: `Bearer ${token}`, "x-overdrafter-scope": JSON.stringify({ ...scope, ...patch }),
      "x-overdrafter-bytes": String(bytes.length), "x-overdrafter-sha256": hash(bytes),
      ...(direction === "input" ? { "x-overdrafter-artifact-id": id(13) }
        : { "x-overdrafter-role": role, "content-type": "application/octet-stream" }) },
    body: direction === "output" ? bytes : undefined });
}
// This fake dispatches exact adapter statements; it does NOT execute SQL or
// qualify grants, PostgreSQL locking, storage version semantics or native work.
function fixture(outputBucket?: string) {
  const state = { phase: "stopped", authorized: true, stored: null as Uint8Array | null,
    version: "generation-1", registered: false, tx: false, failReply: false, missingInput: false,
    missingTarget: false, denyMapping: false, loseAuthorityInTransaction: false, isolation: "read committed", loseAuthorityAtRegistry: false };
  const generation = () => ({ storageObjectId: id(14), bucketId: "private-fixture",
    objectName: `native-results/${scope.attemptId}/result`, storageVersion: state.version,
    storageUpdatedAt: "2026-10-03T00:00:00Z" });
  const calls: { text: string; values: readonly unknown[]; tx: boolean }[] = [];
  const sql: PrivateArtifactSql = {
    query: vi.fn(async (text, values, options) => {
      expect(options.timeoutMs).toBe(30000);
      expect(options.signal.aborted).toBe(false);
      calls.push({ text, values: structuredClone(values), tx: state.tx });
      if (text === ARTIFACT_AUTHORITY_SQL) return state.authorized && values[2] === hash(token)
        ? [{ scope, inputAdmissionId: id(15), inputEligible: state.phase === "running", outputEligible: state.phase === "stopped" }] : [];
      if (text === PREPARE_NATIVE_ARTIFACT_OUTPUTS_SQL) {
        expect(state.tx).toBe(true);
        if (state.denyMapping) throw new Error("Synthetic locked authority denial.");
        state.missingTarget = false;
        return [{ mapping: { attemptId: scope.attemptId, outputRoles: 7 } }];
      }
      if (text === ARTIFACT_INPUT_SQL) return state.missingInput ? []
        : [{ ...generation(), objectName: "admitted/source", id: id(13), bytes: bytes.length, sha256: hash(bytes) }];
      if (text === ARTIFACT_OUTPUT_SQL) return state.missingTarget ? [] : [{ ...generation(),
        objectName: `native-results/${scope.attemptId}/${values[1]}`, storageObjectId: state.stored ? id(14) : null,
        storageVersion: state.stored ? state.version : null, storageUpdatedAt: state.stored ? generation().storageUpdatedAt : null }];
      if (text === ARTIFACT_ISOLATION_SQL) return [{ isolation: state.isolation }];
      if (text === ARTIFACT_ATTEMPT_LOCK_SQL) return [{ id: scope.attemptId }];
      if (text === ARTIFACT_AUTHORITY_LOCK_SQL) return [];
      if (text === ARTIFACT_STORAGE_LOCK_SQL) return [{ id: id(14) }];
      if (text === ARTIFACT_LOCK_SQL) {
        expect(state.tx).toBe(true);
        if (state.loseAuthorityInTransaction) state.authorized = false;
        return [{ id: scope.taskId }];
      }
      if (text === ARTIFACT_REGISTER_SQL) {
        expect(state.tx).toBe(true);
        if (state.loseAuthorityAtRegistry) return [];
        const registered = !state.registered; state.registered = true;
        return [{ registered }];
      }
      throw new Error("unexpected SQL");
    }),
    transaction: vi.fn(async (work) => {
      state.tx = true;
      const before = state.registered;
      let result;
      try { result = await work(sql); }
      catch (error) { state.registered = before; throw error; }
      finally { state.tx = false; }
      // The callback succeeded and fake commit persisted; only its reply is lost.
      if (state.failReply) { state.failReply = false; throw new Error("committed reply lost"); }
      return result;
    }),
  };
  const storage: PrivateArtifactStorage = {
    create: vi.fn(async (op) => {
      expect(op.ifNoneMatch).toBe("*"); expect(op.method).toBe("PUT");
      if (state.stored) return "conflict";
      state.stored = new Uint8Array(op.bytes); return "created";
    }),
    read: vi.fn(async (op) => {
      expect(op.ifMatch).toBe(state.version); expect(op.method).toBe("GET");
      expect(state.tx).toBe(false);
      return new Response(op.objectName === "admitted/source" ? bytes : state.stored);
    }),
  };
  return { state, sql, storage, calls, handler: createPrivateNativeArtifactHandler({ sql, storage, enabled: () => true, outputBucket }) };
}
afterEach(() => vi.useRealTimers());
describe("private artifact driver composition", () => {
  it("defaults off before any SQL or Storage access", async () => {
    const f = fixture(); const handler = createPrivateNativeArtifactHandler({ sql: f.sql, storage: f.storage });
    expect((await handler(request("output"))).status).toBe(503);
    expect(f.calls).toEqual([]); expect(f.storage.create).not.toHaveBeenCalled();
  });
  it("reads only the mapped exact-generation admitted input during native authority", async () => {
    const f = fixture(); f.state.phase = "running";
    const response = await f.handler(request("input"));
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(f.storage.read).toHaveBeenCalledWith(expect.objectContaining({ objectName: "admitted/source", ifMatch: "generation-1" }), expect.any(AbortSignal));
    expect(f.calls.find(c => c.text === ARTIFACT_INPUT_SQL)?.values).toEqual([scope.attemptId,id(13)]);
    expect(f.storage.create).not.toHaveBeenCalled();
  });
  it("denies unbound input ID/missing complete job mapping before Storage read", async () => {
    const f = fixture(); f.state.phase = "running"; f.state.missingInput = true;
    expect((await f.handler(request("input"))).status).toBe(503);
    expect(f.storage.read).not.toHaveBeenCalled();
  });
  it.each(["organizationId", "projectId", "workerId", "installationId", "bootId", "sessionId", "taskId",
    "attemptId", "inputSnapshotId", "candidateSnapshotId", "predecessorAttemptId"] as const)("denies substituted %s", async (key) => {
    const f = fixture();
    expect((await f.handler(request("output", "result", { [key]: id(99) }))).status).toBe(403);
    expect(f.storage.create).not.toHaveBeenCalled(); expect(f.storage.read).not.toHaveBeenCalled();
  });
  it("denies substituted fence and invalid paired token", async () => {
    const f = fixture();
    expect((await f.handler(request("output", "result", { fence: 10 }))).status).toBe(403);
    const req = request("output"); req.headers.set("authorization", `Bearer odw_${"b".repeat(64)}`);
    expect((await f.handler(req)).status).toBe(403); expect(f.storage.create).not.toHaveBeenCalled();
  });
  it("denies pre-stop uploads and post-stop input reads", async () => {
    const f = fixture(); f.state.phase = "running";
    expect((await f.handler(request("output"))).status).toBe(403);
    f.state.phase = "stopped";
    expect((await f.handler(request("input"))).status).toBe(403);
    expect(f.storage.create).not.toHaveBeenCalled(); expect(f.storage.read).not.toHaveBeenCalled();
  });
  it.each(["assembly","target","companion","result","identity","preservation","native"])(
    "delivers post-stop %s without requiring live native eligibility", async (role) => {
      const f = fixture();
      const response = await f.handler(request("output", role));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ schema: "overdrafter.native-artifact-transfer.v1", delivered: true, role });
      expect(f.storage.create).toHaveBeenCalledTimes(1);
      expect(f.storage.create).toHaveBeenCalledWith(expect.objectContaining({
        objectName: `native-results/${scope.attemptId}/${role}`, ifNoneMatch: "*", bytes }), expect.any(AbortSignal));
      const registered = f.calls.find(c => c.text === ARTIFACT_REGISTER_SQL)!;
      expect(registered.values).toEqual([scope.organizationId,scope.projectId,scope.taskId,scope.attemptId,scope.fence,
        scope.inputSnapshotId,scope.candidateSnapshotId,role,"private-fixture",`native-results/${scope.attemptId}/${role}`,
        id(14),"generation-1","2026-10-03T00:00:00Z",bytes.length,hash(bytes),scope.attemptId,scope.taskId,hash(token),JSON.stringify(scope)]);
      expect(registered.tx).toBe(true);
      expect(f.calls.find(c => c.text === ARTIFACT_LOCK_SQL)?.values).toEqual([scope.workerId,hash(token),scope.taskId]);
    });
  it("replays one object and registration after a committed reply is lost", async () => {
    const f = fixture(); f.state.failReply = true;
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.state.registered).toBe(true);
    expect((await f.handler(request("output"))).status).toBe(200);
    expect(f.storage.create).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(c => c.text === ARTIFACT_REGISTER_SQL)).toHaveLength(2);
  });
  it("accepts an atomic create conflict only after exact-byte readback", async () => {
    const f = fixture(); vi.mocked(f.storage.create).mockImplementation(async () => {
      f.state.stored = new Uint8Array(bytes); return "conflict";
    });
    expect((await f.handler(request("output"))).status).toBe(200);
  });
  it("rejects changed existing bytes without overwrite or registration", async () => {
    const f = fixture(); f.state.stored = new Uint8Array(bytes).fill(120);
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.storage.create).not.toHaveBeenCalled();
    expect(f.calls.some(c => c.text === ARTIFACT_REGISTER_SQL)).toBe(false);
  });
  it("does not retry an unknown conditional-create outcome", async () => {
    const f = fixture(); vi.mocked(f.storage.create).mockImplementation(async () => {
      f.state.stored = new Uint8Array(bytes); throw new Error("reply lost");
    });
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.storage.create).toHaveBeenCalledTimes(1);
    expect(f.calls.some(c => c.text === ARTIFACT_REGISTER_SQL)).toBe(false);
    expect((await f.handler(request("output"))).status).toBe(200);
    expect(f.storage.create).toHaveBeenCalledTimes(1);
  });
  it("rejects a stale transaction snapshot before locking or registering", async () => {
    const f = fixture(); f.state.isolation = "repeatable read";
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.calls.some(c => c.text === ARTIFACT_LOCK_SQL)).toBe(false);
    expect(f.calls.some(c => c.text === ARTIFACT_REGISTER_SQL)).toBe(false);
  });
  it("holds authority and Storage locks before the final fresh checks", async () => {
    const f = fixture();
    expect((await f.handler(request("output"))).status).toBe(200);
    const tx = f.calls.filter(c => c.tx).map(c => c.text);
    expect(tx.slice(0,5)).toEqual([ARTIFACT_ISOLATION_SQL,ARTIFACT_LOCK_SQL,ARTIFACT_ATTEMPT_LOCK_SQL,
      ARTIFACT_AUTHORITY_LOCK_SQL,ARTIFACT_STORAGE_LOCK_SQL]);
    expect(tx.at(-1)).toBe(ARTIFACT_REGISTER_SQL);
    expect(tx.slice(5,-1)).toContain(ARTIFACT_AUTHORITY_SQL);
    expect(f.sql.transaction).toHaveBeenCalledWith(expect.any(Function),expect.objectContaining({isolation:"read committed"}));
  });
  it("does not acknowledge delivery if final statement authority has expired", async () => {
    const f = fixture(); f.state.loseAuthorityAtRegistry = true;
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.state.registered).toBe(false);
  });
  it("rechecks revocation after acquiring native locks before registry write", async () => {
    const f = fixture(); f.state.loseAuthorityInTransaction = true;
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.calls.some(c => c.text === ARTIFACT_LOCK_SQL)).toBe(true);
    expect(f.calls.some(c => c.text === ARTIFACT_REGISTER_SQL)).toBe(false);
  });
  it("rejects Storage generation replacement during readback", async () => {
    const f = fixture(); vi.mocked(f.storage.read).mockImplementation(async () => {
      f.state.version = "replaced"; return new Response(bytes);
    });
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.calls.some(c => c.text === ARTIFACT_REGISTER_SQL)).toBe(false);
  });
  it("denies missing target mapping before creation", async () => {
    const f = fixture(); f.state.missingTarget = true;
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.storage.create).not.toHaveBeenCalled();
  });
  it("keeps concurrent request scopes isolated", async () => {
    const f = fixture();
    const [good,bad] = await Promise.all([f.handler(request("output")),f.handler(request("output","result",{attemptId:id(99)}))]);
    expect(good.status).toBe(200); expect(bad.status).toBe(403);
    expect(f.calls.filter(c => c.text === ARTIFACT_REGISTER_SQL)).toHaveLength(1);
  });
  it("starts no successor query after a noncooperative authority lookup misses its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const f = fixture();
    let release!: (rows: Record<string, unknown>[]) => void;
    vi.mocked(f.sql.query).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.handler(request("output"));
    await vi.advanceTimersByTimeAsync(30000);
    expect((await pending).status).toBe(503);
    release([{ scope, inputEligible: false, outputEligible: true }]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.sql.query).toHaveBeenCalledTimes(1);
    expect(f.storage.create).not.toHaveBeenCalled();
    expect(f.sql.transaction).not.toHaveBeenCalled();
  });
  it("cancels an interrupted output readback and never registers afterward", async () => {
    const f = fixture(), controller = new AbortController();
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const cancel = vi.fn();
    vi.mocked(f.storage.read).mockImplementation(async () => {
      entered();
      return new Response(new ReadableStream<Uint8Array>({ cancel }));
    });
    const pending = f.handler(new Request(request("output"), { signal: controller.signal }));
    await reading;
    // Let the readback acquire its reader before interrupting it.
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort();
    expect((await pending).status).toBe(503);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.sql.transaction).not.toHaveBeenCalled();
  });
  it("starts no work for an aborted request", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect((await f.handler(new Request(request("output"),{signal:controller.signal}))).status).toBe(503);
    expect(f.calls).toEqual([]);
  });
});


describe("trusted output mapping bootstrap", () => {
  it("prepares missing output targets after exact stopped authority and before upload", async () => {
    const f = fixture("private-fixture"); f.state.missingTarget = true;
    const req = request("output"); req.headers.set("x-output-bucket", "worker-cannot-select-this");
    expect((await f.handler(req)).status).toBe(200);
    const mapping = f.calls.find(call => call.text === PREPARE_NATIVE_ARTIFACT_OUTPUTS_SQL)!;
    expect(mapping.values).toEqual([scope.attemptId, "private-fixture"]);
    expect(f.calls.indexOf(mapping)).toBeGreaterThan(f.calls.findIndex(call => call.text === ARTIFACT_AUTHORITY_SQL));
    expect(f.storage.create).toHaveBeenCalledWith(expect.objectContaining({ bucketId: "private-fixture" }), expect.any(AbortSignal));
  });
  it.each(["unpaired", "prestop", "foreign"])("does not prepare targets for %s requests", async reason => {
    const f = fixture("private-fixture");
    if (reason === "unpaired") f.state.authorized = false;
    if (reason === "prestop") f.state.phase = "running";
    const response = await f.handler(request("output", "result", reason === "foreign" ? { attemptId: id(99) } : {}));
    expect(response.status).toBe(403);
    expect(f.calls.some(call => call.text === PREPARE_NATIVE_ARTIFACT_OUTPUTS_SQL)).toBe(false);
    expect(f.storage.create).not.toHaveBeenCalled();
  });
  it("does not upload when locked mapping preparation refuses authority", async () => {
    const f = fixture("private-fixture"); f.state.denyMapping = true;
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.storage.create).not.toHaveBeenCalled();
  });
  it("retains unknown mapping commits for explicit exact replay without an upload", async () => {
    const f = fixture("private-fixture"); f.state.missingTarget = true; f.state.failReply = true;
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.state.missingTarget).toBe(false); expect(f.storage.create).not.toHaveBeenCalled();
    expect((await f.handler(request("output"))).status).toBe(200);
    expect(f.calls.filter(call => call.text === PREPARE_NATIVE_ARTIFACT_OUTPUTS_SQL).map(call => call.values))
      .toEqual([[scope.attemptId, "private-fixture"], [scope.attemptId, "private-fixture"]]);
    expect(f.storage.create).toHaveBeenCalledTimes(1);
  });
  it("rejects output target with incorrect objectName pattern", async () => {
    const f = fixture();
    const generation = () => ({ storageObjectId: id(14), bucketId: "private-fixture",
      objectName: `native-results/${scope.attemptId}/result`, storageVersion: "generation-1",
      storageUpdatedAt: "2026-10-03T00:00:00Z" });
    vi.mocked(f.sql.query).mockImplementation(async (text) => {
      if (text === ARTIFACT_OUTPUT_SQL) return [{ ...generation(),
        objectName: "wrong-path/result", storageObjectId: null, storageVersion: null, storageUpdatedAt: null }];
      if (text === ARTIFACT_AUTHORITY_SQL) return [{ scope, inputAdmissionId: id(15), inputEligible: false, outputEligible: true }];
      return [];
    });
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.storage.create).not.toHaveBeenCalled();
  });
  it("rejects storage lock mismatch during registration", async () => {
    const f = fixture();
    const generation = () => ({ storageObjectId: id(14), bucketId: "private-fixture",
      objectName: `native-results/${scope.attemptId}/result`, storageVersion: "generation-1",
      storageUpdatedAt: "2026-10-03T00:00:00Z" });
    vi.mocked(f.sql.query).mockImplementation(async (text) => {
      if (text === ARTIFACT_STORAGE_LOCK_SQL) return [{ id: id(99) }];
      if (text === ARTIFACT_AUTHORITY_SQL) return [{ scope, inputAdmissionId: id(15), inputEligible: false, outputEligible: true }];
      if (text === ARTIFACT_OUTPUT_SQL) return [{ ...generation(),
        storageObjectId: f.state.stored ? id(14) : null, storageVersion: f.state.stored ? "generation-1" : null,
        storageUpdatedAt: f.state.stored ? "2026-10-03T00:00:00Z" : null }];
      if (text === ARTIFACT_INPUT_SQL) return [{ ...generation(), objectName: "admitted/source", id: id(13), bytes: bytes.length, sha256: hash(bytes) }];
      if (text === ARTIFACT_ISOLATION_SQL) return [{ isolation: "read committed" }];
      if (text === ARTIFACT_ATTEMPT_LOCK_SQL) return [{ id: scope.attemptId }];
      if (text === ARTIFACT_AUTHORITY_LOCK_SQL) return [];
      if (text === ARTIFACT_LOCK_SQL) return [{ id: scope.taskId }];
      if (text === ARTIFACT_REGISTER_SQL) return [{ registered: true }];
      return [];
    });
    expect((await f.handler(request("output"))).status).toBe(503);
    expect(f.calls.some(c => c.text === ARTIFACT_REGISTER_SQL)).toBe(false);
  });
  it("rejects input request with wrong artifactId", async () => {
    const f = fixture(); f.state.phase = "running";
    const wrongId = request("input");
    wrongId.headers.set("x-overdrafter-artifact-id", id(99));
    expect((await f.handler(wrongId)).status).toBe(503);
    expect(f.storage.read).not.toHaveBeenCalled();
  });
});
