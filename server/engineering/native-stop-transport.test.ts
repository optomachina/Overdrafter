// @vitest-environment node
import { afterEach, describe, it, expect, vi } from "vitest";
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
function setup(fetcher: typeof fetch = vi.fn(async () => Response.json(receipt)) as unknown as typeof fetch, deadlineMs?: number) {
  const repository = vi.fn(() => createNativeStopRepository({ url: "https://executor.invalid", token: executorToken(), fetch: fetcher }));
  return { repository, fetcher, handler: createNativeStopHandler({ enabled: () => true, repository, deadlineMs }) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("native stop restricted HTTP path", () => {
  it.each(["body", "hash", "repository", "admission"].flatMap((phase) =>
    [4999, 5000, 5001].map((elapsed) => ({ phase, elapsed }))))(
    "enforces the elapsed budget during $phase at $elapsed ms before the timer runs", async ({ phase, elapsed }) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
        const value = await digest(...args);
        if (phase === "hash") now = elapsed;
        return value;
      });
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(init?.signal?.aborted).toBe(false);
        if (phase === "admission") now = elapsed;
        return Response.json(receipt);
      });
      const repository = vi.fn(() => {
        if (phase === "repository") now = elapsed;
        return createNativeStopRepository({ url: "https://executor.invalid", token: executorToken(), fetch: fetcher });
      });
      const handler = createNativeStopHandler({ enabled: () => true, repository });
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      let sent = false;
      const body = new ReadableStream<Uint8Array>({ pull(stream) {
        if (sent) { stream.close(); return; }
        sent = true;
        if (phase === "body") now = elapsed;
        stream.enqueue(bytes);
      } }, { highWaterMark: 0 });
      const response = await handler(request(payload, { body, duplex: "half" } as RequestInit));
      const expired = elapsed >= 5000;
      const attempted = phase === "admission";
      expect(response.status).toBe(expired ? 503 : 200);
      expect(await response.json()).toMatchObject(expired
        ? { error: "stop_deadline", outcome: attempted ? "unknown" : "not_applied", retrySameRequest: attempted }
        : { receipt });
      expect(repository).toHaveBeenCalledTimes(expired && (phase === "body" || phase === "hash") ? 0 : 1);
      expect(fetcher).toHaveBeenCalledTimes(expired && !attempted ? 0 : 1);
      if (expired && attempted) expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    },
  );
  it("keeps a late executor denial unknown under the original retry identity", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let firstArguments: unknown;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const args = JSON.parse(init?.body as string);
      if (!firstArguments) {
        firstArguments = args;
        now = 5001;
        return Response.json({ code: "PT409" }, { status: 409 });
      }
      expect(args).toEqual(firstArguments);
      expect(args.p_key).toBe(payload.idempotencyKey);
      return Response.json(receipt);
    });
    const { handler } = setup(fetcher);
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "stop_deadline", outcome: "unknown", retrySameRequest: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await (await handler(request())).json()).toMatchObject({ receipt });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([51, 5000])("preserves the production deadline when hashing takes %s ms", async (delay) => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(workerToken));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let entered!: () => void, release!: () => void;
    const hashing = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(hash); entered();
    }));
    const { handler, repository, fetcher } = setup(vi.fn(async () => Response.json({ ...receipt, verification: "verified" })) as unknown as typeof fetch);
    const pending = handler(request());
    await hashing;
    await vi.advanceTimersByTimeAsync(delay);
    release();
    const result = await pending;
    expect(result.status).toBe(503);
    if (delay < 5000) {
      expect(await result.json()).toMatchObject({ error: "stop_outcome_unknown", outcome: "unknown", retrySameRequest: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } else {
      expect(await result.json()).toMatchObject({ error: "stop_deadline", outcome: "not_applied", retrySameRequest: false });
      expect(repository).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
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
  it.each(["before", "after"])("rejects empty stream chunks %s the payload without admission", async (position) => {
    const { handler, repository } = setup();
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const cancel = vi.fn();
    let reads = 0;
    // Finite reproduction: the old reader drains all 4096 empty chunks and
    // admits the payload. An endless eager source can also starve its timer.
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        const index = reads++;
        if (index === (position === "before" ? 4096 : 0)) stream.enqueue(bytes);
        else if (index <= 4096) stream.enqueue(new Uint8Array());
        else stream.close();
      }, cancel,
    }, { highWaterMark: 0 });
    const result = await handler(request(payload, { body, duplex: "half" } as RequestInit));
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: "invalid_request", outcome: "not_applied", retrySameRequest: false });
    expect(repository).not.toHaveBeenCalled();
    expect(reads).toBe(position === "before" ? 1 : 2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("accepts a valid payload fragmented into one-byte chunks", async () => {
    const { handler } = setup();
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (offset === bytes.length) stream.close();
        else stream.enqueue(bytes.slice(offset, ++offset));
      },
    });
    expect(await (await handler(request(payload, { body, duplex: "half" } as RequestInit))).json()).toMatchObject({ receipt });
  });
  it("rejects an empty stream ending normally without admission", async () => {
    const { handler, repository } = setup();
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.close(); } });
    const result = await handler(request(payload, { body, duplex: "half" } as RequestInit));
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: "invalid_request", outcome: "not_applied" });
    expect(repository).not.toHaveBeenCalled();
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
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(workerToken));
    // Keep the real timer, but remove asynchronous hashing from the short
    // fixture budget so this test specifically reaches post-dispatch expiry.
    vi.spyOn(crypto.subtle, "digest").mockResolvedValueOnce(hash);
    const { handler, fetcher } = setup(vi.fn(() => new Promise(() => {})) as unknown as typeof fetch, 50);
    const result = await handler(request());
    expect(result.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await result.json()).toMatchObject({ error: "stop_deadline", outcome: "unknown", retrySameRequest: true });
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
