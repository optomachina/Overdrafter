// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOperationsStatus } from "./operations-status-client";
import { OPERATIONS_CATEGORIES, OPERATIONS_SCHEMA, OPERATIONS_SUMMARIES } from "./contract";
const session = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { getSession: session } } }));
const fetcher = vi.fn();
function snapshot() {
  const generatedAt = new Date(Date.now() - 1000).toISOString();
  return { schema: OPERATIONS_SCHEMA, generatedAt, refreshAfterMs: 30000,
    counts: { healthy: 0, attention: 0, blocked: 0, unknown: 9 },
    items: OPERATIONS_CATEGORIES.map((category) => ({ key: `${category}:database`, category, subsystem: "database", provider: null,
      severity: "unknown", context: { build: null, model: null, runtime: null, adapterVersion: null, sessionEvidenceAgeDays: null, sessionEvidenceKind: null, taskType: null, taskStartedAt: null, taskCompletedAt: null, taskFailedAt: null },
      reasonCode: "source_unavailable", summary: OPERATIONS_SUMMARIES.source_unavailable,
      firstSeenAt: null, lastSeenAt: null, changedAt: null, lastCheckedAt: null,
      freshness: { state: "unknown", ageMs: null, maxAgeMs: null, expiresAt: null }, occurrenceCount: null, action: null })) };
}
const response = (data: unknown = snapshot()) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("fetch", fetcher);
  session.mockResolvedValue({ data: { session: { user: { id: "admin" }, access_token: "synthetic-not-a-credential" } }, error: null });
  fetcher.mockImplementation(() => Promise.resolve(response()));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("bounded Operations status client", () => {
  it("uses only the fixed same-origin authenticated read and admits the closed projection", async () => {
    const data = snapshot(); fetcher.mockResolvedValue(response(data));
    expect(await fetchOperationsStatus(new AbortController().signal, "admin")).toEqual(data);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/admin-operations", expect.objectContaining({ method: "GET", credentials: "omit", cache: "no-store", redirect: "error", headers: { authorization: "Bearer synthetic-not-a-credential", accept: "application/json" } }));
  });
  it("refuses a session belonging to a different query subject before HTTP", async () => {
    await expect(fetchOperationsStatus(new AbortController().signal, "different-admin")).rejects.toMatchObject({ code: "access_denied" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403])("classifies access denial %s without exposing a response body", async (status) => {
    fetcher.mockResolvedValue(new Response("private response", { status }));
    await expect(fetchOperationsStatus(new AbortController().signal, "admin")).rejects.toMatchObject({ code: "access_denied", message: "Operations access unavailable." });
  });
  it("does not read without a session or after caller cancellation", async () => {
    session.mockResolvedValue({ data: { session: null }, error: null });
    await expect(fetchOperationsStatus(new AbortController().signal, "admin")).rejects.toMatchObject({ code: "access_denied" });
    expect(fetcher).not.toHaveBeenCalled();
    session.mockClear(); const controller = new AbortController(); controller.abort();
    await expect(fetchOperationsStatus(controller.signal, "admin")).rejects.toMatchObject({ code: "unavailable" });
    expect(session).not.toHaveBeenCalled();
  });
  it.each(["private summary", "extra field", "future snapshot", "missing category", "unsafe action"])("rejects %s with only a safe error", async (invalid) => {
    const data = snapshot();
    if (invalid === "private summary") Object.assign(data.items[0], { summary: "customer-filename-private.step" });
    if (invalid === "extra field") Object.assign(data.items[0], { account: "private-account" });
    if (invalid === "future snapshot") data.generatedAt = new Date(Date.now() + 60_000).toISOString();
    if (invalid === "missing category") data.items.pop();
    if (invalid === "unsafe action") Object.assign(data.items[0], { action: { kind: "spend_control", href: "https://private.invalid" } });
    fetcher.mockResolvedValue(response(data));
    await expect(fetchOperationsStatus(new AbortController().signal, "admin")).rejects.toMatchObject({ code: "unavailable", message: "Operations status unavailable." });
  });
  it("refuses oversized text and malformed UTF-8 without leaking parser diagnostics", async () => {
    for (const bytes of [new Uint8Array(131073), new Uint8Array([255])]) {
      fetcher.mockResolvedValue(new Response(bytes, { headers: { "content-type": "application/json" } }));
      await expect(fetchOperationsStatus(new AbortController().signal, "admin")).rejects.toThrow("Operations status unavailable.");
    }
  });
  it.each([9999, 10000, 10001])("checks elapsed %s ms before starting fetch after session retrieval", async (elapsed) => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    session.mockImplementation(() => { now = elapsed; return Promise.resolve({ data: { session: { user: { id: "admin" }, access_token: "synthetic" } }, error: null }); });
    if (elapsed < 10000) await expect(fetchOperationsStatus(new AbortController().signal, "admin")).resolves.toHaveProperty("schema", OPERATIONS_SCHEMA);
    else await expect(fetchOperationsStatus(new AbortController().signal, "admin")).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(elapsed < 10000 ? 1 : 0);
  });
  it("bounds hung fetch and disposes a late response without another request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finish!: (value: Response) => void;
    fetcher.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = fetchOperationsStatus(new AbortController().signal, "admin");
    const rejected = expect(pending).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(10000); await rejected;
    const cancel = vi.fn(); finish(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps body reads inside the same elapsed budget", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    fetcher.mockImplementation(() => Promise.resolve(new Response(new ReadableStream({ pull(controller) {
      now = 10000; controller.enqueue(new TextEncoder().encode(JSON.stringify(snapshot()))); controller.close();
    } }), { headers: { "content-type": "application/json" } })));
    await expect(fetchOperationsStatus(new AbortController().signal, "admin")).rejects.toMatchObject({ code: "unavailable" });
  });
});
