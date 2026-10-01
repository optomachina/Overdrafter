// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storedNativeFixture } from "./native-result-fixture";
import { registerMeasuredNativeResult, type NativeRegistrationRepository } from "./native-result-registration";

function setup() {
  const fixture = storedNativeFixture(), object = fixture.objects.find((item) => item.role === "result")!;
  const admission = {
    taskId: fixture.admission.taskId, attemptId: fixture.admission.active.attemptId,
    organizationId: object.scope.organizationId, projectId: object.scope.projectId,
    fence: object.fence, inputSnapshotId: object.inputSnapshotId,
    candidateSnapshotId: object.candidateSnapshotId, role: object.role,
    storageObjectId: object.id, bucketId: "ovd560-synthetic", objectName: "fixture/result.json",
    storageVersion: "ovd560-original", storageUpdatedAt: "2026-09-26T00:00:00.000Z",
  } as const;
  const repository: NativeRegistrationRepository = {
    loadAdmission: vi.fn(async () => admission),
    readUploadedObject: vi.fn(async () => new Response(fixture.bytes.result)),
    registerMeasuredObject: vi.fn(async () => true),
  };
  const request = { taskId: admission.taskId, attemptId: admission.attemptId,
    role: admission.role, repository };
  return { fixture, admission, repository, request };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("measured native result registration", () => {
  it("measures exact response bytes before the owner-only registration call", async () => {
    const { fixture, admission, repository, request } = setup();
    expect(await registerMeasuredNativeResult(request)).toBe(true);
    expect(repository.readUploadedObject).toHaveBeenCalledWith(admission.storageObjectId, expect.any(AbortSignal));
    expect(repository.registerMeasuredObject).toHaveBeenCalledWith({ ...admission,
      byteLength: fixture.bytes.result.byteLength,
      sha256: createHash("sha256").update(fixture.bytes.result).digest("hex") }, expect.any(AbortSignal));
    const signal = vi.mocked(repository.readUploadedObject).mock.calls[0][1];
    expect(repository.loadAdmission).toHaveBeenCalledWith(request.taskId, request.attemptId, request.role, signal);
    expect(vi.mocked(repository.registerMeasuredObject).mock.calls[0][1]).toBe(signal);
  });
  it("rejects a foreign task before any byte read", async () => {
    const { repository, request } = setup();
    await expect(registerMeasuredNativeResult({ ...request, taskId: "33333333-3333-4333-8333-333333333333" }))
      .rejects.toThrow("admission identity");
    expect(repository.readUploadedObject).not.toHaveBeenCalled();
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("rejects non-200 and oversized responses without registration", async () => {
    const bad = setup();
    vi.mocked(bad.repository.readUploadedObject).mockResolvedValue(new Response(null, { status: 404 }));
    await expect(registerMeasuredNativeResult(bad.request)).rejects.toThrow("object response");
    expect(bad.repository.registerMeasuredObject).not.toHaveBeenCalled();
    const huge = setup();
    vi.mocked(huge.repository.readUploadedObject).mockResolvedValue(new Response(new Uint8Array(256_001)));
    await expect(registerMeasuredNativeResult(huge.request)).rejects.toThrow("exceeds role size");
    expect(huge.repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("bounds a stalled response before SQL registration", async () => {
    const { repository, request } = setup();
    vi.mocked(repository.readUploadedObject).mockResolvedValue(new Response(new ReadableStream()));
    await expect(registerMeasuredNativeResult({ ...request, timeoutMs: 10 })).rejects.toThrow("interrupted");
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("rejects a CPU-bound read that exceeds the deadline before the timer fires", async () => {
    const { repository, request } = setup();
    vi.mocked(repository.readUploadedObject).mockImplementation(async () => {
      const until = performance.now() + 10;
      while (performance.now() < until) { /* Model synchronous response work. */ }
      return new Response(new Uint8Array([1]));
    });
    await expect(registerMeasuredNativeResult({ ...request, timeoutMs: 1 })).rejects.toThrow("interrupted");
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("handles a transport rejection after a synchronous deadline overrun", async () => {
    const { repository, request } = setup();
    vi.mocked(repository.readUploadedObject).mockImplementation(async () => {
      const until = performance.now() + 10;
      while (performance.now() < until) { /* Model synchronous transport work. */ }
      throw new Error("transport failed after deadline");
    });
    await expect(registerMeasuredNativeResult({ ...request, timeoutMs: 1 })).rejects.toThrow("interrupted");
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("performs no adapter calls for an already-aborted registration", async () => {
    const { repository, request } = setup();
    const controller = new AbortController(); controller.abort();
    await expect(registerMeasuredNativeResult({ ...request, signal: controller.signal })).rejects.toThrow("interrupted");
    expect(repository.loadAdmission).not.toHaveBeenCalled();
    expect(repository.readUploadedObject).not.toHaveBeenCalled();
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("does not read or register after aborted admission resolves late", async () => {
    const { admission, repository, request } = setup();
    const controller = new AbortController(), late = deferred<typeof admission>();
    vi.mocked(repository.loadAdmission).mockReturnValue(late.promise);
    const result = registerMeasuredNativeResult({ ...request, signal: controller.signal });
    const rejected = expect(result).rejects.toThrow("interrupted");
    controller.abort(); late.resolve(admission);
    await rejected;
    expect(repository.readUploadedObject).not.toHaveBeenCalled();
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("bounds stalled admission and discards its late result", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { admission, repository, request } = setup(), late = deferred<typeof admission>();
    vi.mocked(repository.loadAdmission).mockReturnValue(late.promise);
    const settled = vi.fn();
    const result = registerMeasuredNativeResult({ ...request, timeoutMs: 10 });
    void result.then(settled, settled);
    const rejected = expect(result).rejects.toThrow("interrupted");
    await vi.advanceTimersByTimeAsync(10);
    try { expect(settled).toHaveBeenCalledWith(expect.any(Error)); }
    finally { late.resolve(admission); await rejected; }
    expect(vi.getTimerCount()).toBe(0);
    expect(repository.readUploadedObject).not.toHaveBeenCalled();
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("shares one deadline between admission and object reading", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { admission, fixture, repository, request } = setup();
    vi.mocked(repository.loadAdmission).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(admission), 7)));
    vi.mocked(repository.readUploadedObject).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(new Response(fixture.bytes.result)), 4)));
    const rejected = expect(registerMeasuredNativeResult({ ...request, timeoutMs: 10 })).rejects.toThrow("interrupted");
    await Promise.all([rejected, vi.advanceTimersByTimeAsync(11)]);
    expect(repository.readUploadedObject).toHaveBeenCalledTimes(1);
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("checks a synchronous admission overrun before starting the object read", async () => {
    const { admission, repository, request } = setup();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(repository.loadAdmission).mockImplementation(async () => { now = 11; return admission; });
    await expect(registerMeasuredNativeResult({ ...request, timeoutMs: 10 })).rejects.toThrow("interrupted");
    expect(repository.readUploadedObject).not.toHaveBeenCalled();
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it.each(["abort", "deadline", "synchronous overrun"])("disposes a late object response after %s without waiting for disposal", async (reason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { fixture, repository, request } = setup();
    const controller = new AbortController(), entered = deferred<AbortSignal>(), late = deferred<Response>();
    vi.mocked(repository.readUploadedObject).mockImplementation((_id, signal) => { entered.resolve(signal); return late.promise; });
    const rejected = expect(registerMeasuredNativeResult({ ...request, timeoutMs: 10, signal: controller.signal })).rejects.toThrow("interrupted");
    const signal = await entered.promise;
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(fixture.bytes.result); }, cancel });
    if (reason === "abort") controller.abort();
    else if (reason === "deadline") await vi.advanceTimersByTimeAsync(10);
    else vi.spyOn(performance, "now").mockReturnValue(11);
    late.resolve(new Response(body));
    await rejected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("cancels an interrupted body stream without registering partial bytes", async () => {
    const { fixture, repository, request } = setup(), controller = new AbortController(), cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(stream) { controller.abort(); stream.enqueue(fixture.bytes.result); }, cancel,
    }, { highWaterMark: 0 });
    vi.mocked(repository.readUploadedObject).mockResolvedValue(new Response(body));
    await expect(registerMeasuredNativeResult({ ...request, signal: controller.signal })).rejects.toThrow("interrupted");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it.each(["deadline", "abort"])("bounds an in-flight registry write on %s without claiming rollback or retrying", async (reason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { repository, request } = setup(), entered = deferred<void>(), late = deferred<boolean>();
    const controller = new AbortController(), settled = vi.fn();
    vi.mocked(repository.registerMeasuredObject).mockImplementation(() => { entered.resolve(); return late.promise; });
    const result = registerMeasuredNativeResult({ ...request, timeoutMs: 10, signal: controller.signal });
    void result.then(settled, settled);
    const rejected = expect(result).rejects.toThrow("delivery may be unknown");
    await entered.promise;
    if (reason === "abort") controller.abort();
    await vi.advanceTimersByTimeAsync(reason === "deadline" ? 10 : 0);
    try { expect(settled).toHaveBeenCalledWith(expect.any(Error)); }
    finally { late.resolve(true); await rejected; }
    expect(vi.mocked(repository.registerMeasuredObject).mock.calls[0][1].aborted).toBe(true);
    expect(repository.registerMeasuredObject).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a registry success delivered after a synchronous deadline overrun", async () => {
    const { repository, request } = setup(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(repository.registerMeasuredObject).mockImplementation(async () => { now = 11; return true; });
    await expect(registerMeasuredNativeResult({ ...request, timeoutMs: 10 })).rejects.toThrow("delivery may be unknown");
    expect(repository.registerMeasuredObject).toHaveBeenCalledTimes(1);
  });
  it("reports interruption when an admission adapter throws after a synchronous overrun", async () => {
    const { repository, request } = setup(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(repository.loadAdmission).mockImplementation(() => { now = 11; throw new Error("adapter failure"); });
    await expect(registerMeasuredNativeResult({ ...request, timeoutMs: 10 })).rejects.toThrow("interrupted");
    expect(repository.readUploadedObject).not.toHaveBeenCalled();
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("handles a synchronous exception while disposing a late object response", async () => {
    const { fixture, repository, request } = setup(), controller = new AbortController();
    const response = new Response(fixture.bytes.result);
    const cancel = vi.spyOn(response.body!, "cancel").mockImplementation(() => { throw new Error("cleanup failed"); });
    vi.mocked(repository.readUploadedObject).mockImplementation(async () => { controller.abort(); return response; });
    await expect(registerMeasuredNativeResult({ ...request, signal: controller.signal })).rejects.toThrow("interrupted");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(repository.registerMeasuredObject).not.toHaveBeenCalled();
  });
  it("preserves false as successful exact registration replay", async () => {
    const { repository, request } = setup();
    vi.mocked(repository.registerMeasuredObject).mockResolvedValue(false);
    expect(await registerMeasuredNativeResult(request)).toBe(false);
    expect(repository.registerMeasuredObject).toHaveBeenCalledTimes(1);
  });
});
