// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityPersistenceTransport } from "./providerCapabilityPersistenceTransport.js";
const key = "canary:" + "a".repeat(64), owner = "11111111-1111-4111-8111-111111111111";
const request = { windowKey: key, resourceKey: "b".repeat(64), configDigest: "c".repeat(64), requestKey: owner, provider: "xometry", route: "quote_home", surface: "account_quote_modal", surfaceRevision: "modal.v1", windowStart: "2026-10-02T12:00:00.000Z", windowEnd: "2026-10-02T13:00:00.000Z", leaseSeconds: 30 };
const receipt = { status: "claimed", windowKey: key, owner, fence: "22222222-2222-4222-8222-222222222222", generation: 1, observationRevision: 1, deadline: "2026-10-02T12:00:30.000001+00:00" };
function fixture(data: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }));
  const client = createClient("https://synthetic.invalid", "synthetic-key", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } });
  return { transport: createCapabilityPersistenceTransport(client), client, fetch };
}
afterEach(() => vi.useRealTimers());
describe("canonical persistence SDK mapping", () => {
  it("uses actual SDK lazy RPC, unwraps canonical success and preserves exact UTC receipt", async () => {
    const f = fixture(receipt);
    expect(await f.transport.claim(request, new AbortController().signal)).toEqual(receipt);
    expect(f.fetch).toHaveBeenCalledOnce();
    const [url, init] = f.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/rest/v1/rpc/api_claim_capability_window");
    expect(JSON.parse(init.body as string)).toEqual({ p_input: request });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([{ status: "claimed", ...receipt, observationRevision: 0 }, { private: "secret" }, null])("rejects malformed canonical response without leaking payload", async data => {
    const f = fixture(data);
    await expect(f.transport.claim(request, new AbortController().signal)).rejects.toThrow("capability_persistence_unavailable");
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("validates input before SDK dispatch and blocks aborted calls", async () => {
    const f = fixture(receipt);
    await expect(f.transport.claim({ ...request, leaseSeconds: 0 }, new AbortController().signal)).rejects.toThrow();
    const c = new AbortController(); c.abort();
    await expect(f.transport.claim(request, c.signal)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("captures SDK method reference and maps read, get and bounded due-list helpers", async () => {
    const f = fixture(null); const replacement = vi.fn(); f.client.rpc = replacement as never;
    expect(await f.transport.readAttention("a".repeat(64), new AbortController().signal)).toBeNull();
    expect(replacement).not.toHaveBeenCalled();
    const g = fixture({ status: "unknown" }); expect(await g.transport.get(key, owner, new AbortController().signal)).toEqual({ status: "unknown" });
    const h = fixture([]); expect(await h.transport.listDueAttention(100, new AbortController().signal)).toEqual([]);
    await expect(h.transport.listDueAttention(101, new AbortController().signal)).rejects.toThrow();
    expect(h.fetch).toHaveBeenCalledOnce();
  });
  it("propagates cancellation to the actual fetch signal and bounds a non-cooperative reply", async () => {
    vi.useFakeTimers(); const f = fixture(receipt); let transportSignal: AbortSignal | undefined;
    f.fetch.mockImplementation((_url?: unknown, init?: RequestInit) => { transportSignal = init?.signal ?? undefined; return new Promise(() => undefined); });
    const c = new AbortController(); const pending = f.transport.claim(request, c.signal);
    const assertion = expect(pending).rejects.toThrow("capability_persistence_unavailable");
    await vi.advanceTimersByTimeAsync(0); c.abort(); await assertion;
    expect(transportSignal?.aborted).toBe(true); expect(f.fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
