// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminOperationsHandler, type AdminOperationsRuntime } from "./handler";
import endpoint from "../../api/admin-operations";
import { parseOperationsSnapshot } from "../../src/features/operations/contract";

const subject = "00000000-0000-4000-8000-000000000001";
const token = "synthetic-admin-jwt-acceptance";
const secret = "PRIVATE_DIAGNOSTIC_CUSTOMER_ACCOUNT_TOKEN";
const url = "https://app.example.invalid/api/admin-operations";
function request(options: RequestInit = {}) {
  return new Request(url, { headers: { authorization: `Bearer ${token}` }, ...options });
}
function fixture() {
  const authenticate = vi.fn(async () => ({ userId: subject }));
  const isPlatformAdmin = vi.fn(async (): Promise<unknown> => true);
  const read = vi.fn(async () => { throw new Error(secret); });
  const runtime: AdminOperationsRuntime = { authenticate, isPlatformAdmin, read };
  return { authenticate, isPlatformAdmin, read, handler: createAdminOperationsHandler(runtime) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("independent operations access and isolation acceptance", () => {
  it.each([false, null, undefined, 1, "true", [true], { isPlatformAdmin: true }])("requires exact boolean admin verdict %j before every source", async verdict => {
    const f = fixture(); f.isPlatformAdmin.mockResolvedValue(verdict);
    const response = await f.handler(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("a transient auth failure exposes no diagnostic and never checks admin or sources", async () => {
    const f = fixture(); f.authenticate.mockRejectedValue(new Error(secret));
    const response = await f.handler(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(secret);
    expect(f.isPlatformAdmin).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("admin RPC errors fail closed without source effects or diagnostic leakage", async () => {
    const f = fixture(); f.isPlatformAdmin.mockRejectedValue(new Error(secret));
    const response = await f.handler(request());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(secret);
    expect(f.read).not.toHaveBeenCalled();
  });
  it("malformed authenticated identity is never upgraded using an admin verdict", async () => {
    const f = fixture(); f.authenticate.mockResolvedValue({ userId: "not-a-user-uuid" });
    expect((await f.handler(request())).status).toBe(401);
    expect(f.isPlatformAdmin).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("authenticates then checks that same token and authenticated subject before sources", async () => {
    const f = fixture(); const response = await f.handler(request());
    expect(f.authenticate).toHaveBeenCalledWith(token, expect.any(AbortSignal));
    expect(f.isPlatformAdmin).toHaveBeenCalledWith(token, subject, expect.any(AbortSignal));
    expect(f.authenticate.mock.invocationCallOrder[0]).toBeLessThan(f.isPlatformAdmin.mock.invocationCallOrder[0]);
    expect(f.isPlatformAdmin.mock.invocationCallOrder[0]).toBeLessThan(f.read.mock.invocationCallOrder[0]);
    expect(f.read).toHaveBeenCalledTimes(6);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
    const body = await response.text(); expect(body).not.toContain(secret); expect(body).not.toContain(token); expect(body).not.toContain(subject);
    const snapshot = parseOperationsSnapshot(JSON.parse(body));
    expect(snapshot.items.filter(item => item.category !== "spend").every(item => item.severity === "unknown")).toBe(true);
  });
  it.each([
    new Request(`${url}?url=https://attacker.invalid/worker`, { headers: { authorization: `Bearer ${token}` } }),
    request({ method: "POST" }),
    request({ headers: { authorization: `Bearer ${token}`, origin: "https://attacker.invalid" } }),
    request({ headers: {} }),
  ])("rejects malformed/cross-origin/caller-selected access without any dependency", async req => {
    const f = fixture(); expect((await f.handler(req)).status).toBeGreaterThanOrEqual(400);
    expect(f.authenticate).not.toHaveBeenCalled(); expect(f.isPlatformAdmin).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("pre-aborted requests do not authenticate", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    expect((await f.handler(request({ signal: controller.signal }))).status).toBe(503);
    expect(f.authenticate).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("elapsed authentication budget blocks the next effect even when timers have not fired", async () => {
    const f = fixture(); let monotonic = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    f.authenticate.mockImplementation(async () => { monotonic = 1501; return { userId: subject }; });
    expect((await f.handler(request())).status).toBe(503);
    expect(f.isPlatformAdmin).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("elapsed admin budget cannot start private reads even when timers have not fired", async () => {
    const f = fixture(); let monotonic = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    f.isPlatformAdmin.mockImplementation(async () => { monotonic = 1501; return true; });
    expect((await f.handler(request())).status).toBe(503);
    expect(f.read).not.toHaveBeenCalled();
  });
});


describe("actual API entrypoint with synthetic HTTP dependencies", () => {
  function install(admin: unknown = true, authStatus = 200, sourceBody: (url: URL) => unknown = () => [], completeReceipt = true, totalOverride?: number) {
    vi.stubEnv("SUPABASE_URL", "https://database.example.invalid");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "synthetic-public-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-role-key");
    vi.stubEnv("WORKER_BASE_URL", "https://worker.example.invalid");
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const target = new URL(String(input)); calls.push({ url: target, init });
      if (target.pathname === "/auth/v1/user") return Response.json({ id: subject }, { status: authStatus });
      if (target.pathname === "/rest/v1/rpc/api_get_is_platform_admin") return Response.json(admin);
      if (target.pathname === "/healthz") return Response.json({ privateDiagnostic: secret }, { status: 503 });
      const payload = sourceBody(target);
      const count = Array.isArray(payload) ? payload.length : 0;
      return Response.json(payload, { headers: completeReceipt ? { "content-range": count ? `0-${count - 1}/${totalOverride ?? count}` : `*/${totalOverride ?? 0}` } : {} });
    }));
    return calls;
  }
  it.each([false, "true", [true], { value: true }])("real runtime denies nonboolean/negative RPC %j with no service role use", async verdict => {
    const calls = install(verdict); const response = await endpoint.fetch(request());
    expect(response.status).toBe(403); expect(calls).toHaveLength(2);
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(headers.get("apikey")).toBe("synthetic-public-key");
    }
  });
  it("transient upstream authentication failure cannot reach RPC or service role", async () => {
    const calls = install(true, 503); const response = await endpoint.fetch(request());
    expect(response.status).toBe(503); expect(calls).toHaveLength(1);
    expect(await response.text()).not.toContain(secret);
  });
  it("real runtime keeps user JWT for auth, service role only for reads, and safe selectors/redirect policy", async () => {
    const calls = install(); const response = await endpoint.fetch(request());
    expect(response.status).toBe(200);
    expect(calls.slice(0, 2).map(call => call.url.pathname)).toEqual(["/auth/v1/user", "/rest/v1/rpc/api_get_is_platform_admin"]);
    for (const call of calls) {
      expect(call.init.redirect).toBe("error");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      if (call.url.pathname.startsWith("/rest/v1/") && !call.url.pathname.includes("/rpc/")) {
        expect(call.init.method).toBe("GET");
        expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer synthetic-service-role-key");
        expect(call.url.searchParams.get("select")).not.toContain("*");
        expect(call.url.searchParams.get("select")).not.toMatch(/(?:^|,)(?:payload|error|email|id)(?:,|$)/);
        expect(call.url.searchParams.get("limit")).toBe("201");
        expect(new Headers(call.init.headers).get("prefer")).toBe("count=exact");
      }
    }
    const text = await response.text(); expect(text).not.toContain(secret); expect(text).not.toContain("synthetic-service-role-key");
    const snapshot = parseOperationsSnapshot(JSON.parse(text));
    for (const category of ["worker", "runtime", "provider_session", "extraction_quality", "upload_capability"]) {
      expect(snapshot.items.filter(item => item.category === category).every(item => item.severity === "unknown")).toBe(true);
    }
  });
  it("PostgREST timestamp precision is accepted without inventing incident timestamps", async () => {
    const stamp = new Date(Date.now() - 1000).toISOString().replace("Z", "000+00:00");
    install(true, 200, target => target.searchParams.get("status") === "in.(queued,running)" ? [{
      status: "queued", task_type: "extract_part", attempts: 0, locked_at: null,
      available_at: stamp, created_at: stamp, updated_at: stamp,
    }] : []);
    const response = await endpoint.fetch(request()); expect(response.status).toBe(200);
    const result = parseOperationsSnapshot(await response.json());
    const queue = result.items.find(item => item.category === "queue")!;
    expect(queue.reasonCode).toBe("queued_work"); expect(queue.severity).toBe("attention");
    expect(queue.firstSeenAt).toBeNull(); expect(queue.changedAt).toBeNull();
  });
  it("one oversized source remains Unknown while independent empty queue remains healthy", async () => {
    install(true, 200, target => target.pathname.endsWith("jobs") ? Array.from({length:201}, () => ({})) : []);
    const response = await endpoint.fetch(request()); expect(response.status).toBe(200);
    const result = parseOperationsSnapshot(await response.json());
    expect(result.items.find(item => item.category === "quote_attention")?.severity).toBe("unknown");
    expect(result.items.find(item => item.category === "queue")?.severity).toBe("healthy");
  });
  it("invalid extraction metrics cannot be labeled as a known alert", async () => {
    install(true, 200, target => target.pathname.endsWith("extraction_quality_alerts") ? [{
      alert_type: "model_fallback_rate_high", metric_value: 0.9, threshold_value: "private-secret", alert_day: "invalid", created_at: new Date().toISOString(),
    }] : []);
    const response = await endpoint.fetch(request()); expect(response.status).toBe(200);
    const result = parseOperationsSnapshot(await response.json());
    expect(result.items.find(item => item.category === "extraction_quality")?.severity).toBe("unknown");
  });

  it("current manual-review jobs use current job state and future queue entries stay visible", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const calls = install(true, 200, target => target.pathname.endsWith("jobs") ? [{status:"awaiting_vendor_manual_review",created_at:past,updated_at:past}]
      : target.searchParams.get("status") === "in.(queued,running)" ? [{status:"queued",task_type:"extract_part",attempts:0,locked_at:null,available_at:future,created_at:past,updated_at:past}] : []);
    const response = await endpoint.fetch(request()); expect(response.status).toBe(200);
    const result = parseOperationsSnapshot(await response.json());
    expect(result.items.find(item => item.category === "quote_attention")?.reasonCode).toBe("manual_followup");
    expect(result.items.find(item => item.category === "queue")?.reasonCode).toBe("scheduled_work");
    expect(calls.some(call => call.url.pathname.endsWith("vendor_quote_results"))).toBe(false);
    const queue = calls.find(call => call.url.searchParams.get("status") === "in.(queued,running)")!;
    expect(queue.url.searchParams.has("available_at")).toBe(false);
  });
  it("API rewrite precedes SPA fallback in the actual deployment configuration", () => {
    const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
    const route = config.rewrites.findIndex((entry: {source:string}) => entry.source === "/api/admin-operations");
    const fallback = config.rewrites.findIndex((entry: {source:string}) => entry.source === "/(.*)");
    expect(route).toBeGreaterThanOrEqual(0); expect(route).toBeLessThan(fallback);
    expect(config.rewrites[route].destination).toBe("/api/admin-operations");
  });

  it("missing database completeness receipts cannot turn empty/truncated observations healthy", async () => {
    install(true, 200, () => [], false);
    const response = await endpoint.fetch(request()); expect(response.status).toBe(200);
    const result = parseOperationsSnapshot(await response.json());
    for (const category of ["queue", "task_failure", "quote_attention", "extraction_quality"]) {
      expect(result.items.find(item => item.category === category)?.severity).toBe("unknown");
    }
  });

  it("backend row limits below the requested cap cannot certify a partial queue as complete", async () => {
    const stamp = new Date(Date.now() - 1000).toISOString();
    install(true, 200, target => target.searchParams.get("status") === "in.(queued,running)" ? [{
      status:"queued", task_type:"extract_part", attempts:0, locked_at:null, available_at:stamp, created_at:stamp, updated_at:stamp,
    }] : [], true, 50);
    const response = await endpoint.fetch(request()); expect(response.status).toBe(200);
    const result = parseOperationsSnapshot(await response.json());
    expect(result.items.find(item => item.category === "queue")?.severity).toBe("unknown");
  });

});
