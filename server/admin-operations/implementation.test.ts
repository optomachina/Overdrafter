// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminOperationsHandler, type AdminOperationsRuntime } from "./handler";
import { projectOperations, type SourceName, type SourceObservation } from "./projection";
import { createAdminOperationsRuntime, databaseTimestamp } from "./runtime";
import { withinBudget, readBoundedJson } from "./budget";
const now = Date.parse("2026-10-02T12:00:00.000Z");
const checked = new Date(now).toISOString();
const userId = "11111111-1111-4111-8111-111111111111";
const token = "synthetic_user_token_123456";
const env = { SUPABASE_URL: "https://database.invalid", SUPABASE_PUBLISHABLE_KEY: "synthetic_public", SUPABASE_SERVICE_ROLE_KEY: "synthetic_service", WORKER_BASE_URL: "https://worker.invalid" };
function source(payload: unknown): SourceObservation { return { payload, fetchedAt: checked }; }
function worker() { return source({ service: "overdrafter-cad-worker", ready: true, status: "running", readinessIssues: [], lastLoopAt: checked,
  workerBuildVersion: "abcdef123456", workerMode: "live", drawingExtractionModel: "gpt-5.4", xometry_session_age_days: 1.5,
  lastTaskCompletedAt: checked, currentTask: { id: "private-id", type: "extract_part" }, recentEvents: ["private customer file"], lastError: "private secret" }); }
