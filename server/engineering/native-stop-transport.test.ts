// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createNativeStopHandler, NATIVE_STOP_SCHEMA } from "./native-stop-transport";
import type { NativeStopRepository } from "./native-stop-admission";
const u = (n: number) => `56200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const token = `odw_${"a".repeat(64)}`;
const body = { schema: NATIVE_STOP_SCHEMA, action: "record_stop", workerId: u(1), bootId: u(2),
  taskId: u(3), attemptId: u(4), fence: 5, evidenceId: u(6), revision: 1, idempotencyKey: u(7) };
const request = (value: unknown = body, bearer = token) => new Request("https://example.test/functions/v1/engineering-worker-stop", {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify(value),
});
const repository = (): NativeStopRepository => ({ loadRecordedStop: vi.fn(async () => null),
  loadCurrentAttempt: vi.fn(async () => null),
  loadTrustedEvidence: vi.fn(async () => null), admitAndRecord: vi.fn(async () => {
    throw Error("unexpected SQL mutation");
  }) });
describe("worker stop boundary", () => {
  it("remains default off before parsing or authority lookup", async () => {
    const authorize = vi.fn(async () => true), repo = repository();
    const handler = createNativeStopHandler({ enabled: () => false, authorize, repository: repo });
    expect((await handler(request())).status).toBe(503);
    expect(authorize).not.toHaveBeenCalled(); expect(repo.loadCurrentAttempt).not.toHaveBeenCalled();
  });
  it("rejects worker-provided stop verdict, terminal array and forged evidence", async () => {
    const authorize = vi.fn(async () => true), repo = repository();
    const handler = createNativeStopHandler({ enabled: () => true, authorize, repository: repo });
    for (const extra of [{ stopped: true }, { terminalProcesses: [] }, { verdict: "all_owned_processes_exited" }]) {
      expect((await handler(request({ ...body, ...extra }))).status).toBe(400);
    }
    expect((await handler(request(body, `odp_${"b".repeat(64)}`))).status).toBe(401);
    expect((await handler(request())).status).toBe(409);
    expect(repo.admitAndRecord).not.toHaveBeenCalled();
  });
  it("requires authenticated exact attempt before reading private evidence", async () => {
    const authorize = vi.fn(async () => false), repo = repository();
    const handler = createNativeStopHandler({ enabled: () => true, authorize, repository: repo });
    expect((await handler(request())).status).toBe(401);
    expect(repo.loadTrustedEvidence).not.toHaveBeenCalled();
  });
});
