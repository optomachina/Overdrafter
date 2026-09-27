// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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

describe("measured native result registration", () => {
  it("measures exact response bytes before the owner-only registration call", async () => {
    const { fixture, admission, repository, request } = setup();
    expect(await registerMeasuredNativeResult(request)).toBe(true);
    expect(repository.readUploadedObject).toHaveBeenCalledWith(admission.storageObjectId, expect.any(AbortSignal));
    expect(repository.registerMeasuredObject).toHaveBeenCalledWith({ ...admission,
      byteLength: fixture.bytes.result.byteLength,
      sha256: createHash("sha256").update(fixture.bytes.result).digest("hex") });
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
});