function queue(patch: Record<string, unknown> = {}) { return { task_type: "extract_part", status: "queued", attempts: 0, locked_at: null, available_at: checked, created_at: checked, updated_at: checked, ...patch }; }
function request() { return new Request("https://app.invalid/api/admin-operations", { headers: { authorization: `Bearer ${token}` } }); }
function runtime(): AdminOperationsRuntime {
  return { authenticate: vi.fn(async () => ({ userId })), isPlatformAdmin: vi.fn(async () => true), read: vi.fn(async (name: SourceName) => name === "worker" ? worker() : source([])), now: () => now };
}
afterEach(() => vi.restoreAllMocks());
describe("operations implementation", () => {
  it("wires authorization before all source reads and strips raw health data", async () => {
    const r = runtime(); const reply = await createAdminOperationsHandler(r)(request());
    expect(reply.status).toBe(200); expect(reply.headers.get("cache-control")).toContain("no-store");
    const text = await reply.text(); expect(text).not.toMatch(/private|recentEvents|lastError/);
    const data = JSON.parse(text);
    expect(data.items.find((i: {category:string}) => i.category === "worker").severity).toBe("healthy");
    const session = data.items.find((i: {provider:string;category:string}) => i.provider === "xometry" && i.category === "provider_session");
    expect(session.severity).toBe("unknown"); expect(session.context.sessionEvidenceAgeDays).toBe(1.5);
    expect(r.isPlatformAdmin).toHaveBeenCalledWith(token, userId, expect.any(AbortSignal));
  });
  it.each([false, "true", {}, null])("denies non-true admin results without source calls: %j", async (admin) => {
    const r = runtime(); vi.mocked(r.isPlatformAdmin).mockResolvedValue(admin);
    expect((await createAdminOperationsHandler(r)(request())).status).toBe(403);
    expect(r.read).not.toHaveBeenCalled();
  });
  it("isolates malformed source and keeps a healthy sibling", () => {
    const result = projectOperations({ worker: worker(), queue: source([queue({status:{toString:0}})]) }, now);
    expect(result.items.find((i) => i.category === "queue")?.severity).toBe("unknown");
    expect(result.items.find((i) => i.category === "worker")?.severity).toBe("healthy");
  });
  it("reports scheduled work and does not invent incident history", () => {
    const result = projectOperations({queue:source([queue({available_at:new Date(now+60000).toISOString()})])},now);
    expect(result.items.find((i) => i.category === "queue")).toMatchObject({reasonCode:"scheduled_work",firstSeenAt:null,changedAt:null,occurrenceCount:1});
  });
  it("groups bounded failures by known provider without leaking failure messages", () => {
    const result = projectOperations({failures:source([queue({status:"failed",provider:"xometry",failureCode:"captcha",failureMessage:"secret"})])},now);
    expect(result.items.find((i) => i.category === "task_failure")).toMatchObject({key:"task_failure:xometry",severity:"attention",occurrenceCount:1});
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("keeps uncoded failed evidence unknown and a proven empty failure window healthy", () => {
    expect(projectOperations({failures:source([queue({status:"failed",failureCode:null,provider:null})])},now).items.find((i)=>i.category==="task_failure")?.severity).toBe("unknown");
    expect(projectOperations({failures:source([])},now).items.find((i)=>i.category==="task_failure")).toMatchObject({severity:"healthy",occurrenceCount:0});
  });
  it.each([null,"*/1","0-0/2","0-1/1","0-0/*"])("rejects incomplete count receipts %s", async (range) => {
    const send=vi.fn(async()=>Response.json([queue()],{headers:range?{"content-range":range}:{}}));
    await expect(createAdminOperationsRuntime(env,{fetch:send,now:()=>now}).read("queue",token,new AbortController().signal)).rejects.toThrow();
  });
  it("marks proven totals over the bounded cap truncated even if backend returns fewer rows", async () => {
    const send=vi.fn(async()=>Response.json([queue()],{headers:{"content-range":"0-0/202"}}));
    const result=await createAdminOperationsRuntime(env,{fetch:send,now:()=>now}).read("queue",token,new AbortController().signal);
    expect(projectOperations({queue:result},now).items.find((i)=>i.category==="queue")).toMatchObject({reasonCode:"source_truncated",occurrenceCount:null});
  });
  it("rejects malformed extraction thresholds and does not infer healthy empty evaluation", () => {
    const alerts = source([{created_at:checked,alert_type:"auto_approve_rate_low",metric_value:0.1,threshold_value:"secret",alert_day:"2026-10-02"}]);
    expect(projectOperations({extraction:alerts},now).items.find((i)=>i.category==="extraction_quality")?.reasonCode).toBe("source_malformed");
    expect(projectOperations({extraction:source([])},now).items.find((i)=>i.category==="extraction_quality")?.reasonCode).toBe("evaluation_unknown");
  });
  it("uses actual user JWT then private safe selectors and current-job quote state", async () => {
    const urls: string[]=[];
    const send=vi.fn(async (input: RequestInfo|URL, init?:RequestInit) => {
      const url=String(input); urls.push(url);
      const auth=new Headers(init?.headers).get("authorization");
      if(url.endsWith("/auth/v1/user")){expect(auth).toBe(`Bearer ${token}`);return Response.json({id:userId});}
      if(url.endsWith("/api_get_is_platform_admin")){expect(auth).toBe(`Bearer ${token}`);return Response.json(true);}
      if(url.includes("worker.invalid"))return Response.json(worker().payload);
      expect(auth).toBe("Bearer synthetic_service");
      if(url.includes("/work_queue?") && url.includes("locked_at"))return Response.json([queue({created_at:"2026-10-02T11:59:00.123000+00:00",updated_at:"2026-10-02T11:59:00.123000+00:00"})], {headers:{"content-range":"0-0/1"}});
      expect(new Headers(init?.headers).get("prefer")).toBe("count=exact");
      return Response.json([], {headers:{"content-range":"*/0"}});
    });
    const response=await createAdminOperationsHandler(createAdminOperationsRuntime(env,{fetch:send,now:()=>now}))(request());
    expect(response.status).toBe(200);
    expect(urls.slice(0,2)).toEqual(["https://database.invalid/auth/v1/user","https://database.invalid/rest/v1/rpc/api_get_is_platform_admin"]);
    expect(urls.some((url)=>url.includes("/jobs?")&&url.includes("awaiting_vendor_manual_review"))).toBe(true);
    expect(urls.some((url)=>url.includes("vendor_quote_results"))).toBe(false);
    expect(urls.map((url)=>new URL(url).searchParams.get("or"))).toContain("(status.eq.failed,and(status.eq.queued,payload->>failureCode.not.is.null))");
    expect(urls.some((url)=>url.includes("last_error")||url.includes("select=*")||url.includes("failureMessage"))).toBe(false);
  });
  it("keeps authentication infrastructure errors unavailable instead of invalid credentials", async () => {
    const send=vi.fn(async()=>{throw new Error("private infrastructure");});
    const response=await createAdminOperationsHandler(createAdminOperationsRuntime(env,{fetch:send}))(request());
    expect(response.status).toBe(503); expect(await response.json()).toEqual({error:"unavailable"});
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("normalizes database timestamp offsets but rejects impossible calendar dates", () => {
    expect(databaseTimestamp("2026-10-02T14:00:00.123456+02:00")).toBe("2026-10-02T12:00:00.123Z");
    expect(()=>databaseTimestamp("2026-02-30T00:00:00+00:00")).toThrow();
  });
  it("shares monotonic expiry with nested body reads before a delayed timer", async () => {
    let clock=0, reads=0; vi.spyOn(performance,"now").mockImplementation(()=>clock);
    const body=new ReadableStream<Uint8Array>({pull(stream){reads++;clock=5000;stream.enqueue(new TextEncoder().encode("{}"));}}, {highWaterMark:0});
    await expect(withinBudget((signal)=>readBoundedJson(new Response(body),signal),5000)).rejects.toThrow();
    expect(reads).toBe(1);
  });
});
