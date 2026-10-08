// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createSupabaseChatGptReader } from "./supabase-reader";
import { syntheticJobId as jobId, syntheticOrganizationId as organizationId, syntheticUserId as userId } from "./synthetic-fixture";

const connection = { userId, organizationId, scopes: ["overdrafter:read"], accessToken: "synthetic-user-session" };
function fixture(options: { user?: string; member?: boolean; job?: boolean; projection?: unknown; failure?: boolean } = {}) {
  const calls: Array<{ url: URL; headers: Headers; method: string; body: unknown }> = [];
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers), method: init?.method ?? "GET", body: init?.body });
    if (options.failure) return Response.json({ message: "secret upstream message" }, { status: 503 });
    if (url.pathname === "/auth/v1/user") return Response.json({ id: options.user ?? userId });
    if (url.pathname === "/rest/v1/organization_memberships") return Response.json(options.member === false ? null : { organization_id: organizationId });
    if (url.pathname === "/rest/v1/jobs") return Response.json(options.job === false ? null : { id: jobId, organization_id: organizationId, status: "quoting" });
    if (url.pathname === "/rest/v1/rpc/api_list_client_quote_workspace") return Response.json(options.projection ?? [{ jobId, vendorQuotes: [] }]);
    throw new Error("Unexpected call");
  });
  const dependencies = createSupabaseChatGptReader({ url: "https://synthetic.invalid", publishableKey: "sb_publishable_fixture", connection, isEnabled: () => true, fetch: fetcher });
  return { dependencies, calls, fetcher };
}

describe("user-scoped Supabase composition", () => {
  it("verifies identity and membership and preserves the user bearer on every read", async () => {
    const { dependencies, calls } = fixture();
    const principal = await dependencies.resolvePrincipal();
    expect(principal).toEqual({ userId, organizationId, scopes: ["overdrafter:read"] });
    expect(await dependencies.readAuthorizedJob(principal!, jobId)).toEqual({ organizationId, job: { id: jobId, status: "quoting" }, quotes: [] });
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.headers.get("authorization")).toBe("Bearer synthetic-user-session");
    expect(calls[1].url.searchParams.get("user_id")).toBe(`eq.${userId}`);
    expect(calls[1].url.searchParams.get("organization_id")).toBe(`eq.${organizationId}`);
    expect(calls[2].url.searchParams.get("organization_id")).toBe(`eq.${organizationId}`);
    expect(calls[2].url.searchParams.get("select")).toBe("id,organization_id,status");
    expect(calls[3].url.pathname).toBe("/rest/v1/rpc/api_list_client_quote_workspace");
    expect(JSON.parse(String(calls[3].body))).toEqual({ p_job_ids: [jobId] });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "GET", "POST"]);
  });
  it.each([{ user: jobId }, { member: false }])("denies mismatched users and absent membership: %j", async (options) => {
    const { dependencies, calls } = fixture(options);
    expect(await dependencies.resolvePrincipal()).toBeNull();
    expect(calls.some((call) => call.url.pathname.endsWith("/jobs"))).toBe(false);
  });
  it("does not query quote data when RLS hides the job", async () => {
    const { dependencies, calls } = fixture({ job: false });
    expect(await dependencies.readAuthorizedJob(connection, jobId)).toBeNull();
    expect(calls).toHaveLength(1);
  });
  it("rejects a different principal before upstream access", async () => {
    const { dependencies, calls } = fixture();
    expect(await dependencies.readAuthorizedJob({ ...connection, organizationId: jobId }, jobId)).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it.each([{ projection: [] }, { projection: [{ jobId: userId, vendorQuotes: [] }] }, { projection: [{ jobId, vendorQuotes: [{
    id: userId, organization_id: userId, vendor: "synthetic", status: "queued", requested_quantity: 1,
    total_price_usd: null, lead_time_business_days: null,
  }] }] }])("fails closed when the RPC hides a job or returns foreign data", async ({ projection }) => {
    const { dependencies } = fixture({ projection });
    expect(await dependencies.readAuthorizedJob(connection, jobId)).toBeNull();
  });
  it("does not turn missing schema or malformed payloads into empty quotes", async () => {
    const { dependencies } = fixture({ projection: { invalid: "shape" } });
    await expect(dependencies.readAuthorizedJob(connection, jobId)).rejects.toThrow();
  });
  it("rejects privileged keys and insecure remote upstreams before calls", () => {
    const base = { url: "https://synthetic.invalid", publishableKey: "sb_publishable_fixture", connection, isEnabled: () => true };
    expect(() => createSupabaseChatGptReader({ ...base, publishableKey: "sb_secret_fixture" })).toThrow();
    expect(() => createSupabaseChatGptReader({ ...base, url: "http://remote.invalid" })).toThrow();
  });
});
