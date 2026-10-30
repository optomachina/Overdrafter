// @vitest-environment node
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptVendorQuoteResult, drainQuoteRunRollups, requireSuccessfulVendorQuoteAcceptance, type VendorQuoteResultFinalization } from "./vendorQuoteOfferPersistence.js";

const task = { id: "task", locked_by: "worker", locked_at: "2026-10-29T12:34:56.123456+00:00", attempts: 2 };
const result: VendorQuoteResultFinalization = {
  status: "instant_quote_received", unit_price_usd: 95, total_price_usd: 95,
  lead_time_business_days: 8, quote_url: null, dfm_issues: [], notes: [], raw_payload: {},
};
function harness(responses: unknown[], drainError = false) {
  let call = 0;
  const rpc = vi.fn(async (name: string) => {
    if (name === "drain_quote_run_rollup_followups") {
      if (drainError) throw new Error("drain unavailable");
      return { data: {}, error: null };
    }
    const value = responses[Math.min(call++, responses.length - 1)];
    if (value instanceof Error) throw value;
    return { data: value, error: null };
  });
  const client = { rpc } as unknown as SupabaseClient;
  return { rpc, client, run: () => acceptVendorQuoteResult(client, task, "result", result, [], { offerCount: 0 }) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("claim-fenced acceptance", () => {
  it("passes the exact microsecond claim and full payload", async () => {
    const h = harness([{ outcome: "accepted" }]);
    expect(await h.run()).toEqual({ outcome: "accepted" });
    expect(h.rpc).toHaveBeenCalledWith("accept_vendor_quote_result", {
      p_task_id: task.id, p_locked_by: task.locked_by, p_locked_at: task.locked_at, p_attempts: task.attempts,
      p_vendor_quote_result_id: "result", p_result: result, p_offers: [], p_task_payload_patch: { offerCount: 0 },
    });
    expect(h.rpc).toHaveBeenLastCalledWith("drain_quote_run_rollup_followups", { p_limit: 50 });
  });
  it("retries busy then accepts within a bounded backoff", async () => {
    vi.useFakeTimers();
    const h = harness([{ outcome: "busy" }, { outcome: "accepted" }]);
    const pending = h.run();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ outcome: "accepted" });
    expect(h.rpc.mock.calls.filter(([name]) => name === "accept_vendor_quote_result")).toHaveLength(2);
  });
  it("exhausts busy after ten attempts as a persistence failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const start = Date.now();
    const h = harness([{ outcome: "busy" }]);
    const assertion = expect(h.run()).rejects.toMatchObject({ code: "persistence_failure", payload: { vendorQuoteResultId: "result", offerKeys: [], acceptanceReason: "acceptance busy" } });
    await vi.runAllTimersAsync();
    await assertion;
    expect(h.rpc).toHaveBeenCalledTimes(10);
    expect(Date.now() - start).toBe(18000);
  });
  it.each(["accepted", "request_canceled"])("replays the identical call after losing a %s acknowledgement", async (original_outcome) => {
    vi.useFakeTimers();
    const h = harness([new Error("lost response"), { outcome: "replayed", original_outcome }]);
    const pending = h.run();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ outcome: "replayed", original_outcome });
    expect(h.rpc.mock.calls[0]).toEqual(h.rpc.mock.calls[1]);
    expect(h.rpc).toHaveBeenCalledTimes(3);
  });
  it("retries a missing response with the same receipt key", async () => {
    vi.useFakeTimers();
    const h = harness([null, { outcome: "replayed", original_outcome: "accepted" }]);
    const pending = h.run();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ outcome: "replayed", original_outcome: "accepted" });
    expect(h.rpc.mock.calls[0]).toEqual(h.rpc.mock.calls[1]);
  });
  it.each(["EPIPE", "P0001"])("retries thrown errno but not SQLSTATE %s", async (code) => {
    vi.useFakeTimers();
    const h = harness([Object.assign(new Error("RPC failed"), { code }), { outcome: "accepted" }]);
    const pending = h.run();
    const assertion = code === "EPIPE"
      ? expect(pending).resolves.toEqual({ outcome: "accepted" })
      : expect(pending).rejects.toMatchObject({ code: "persistence_failure", payload: { acceptanceReason: "RPC failed" } });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(h.rpc.mock.calls.filter(([name]) => name === "accept_vendor_quote_result")).toHaveLength(code === "EPIPE" ? 2 : 1);
  });
  it.each(["P0001", "22P02", "42501"])("does not retry SQLSTATE %s from PostgREST", async (code) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code, message: "RPC rolled back", details: "", hint: "" }), { status: 400 }));
    const client = createClient("http://localhost:54321", "synthetic-key", { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const rpc = vi.spyOn(client, "rpc");
    await expect(acceptVendorQuoteResult(client, task, "result", result, [], {})).rejects.toMatchObject({
      code: "persistence_failure",
      payload: { vendorQuoteResultId: "result", offerKeys: [], acceptanceReason: "RPC rolled back" },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["network", "gateway", "missing"])("retries an ambiguous %s response surfaced by supabase-js", async (kind) => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementationOnce(async () => {
      if (kind === "network") throw Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" });
      return new Response(kind === "gateway" ? "Bad Gateway" : null, { status: kind === "gateway" ? 502 : 204 });
    }).mockImplementation(async () => new Response(JSON.stringify({ outcome: "replayed", original_outcome: "accepted" }), { status: 200 }));
    const client = createClient("http://localhost:54321", "synthetic-key", { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const pending = acceptVendorQuoteResult(client, task, "result", result, [], {});
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ outcome: "replayed", original_outcome: "accepted" });
    expect(fetch).toHaveBeenCalledTimes(3); // Two acceptances and the rollup drain.
  });
  it("keeps the transport budget separate from busy attempts", async () => {
    vi.useFakeTimers();
    const h = harness([...Array.from({ length: 9 }, () => ({ outcome: "busy" })), new Error("lost acknowledgement")]);
    const assertion = expect(h.run()).rejects.toMatchObject({
      payload: { vendorQuoteResultId: "result", offerKeys: [], acceptanceReason: "lost acknowledgement" },
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(h.rpc).toHaveBeenCalledTimes(12);
  });
  it.each(["stale", "fenced", "payload_mismatch"])("returns typed %s without draining", async (outcome) => {
    const h = harness([{ outcome }]);
    expect(await h.run()).toEqual({ outcome });
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(["accepted", "request_canceled", "replayed"])("a drain failure cannot fail %s", async (outcome) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness([{ outcome, original_outcome: "accepted" }], true);
    expect(await h.run()).toMatchObject({ outcome });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"source":"worker.quote_run_rollups"'));
  });
  it("logs RPC drain errors without throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(drainQuoteRunRollups({ rpc: async () => ({ error: new Error("db") }) } as unknown as SupabaseClient)).resolves.toBeUndefined();
  });
  it.each(["fenced", "payload_mismatch"] as const)("rejects %s with the existing failure code", (outcome) => {
    expect(() => requireSuccessfulVendorQuoteAcceptance({ outcome })).toThrow(expect.objectContaining({ code: "persistence_failure" }));
  });
});
