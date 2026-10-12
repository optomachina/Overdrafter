// @vitest-environment node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeArtifactHandler, NATIVE_ARTIFACT_SCHEMA, type NativeArtifactScope, type NativeArtifactRuntime } from "./native-artifact-transport";
import type { NativeRegistrationRepository } from "./native-result-registration";

const u = (n: number) => `51900000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: NativeArtifactScope = {
  organizationId: u(1), projectId: u(2), workerId: u(3), installationId: u(4),
  bootId: u(5), sessionId: u(6), taskId: u(7), attemptId: u(8), fence: 9,
  inputSnapshotId: u(10), candidateSnapshotId: u(11), predecessorAttemptId: u(12),
};
const token = `odw_${"a".repeat(64)}`;
const inputId = u(13), objectId = u(14);
const inputBytes = new TextEncoder().encode("exact prepared input");
const outputBytes = new TextEncoder().encode('{"candidate":"synthetic"}');
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const endpoint = "https://fixture.test/functions/v1/engineering-worker-artifact";

function fixture() {
  const stored = new Map<string, Uint8Array>();
  let current = true, authorizedScope: NativeArtifactScope = scope, registered = false;
  const registration: NativeRegistrationRepository = {
    loadAdmission: vi.fn(async () => stored.has("result") ? {
      taskId: scope.taskId, attemptId: scope.attemptId, organizationId: scope.organizationId,
      projectId: scope.projectId, fence: scope.fence, inputSnapshotId: scope.inputSnapshotId,
      candidateSnapshotId: scope.candidateSnapshotId, role: "result" as const, storageObjectId: objectId,
      bucketId: "synthetic-private", objectName: `attempt/${scope.attemptId}/result`,
      storageVersion: "immutable-1", storageUpdatedAt: "2026-09-27T00:00:00Z",
    } : null),
    readUploadedObject: vi.fn(async (id: string) => id === objectId && stored.has("result")
      ? new Response(stored.get("result")) : new Response(null, { status: 404 })),
    registerMeasuredObject: vi.fn(async (row) => {
      if (!current || row.organizationId !== scope.organizationId || row.attemptId !== scope.attemptId
        || row.fence !== scope.fence || row.inputSnapshotId !== scope.inputSnapshotId
        || row.candidateSnapshotId !== scope.candidateSnapshotId || row.sha256 !== sha(outputBytes)) {
        throw new Error("owner-only registry rejected");
      }
      if (registered) return false;
      registered = true; return true;
    }),
  };
  const put = vi.fn(async (_scope, role, bytes: Uint8Array) => {
    if (role !== "result") throw new Error("role denied");
    const old = stored.get(role);
    if (old && sha(old) !== sha(bytes)) throw new Error("immutable object conflict");
    if (!old) stored.set(role, new Uint8Array(bytes));
  });
  const authorize = vi.fn(async ({ scope: requested, tokenSha256 }: {scope:NativeArtifactScope;tokenSha256:string}) => {
    if (!current || tokenSha256 !== sha(new TextEncoder().encode(token))
      || JSON.stringify(requested) !== JSON.stringify(scope)) return null;
    return { scope: authorizedScope, input: { id: inputId, bytes: inputBytes.byteLength, sha256: sha(inputBytes) } };
  });
  const readInput = vi.fn<NativeArtifactRuntime["readInput"]>(async (id: string) => id === inputId ? new Response(inputBytes) : new Response(null, { status: 404 }));
  const handler = createNativeArtifactHandler({ enabled: () => true, authorize, readInput,
    putImmutableOutput: put, registration });
  const headers = (bytes: Uint8Array, extra: Record<string,string> = {}) => ({
    authorization: `Bearer ${token}`, "x-overdrafter-scope": JSON.stringify(scope),
    "x-overdrafter-bytes": String(bytes.byteLength), "x-overdrafter-sha256": sha(bytes), ...extra,
  });
  const get = (extra: Record<string,string> = {}) => new Request(endpoint, { method: "GET",
    headers: headers(inputBytes, { "x-overdrafter-artifact-id": inputId, ...extra }) });
  const upload = (bytes = outputBytes, extra: Record<string,string> = {}) => new Request(endpoint, {
    method: "PUT", headers: headers(bytes, { "content-type": "application/octet-stream",
      "x-overdrafter-role": "result", ...extra }), body: bytes,
  });
  return { handler, authorize, readInput, put, registration, stored, get, upload,
    revoke: () => { current = false; }, foreignAdmission: () => { authorizedScope = { ...scope, organizationId: u(99) }; } };
}

afterEach(() => vi.useRealTimers());

describe("native artifact transport", () => {
  it.each([1, 2, 3])("rejects elapsed authorization %s before starting successor work", async (expireAt) => {
    const f = fixture(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const authorize = f.authorize.getMockImplementation()!;
    f.authorize.mockImplementation(async (...args) => {
      if (f.authorize.mock.calls.length === expireAt) now = 30_000;
      return authorize(...args);
    });
    expect((await f.handler(f.upload())).status).toBe(503);
    expect(f.authorize).toHaveBeenCalledTimes(expireAt);
    expect(f.put).toHaveBeenCalledTimes(expireAt === 3 ? 1 : 0);
    expect(f.registration.loadAdmission).not.toHaveBeenCalled();
    expect(f.registration.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it.each([29_999, 30_000, 30_001])("checks elapsed %s ms before delivering input bytes", async (elapsed) => {
    const f = fixture(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const authorize = f.authorize.getMockImplementation()!;
    f.authorize.mockImplementation(async (...args) => {
      if (f.authorize.mock.calls.length === 2) now = elapsed;
      return authorize(...args);
    });
    const response = await f.handler(f.get());
    expect(response.status).toBe(elapsed < 30_000 ? 200 : 503);
    if (elapsed < 30_000) expect(new Uint8Array(await response.arrayBuffer())).toEqual(inputBytes);
    else expect(await response.json()).toEqual({ schema: NATIVE_ARTIFACT_SCHEMA, error: "transfer_unavailable" });
  });
  it("disposes an input response that consumed the elapsed budget without waiting for cancellation", async () => {
    const f = fixture(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    f.readInput.mockImplementation(async () => {
      now = 30_001;
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) { stream.enqueue(inputBytes); }, pull(stream) { stream.close(); }, cancel,
      }));
    });
    expect((await f.handler(f.get())).status).toBe(503);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.readInput.mock.calls[0][1].aborted).toBe(true);
  });
  it.each(["input", "output"])("cancels %s bytes that arrive after the elapsed budget", async (direction) => {
    const f = fixture(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const cancel = vi.fn(); let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (sent) { stream.close(); return; }
        sent = true; now = 30_000; stream.enqueue(direction === "input" ? inputBytes : outputBytes);
      }, cancel,
    }, { highWaterMark: 0 });
    if (direction === "input") f.readInput.mockResolvedValue(new Response(body));
    const request = direction === "input" ? f.get() : new Request(f.upload(), { body, duplex: "half" } as RequestInit);
    expect((await f.handler(request)).status).toBe(503);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.put).not.toHaveBeenCalled();
  });
  it("does not start registration after output storage consumes the elapsed budget", async () => {
    const f = fixture(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const put = f.put.getMockImplementation()!;
    f.put.mockImplementation(async (...args) => { await put(...args); now = 30_001; });
    expect((await f.handler(f.upload())).status).toBe(503);
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.stored.size).toBe(1);
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(f.registration.loadAdmission).not.toHaveBeenCalled();
  });
  it.each(["admission", "read", "write"])("keeps the transfer budget through registry %s", async (stage) => {
    const f = fixture(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const put = f.put.getMockImplementation()!;
    f.put.mockImplementation(async (...args) => { await put(...args); now = 29_000; });
    const load = vi.mocked(f.registration.loadAdmission), read = vi.mocked(f.registration.readUploadedObject);
    const write = vi.mocked(f.registration.registerMeasuredObject);
    const loadImpl = load.getMockImplementation()!, writeImpl = write.getMockImplementation()!;
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    if (stage === "admission") load.mockImplementation(async (...args) => { now = 30_001; return loadImpl(...args); });
    if (stage === "read") read.mockImplementation(async () => {
      now = 30_001;
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) { stream.enqueue(outputBytes); }, pull(stream) { stream.close(); }, cancel,
      }));
    });
    if (stage === "write") write.mockImplementation(async (...args) => { now = 30_001; return writeImpl(...args); });
    const response = await f.handler(f.upload());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ schema: NATIVE_ARTIFACT_SCHEMA, error: "transfer_unavailable" });
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(stage === "admission" ? 0 : 1);
    expect(write).toHaveBeenCalledTimes(stage === "write" ? 1 : 0);
    expect(load.mock.calls[0][3].aborted).toBe(true);
    if (stage === "read") expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("gives registry byte reads only the remaining transfer time", async () => {
    const f = fixture(); let now = 0, pulls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const put = f.put.getMockImplementation()!;
    f.put.mockImplementation(async (...args) => { await put(...args); now = 29_000; });
    const cancel = vi.fn();
    vi.mocked(f.registration.readUploadedObject).mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        if (++pulls > 1) { stream.close(); return; }
        now = 30_000; stream.enqueue(outputBytes);
      }, cancel,
    }, { highWaterMark: 0 })));
    expect((await f.handler(f.upload())).status).toBe(503);
    expect(pulls).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.registration.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it.each([29_999, 29_999.5, 30_000])("conservatively rounds the remaining registry budget at %s ms", async (elapsed) => {
    const f = fixture(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const authorize = f.authorize.getMockImplementation()!;
    f.authorize.mockImplementation(async (...args) => {
      if (f.authorize.mock.calls.length === 3) now = elapsed;
      return authorize(...args);
    });
    expect((await f.handler(f.upload())).status).toBe(elapsed <= 29_999 ? 200 : 503);
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.registration.loadAdmission).toHaveBeenCalledTimes(elapsed <= 29_999 ? 1 : 0);
    expect(f.registration.registerMeasuredObject).toHaveBeenCalledTimes(elapsed <= 29_999 ? 1 : 0);
  });
  it("keeps the route disabled before credential, object, or registry access", async () => {
    const f = fixture();
    const handler = createNativeArtifactHandler({ enabled: () => false, authorize: f.authorize,
      readInput: f.readInput, putImmutableOutput: f.put, registration: f.registration });
    expect((await handler(f.get())).status).toBe(503);
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it.each(["input", "output"])("performs no adapter calls for an already-aborted %s request", async (direction) => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    const request = new Request(direction === "input" ? f.get() : f.upload(), { signal: controller.signal });
    const response = await f.handler(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ schema: NATIVE_ARTIFACT_SCHEMA, error: "transfer_unavailable" });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.readInput).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
    expect(f.registration.loadAdmission).not.toHaveBeenCalled();
    expect(f.registration.readUploadedObject).not.toHaveBeenCalled();
    expect(f.registration.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("prevents late registration work after an HTTP abort during admission", async () => {
    const f = fixture(), controller = new AbortController();
    const loadAdmission = vi.mocked(f.registration.loadAdmission).getMockImplementation()!;
    let releaseAdmission!: () => Promise<void>, entered!: () => void;
    const admissionEntered = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(f.registration.loadAdmission).mockImplementation((...args) => new Promise((resolve) => {
      releaseAdmission = async () => { resolve(await loadAdmission(...args)); };
      entered();
    }));
    const response = f.handler(new Request(f.upload(), { signal: controller.signal }));
    await admissionEntered;
    controller.abort();
    expect((await response).status).toBe(503);
    await releaseAdmission();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.registration.readUploadedObject).not.toHaveBeenCalled();
    expect(f.registration.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3])("starts no successor adapter after cancellation in authorization call %s", async (abortAt) => {
    const f = fixture(), controller = new AbortController();
    const authorize = f.authorize.getMockImplementation()!;
    f.authorize.mockImplementation(async (...args) => {
      if (f.authorize.mock.calls.length === abortAt) controller.abort();
      return authorize(...args);
    });
    expect((await f.handler(new Request(f.upload(), { signal: controller.signal }))).status).toBe(503);
    expect(f.authorize).toHaveBeenCalledTimes(abortAt);
    expect(f.put).toHaveBeenCalledTimes(abortAt === 3 ? 1 : 0);
    expect(f.registration.loadAdmission).not.toHaveBeenCalled();
    expect(f.registration.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("reports interrupted delivery without retrying an in-flight write, then permits exact replay", async () => {
    const f = fixture(), controller = new AbortController();
    const register = vi.mocked(f.registration.registerMeasuredObject).getMockImplementation()!;
    let releaseWrite!: () => Promise<void>, entered!: () => void;
    const writeEntered = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(f.registration.registerMeasuredObject).mockImplementationOnce((...args) => new Promise((resolve, reject) => {
      releaseWrite = async () => {
        try { resolve(await register(...args)); } catch (error) { reject(error); }
      };
      entered();
    }));
    const pending = f.handler(new Request(f.upload(), { signal: controller.signal }));
    await writeEntered;
    controller.abort();
    const interrupted = await pending;
    expect(interrupted.status).toBe(503);
    expect(await interrupted.json()).toEqual({ schema: NATIVE_ARTIFACT_SCHEMA, error: "transfer_unavailable" });
    expect(f.registration.registerMeasuredObject).toHaveBeenCalledTimes(1);
    await releaseWrite();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.registration.registerMeasuredObject).toHaveBeenCalledTimes(1);
    expect((await f.handler(f.upload())).status).toBe(200);
    expect(f.registration.registerMeasuredObject).toHaveBeenCalledTimes(2);
    expect(f.stored.size).toBe(1);
    expect(f.stored.get("result")).toEqual(outputBytes);
  });
  it.each(["abort", "deadline"])("cancels a late input response on %s without waiting for disposal", async (reason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const f = fixture(), controller = new AbortController(), cancel = vi.fn(() => new Promise<void>(() => undefined));
    let releaseRead!: (response: Response) => void, entered!: () => void;
    const readEntered = new Promise<void>((resolve) => { entered = resolve; });
    f.readInput.mockImplementation(() => new Promise((resolve) => { releaseRead = resolve; entered(); }));
    const pending = f.handler(new Request(f.get(), { signal: controller.signal }));
    await readEntered;
    if (reason === "abort") controller.abort(); else await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).status).toBe(503);
    releaseRead(new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(inputBytes); }, cancel,
    })));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.registration.loadAdmission).not.toHaveBeenCalled();
  });
  it.each(["throw", "reject"])("fails closed when an input adapter uses %s", async (failure) => {
    const f = fixture();
    f.readInput.mockImplementation(() => {
      if (failure === "throw") throw new Error("read failed synchronously");
      return Promise.reject(new Error("read rejected asynchronously"));
    });
    expect((await f.handler(f.get())).status).toBe(503);
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.registration.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("handles a synchronous exception while disposing a late input response", async () => {
    const f = fixture(), controller = new AbortController();
    const response = new Response(inputBytes);
    const cancel = vi.spyOn(response.body!, "cancel").mockImplementation(() => { throw new Error("cleanup failed"); });
    f.readInput.mockImplementation(async () => { controller.abort(); return response; });
    expect((await f.handler(new Request(f.get(), { signal: controller.signal }))).status).toBe(503);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.registration.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("downloads only the admitted opaque input ID and exact bytes", async () => {
    const f = fixture(); const response = await f.handler(f.get());
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(inputBytes);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.readInput).toHaveBeenCalledWith(inputId, expect.any(AbortSignal));
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it("rejects wrong tenant, session, fence, predecessor and worker without object reads", async () => {
    for (const patch of [{organizationId:u(40)},{sessionId:u(41)},{fence:10},
      {predecessorAttemptId:u(42)},{workerId:u(43)}]) {
      const f = fixture(); const altered = JSON.stringify({ ...scope, ...patch });
      expect((await f.handler(f.get({"x-overdrafter-scope":altered}))).status).toBe(403);
      expect(f.readInput).not.toHaveBeenCalled();
    }
  });
  it("rejects foreign paths, redirects, overbounds, and changed object bytes", async () => {
    const f = fixture();
    expect((await f.handler(new Request(`${endpoint}?path=../foreign`,{method:"GET",headers:f.get().headers}))).status).toBe(403);
    expect((await f.handler(f.get({"x-overdrafter-artifact-id":"../foreign"}))).status).toBe(400);
    expect((await f.handler(f.get({"x-overdrafter-bytes":"16000001"}))).status).toBe(400);
    f.readInput.mockImplementationOnce(async () => new Response(null,{status:302,headers:{location:"https://foreign.test/object"}}));
    expect((await f.handler(f.get())).status).toBe(503);
    f.readInput.mockImplementationOnce(async () => new Response(new TextEncoder().encode("changed")));
    expect((await f.handler(f.get())).status).toBe(503);
    expect(f.put).not.toHaveBeenCalled();
  });
  it("rechecks revocation and foreign admissions before returning bytes", async () => {
    const f = fixture(); f.foreignAdmission();
    expect((await f.handler(f.get())).status).toBe(403);
    expect(f.readInput).not.toHaveBeenCalled();
    const g = fixture(); g.readInput.mockImplementationOnce(async () => { g.revoke(); return new Response(inputBytes); });
    expect((await g.handler(g.get())).status).toBe(403);
  });
  it("measures and registers one immutable output; lost reply replays the same bytes", async () => {
    const f = fixture();
    const first = await f.handler(f.upload());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ schema:NATIVE_ARTIFACT_SCHEMA, delivered:true, role:"result" });
    expect(f.stored.get("result")).toEqual(outputBytes);
    expect(f.registration.registerMeasuredObject).toHaveBeenCalledTimes(1);
    // Simulate a lost first response. An identical PUT reads the retained object
    // and SQL registration replay returns false without a second candidate.
    expect((await f.handler(f.upload())).status).toBe(200);
    expect(f.registration.registerMeasuredObject).toHaveBeenCalledTimes(2);
    expect(f.stored.size).toBe(1);
    expect((await f.handler(f.upload(new TextEncoder().encode("changed")))).status).toBe(503);
    expect(f.stored.get("result")).toEqual(outputBytes);
  });
  it("rejects digest mismatch and stale authority without registration or a verification receipt", async () => {
    const f = fixture();
    expect((await f.handler(f.upload(outputBytes,{"x-overdrafter-sha256":"0".repeat(64)}))).status).toBe(503);
    expect(f.put).not.toHaveBeenCalled();
    const g = fixture(); g.revoke();
    expect((await g.handler(g.upload())).status).toBe(403);
    expect(g.put).not.toHaveBeenCalled();
    expect(g.registration.registerMeasuredObject).not.toHaveBeenCalled();
    const h = fixture(); const result = await h.handler(h.upload());
    const text = await result.text();
    expect(text).not.toContain("verification"); expect(text).not.toContain("signature");
    expect(text).not.toContain("candidateSnapshotId"); expect(text).not.toContain(token);
  });
  it("rejects a reused admission object whose attempt changes between authorization checks", async () => {
    const f = fixture();
    const shared = { scope: { ...scope }, input: { id: inputId, bytes: inputBytes.byteLength, sha256: sha(inputBytes) } };
    let calls = 0;
    f.authorize.mockImplementation(async () => {
      calls++;
      if (calls === 2) shared.scope.attemptId = u(80);
      return shared;
    });
    const handler = createNativeArtifactHandler({ enabled: () => true, authorize: f.authorize,
      readInput: f.readInput, putImmutableOutput: f.put, registration: f.registration });
    expect((await handler(f.upload())).status).toBe(403);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.registration.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("keeps the requested attempt fixed when an authorization adapter mutates its argument", async () => {
    const f = fixture();
    f.authorize.mockImplementation(async (request) => {
      Object.assign(request.scope, { attemptId: u(80) });
      return { scope: { ...request.scope }, input: { id: inputId, bytes: inputBytes.byteLength, sha256: sha(inputBytes) } };
    });
    const handler = createNativeArtifactHandler({ enabled: () => true, authorize: f.authorize,
      readInput: f.readInput, putImmutableOutput: f.put, registration: f.registration });
    expect((await handler(f.upload())).status).toBe(403);
    expect(f.put).not.toHaveBeenCalled();
  });
  it("replays exact bytes after a real local HTTP response is interrupted", async () => {
    const f = fixture(); let drop = true;
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const part of incoming) chunks.push(Buffer.from(part));
      const wireHeaders: Record<string,string> = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") wireHeaders[name] = value;
      }
      const body = Buffer.concat(chunks);
      const request = new Request(endpoint, { method: incoming.method, headers: wireHeaders,
        body: body.length ? body : undefined });
      const response = await f.handler(request);
      if (drop) { drop = false; outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
    try {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/functions/v1/engineering-worker-artifact`;
      const headers = Object.fromEntries(f.upload().headers);
      await expect(fetch(url,{method:"PUT",headers,body:outputBytes})).rejects.toThrow();
      expect(f.stored.get("result")).toEqual(outputBytes);
      const retry = await fetch(url,{method:"PUT",headers,body:outputBytes});
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({schema:NATIVE_ARTIFACT_SCHEMA,delivered:true,role:"result"});
      expect(f.stored.size).toBe(1);
      expect(f.registration.registerMeasuredObject).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
