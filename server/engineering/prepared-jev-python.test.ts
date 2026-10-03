import { expect, it, vi } from "vitest";
import { NATIVE_SEED_FILES, nativeDigest } from "../../src/lib/engineering-cumulative";
import { dispatchPreparedRequestWithPythonJev } from "./prepared-jev-python";
import { pythonJson } from "./python-json";
vi.mock("./python-json", () => ({ pythonJson: vi.fn() }));
it("wires the existing helper protocol through reservation and finish without a real subprocess/provider", async () => {
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";
  const snapshotId = "33333333-3333-4333-8333-333333333333";
  const identity = { requestId: "44444444-4444-4444-8444-444444444444",
    expectedQueueRevision: 0, idempotencyKey: "55555555-5555-4555-8555-555555555555" };
  const contextText = JSON.stringify({ schema: "overdrafter.prepared-assembly.v2", packageId: "ovd-native04-assembly",
    scope: { organizationId, projectId }, snapshotId, seedSnapshotId: snapshotId, sequence: 0, producer: null,
    createdAt: "2026-09-10T00:00:00.000Z", configuration: "Default", assemblyPath: "synthetic-assembly.SLDASM",
    files: NATIVE_SEED_FILES, depthMm: 5, checks: [] });
  const text = "Set depth to 7 mm";
  const finish = vi.fn(async () => ({ requestId: identity.requestId }));
  vi.mocked(pythonJson).mockResolvedValue({ result: { model: "jev-1.13.0", answers: { action: {
    choice: "confirm", confidence: 1, probabilities: { confirm: 1 },
  } }, usage: { input_tokens: 0, output_tokens: 0 } }, request_elapsed_ms: 0, estimated_api_cost_usd: 0 });
  const runtime = { enabled: () => true, reserve: async () => ({ state: "reserved", invoke: true,
    text, contextText, inputSnapshotId: snapshotId, contextSha256: await nativeDigest(contextText),
    inputSha256: await nativeDigest(text), organizationId, projectId, priorClarification: null }),
  finish, fail: vi.fn(async () => ({})) };
  expect(await dispatchPreparedRequestWithPythonJev(identity, runtime,
    { python: "inert-python-placeholder", jev: "inert-helper-placeholder" })).toMatchObject({ state: "completed" });
  expect(pythonJson).toHaveBeenCalledExactlyOnceWith("inert-python-placeholder", "inert-helper-placeholder",
    expect.objectContaining({ model: "jev-1.13.0" }), 15_000);
  expect(finish).toHaveBeenCalledWith(identity, expect.objectContaining({ depthMm: 7 }), expect.any(AbortSignal));
  vi.mocked(pythonJson).mockClear();
  expect(await dispatchPreparedRequestWithPythonJev(identity, { ...runtime, enabled: () => false },
    { python: "inert-python-placeholder", jev: "inert-helper-placeholder" })).toEqual({ state: "disabled" });
  expect(pythonJson).not.toHaveBeenCalled();
});
