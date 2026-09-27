// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { createNativeStopHandler } from "./native-stop-transport";
import { createNativeStopRepository } from "./native-stop-repository";

const id = (n: number) => `50100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const payload = { schema: "overdrafter.native-stop-request.v1", action: "record_stop", workerId: id(1),
  bootId: id(2), taskId: id(3), attemptId: id(4), fence: 1, evidenceId: id(5), revision: 1, idempotencyKey: id(6) };
const receipt = { outcome: "process_stopped", attemptId: id(4), revision: 2, taskRevision: 3,
  resultEligible: true, phase: "awaiting_result", failureCode: null, verification: "unverified" };
const workerToken = `odw_${"a".repeat(64)}`;
const executorToken = (role = "ovd576_stop_validator") => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role })).replaceAll("=", "")}.fixture`;
const request = (body: unknown = payload, extra: RequestInit = {}) => new Request("https://fixture.invalid/functions/v1/engineering-worker-stop", {
  method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" }, body: JSON.stringify(body), ...extra,
});
function setup(fetcher: typeof fetch = vi.fn(async () => Response.json(receipt)) as unknown as typeof fetch) {
  const repository = vi.fn(() => createNativeStopRepository({ url: "https://executor.invalid", token: executorToken(), fetch: fetcher }));
  return { repository, fetcher, handler: createNativeStopHandler({ enabled: () => true, repository, deadlineMs: 50 }) };
}
describe("native stop restricted HTTP path", () => {
  it("disabled performs no repository construction, body read or fetch", async () => {
    const repository = vi.fn();
    const result = await createNativeStopHandler({ enabled: () => false, repository })(request());
    expect(result.status).toBe(503); expect(repository).not.toHaveBeenCalled();
    expect(await result.json()).toMatchObject({ outcome: "not_applied", retrySameRequest: false });
  });
  it("forwards exact checked identity and credential hash, never raw token or worker verdict", async () => {
    const { handler, fetcher } = setup();
    const result = await handler(request());
    expect(await result.json()).toMatchObject({ receipt });
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(url).toBe("https://executor.invalid/rpc/admit_qualified_native_stop");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("content-profile")).toBe("engineering_private");
    const args = JSON.parse(init?.body as string);
    expect(args).toEqual({ p_worker: id(1), p_credential: expect.stringMatching(/^[a-f0-9]{64}$/), p_boot: id(2),
      p_task: id(3), p_attempt: id(4), p_fence: 1, p_evidence: id(5), p_revision: 1, p_key: id(6) });
    expect(JSON.stringify(args)).not.toContain(workerToken);
  });
  it("accepts the final safe fence supported by checked SQL", async () => {
    const { handler, fetcher } = setup();
    expect((await handler(request({ ...payload, fence: Number.MAX_SAFE_INTEGER }))).status).toBe(200);
    expect(JSON.parse(vi.mocked(fetcher).mock.calls[0][1]?.body as string).p_fence).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("accepts a committed receipt at the SQL task revision ceiling", async () => {
    const terminal = { ...receipt, taskRevision: Number.MAX_SAFE_INTEGER };
    const { handler } = setup(vi.fn(async () => Response.json(terminal)) as unknown as typeof fetch);
    expect(await (await handler(request())).json()).toMatchObject({ receipt: terminal });
  });
  it.each([{ verdict: "all_owned_processes_exited" }, { terminalProcesses: [] }, { fence: 0 }, { revision: -1 },
    { fence: Number.MAX_SAFE_INTEGER + 1 }, { attemptId: "not-an-id" }, { action: "reconcile" }])("rejects untrusted shape %j without calls", async (patch) => {
    const { handler, repository } = setup();
    expect((await handler(request({ ...payload, ...patch }))).status).toBe(400);
    expect(repository).not.toHaveBeenCalled();
  });
  it.each(["origin", "cookie", "content-encoding"])("rejects %s", async (header) => {
    const { handler, repository } = setup(); const req = request(); req.headers.set(header, "x");
    expect((await handler(req)).status).toBe(400); expect(repository).not.toHaveBeenCalled();
  });
  it("rejects invalid bearer and oversized streamed body", async () => {
    const { handler, repository } = setup(); const req = request(); req.headers.set("authorization", "Bearer wrong");
    expect((await handler(req)).status).toBe(401);
    expect((await handler(request("x".repeat(2050)))).status).toBe(400); expect(repository).not.toHaveBeenCalled();
  });
  it.each(["service_role", "authenticated", "anon"])("never dispatches with %s executor", async (role) => {
    const fetcher = vi.fn();
    const handler = createNativeStopHandler({ enabled: () => true,
      repository: () => createNativeStopRepository({ url: "https://executor.invalid", token: executorToken(role), fetch: fetcher }) });
    const result = await handler(request()); expect(result.status).toBe(503); expect(fetcher).not.toHaveBeenCalled();
    expect(await result.json()).toMatchObject({ outcome: "not_applied" });
  });
  it.each([["42501",401],["PT409",409],["22023",400]])("reports deterministic SQL rejection %s", async (code, status) => {
    const { handler } = setup(vi.fn(async () => Response.json({ code }, { status: 400 })) as unknown as typeof fetch);
    const result = await handler(request()); expect(result.status).toBe(status);
    expect(await result.json()).toMatchObject({ outcome: "not_applied", retrySameRequest: false });
  });
  it("lost committed response requires same-key retry which returns original receipt", async () => {
    let committed: unknown; let calls = 0;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const args = JSON.parse(init?.body as string); calls++;
      if (calls === 1) { committed = args; throw new TypeError("response lost after commit"); }
      expect(args).toEqual(committed); return Response.json(receipt);
    }) as unknown as typeof fetch;
    const { handler } = setup(fetcher);
    expect(await (await handler(request())).json()).toMatchObject({ outcome: "unknown", retrySameRequest: true });
    expect(await (await handler(request())).json()).toMatchObject({ receipt });
  });
  it("deadline bounds a noncooperative executor without implying rollback", async () => {
    const { handler } = setup(vi.fn(() => new Promise(() => {})) as unknown as typeof fetch);
    expect(await (await handler(request())).json()).toMatchObject({ outcome: "unknown", retrySameRequest: true });
  });
  it("an already aborted request performs zero mutation", async () => {
    const { handler, repository } = setup(); const controller = new AbortController(); controller.abort();
    expect(await (await handler(request(payload, { signal: controller.signal }))).json()).toMatchObject({ outcome: "not_applied" });
    expect(repository).not.toHaveBeenCalled();
  });
  it.each([{ verification: "verified" }, { attemptId: id(99) }, { resultEligible: true, phase: "failed" }, { revision: 99 }])("invalid post-commit receipt stays unknown %j", async (patch) => {
    const { handler } = setup(vi.fn(async () => Response.json({ ...receipt, ...patch })) as unknown as typeof fetch);
    expect(await (await handler(request())).json()).toMatchObject({ outcome: "unknown", retrySameRequest: true });
  });
});
