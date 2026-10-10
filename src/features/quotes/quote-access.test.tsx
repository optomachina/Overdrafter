import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuoteAccess, parseQuoteAccess, useQuoteAccess, type QuoteAccessIdentity } from "./quote-access";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/features/quotes/api/shared/rpc", () => ({ callUntypedRpc: rpc }));
const identity = { actorUserId: "00000000-0000-4000-8000-000000000001", organizationId: "00000000-0000-4000-8000-000000000002", jobId: "00000000-0000-4000-8000-000000000003" };
const snapshot = (id = identity) => ({ ...id, schema: "quote-access.v1", state: "eligible", source: "free_beta", reasonCode: "eligible", policyRevision: "beta-1" });
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => { rpc.mockReset(); });
afterEach(cleanup);
describe("quote access contract", () => {
  it("reads only job policy with no billing or capacity inference", async () => {
    rpc.mockResolvedValue({ data: snapshot(), error: null });
    expect(await fetchQuoteAccess(identity)).toEqual(snapshot());
    expect(rpc).toHaveBeenCalledExactlyOnceWith("api_get_quote_access", { p_job_id: identity.jobId });
  });
  it("accepts commercial grants without a free policy revision", () => {
    expect(parseQuoteAccess({ ...snapshot(), source: "commercial_entitlement", policyRevision: null }, identity).state).toBe("eligible");
  });
  it.each(["automatic_quote_disabled", "beta_access_required", "free_policy_unavailable"])("accepts policy denial %s", (reasonCode) => {
    expect(parseQuoteAccess({ ...snapshot(), state: "blocked", source: null, policyRevision: null, reasonCode }, identity).state).toBe("blocked");
  });
  it.each([
    { actorUserId: "00000000-0000-4000-8000-000000000009" },
    { organizationId: "00000000-0000-4000-8000-000000000009" },
    { jobId: "00000000-0000-4000-8000-000000000009" },
    { schema: "quote-access.v2" }, { state: "unknown" }, { source: "paid" },
    { policyRevision: " " }, { policyRevision: null }, { source: null },
    { state: "blocked" }, { reasonCode: "free_allowance_unavailable" },
    { capacity: 100 }, { source: "commercial_entitlement" },
  ])("rejects mismatched/invalid snapshot %j", (patch) => {
    expect(() => parseQuoteAccess({ ...snapshot(), ...patch }, identity)).toThrow("could not be verified");
  });
  it("does not expose server errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "sensitive database detail" } });
    await expect(fetchQuoteAccess(identity)).rejects.toThrow(/^Quote access could not be verified\.$/);
  });
});
describe("identity-scoped policy hook", () => {
  it("never enables loading or failed policy", async () => {
    rpc.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useQuoteAccess(identity), { wrapper: wrapper() });
    expect(result.current.automaticEnabled).toBe(false);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.state).toBe("unknown");
  });
  it("ignores late responses after subject, org and job change", async () => {
    let resolveOld: (value: unknown) => void;
    rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce({ data: null, error: { message: "denied" } });
    const next = { actorUserId: "00000000-0000-4000-8000-000000000004", organizationId: "00000000-0000-4000-8000-000000000005", jobId: "00000000-0000-4000-8000-000000000006" };
    const { result, rerender } = renderHook(({ id }: { id: QuoteAccessIdentity | null }) => useQuoteAccess(id), { initialProps: { id: identity }, wrapper: wrapper() });
    rerender({ id: next });
    await act(async () => resolveOld({ data: snapshot(), error: null }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.automaticEnabled).toBe(false);
    rerender({ id: null });
    expect(result.current.automaticEnabled).toBe(false);
  });
  it("clears enabled access immediately on logout or disabling verified auth", async () => {
    rpc.mockResolvedValue({ data: snapshot(), error: null });
    const { result, rerender } = renderHook(({ enabled }) => useQuoteAccess(identity, enabled), { initialProps: { enabled: true }, wrapper: wrapper() });
    await waitFor(() => expect(result.current.automaticEnabled).toBe(true));
    rerender({ enabled: false });
    expect(result.current.automaticEnabled).toBe(false);
    expect(result.current.state).toBe("unknown");
  });
  it("refetches on relogin and ignores a previous auth generation's late response", async () => {
    let resolveOld: (value: unknown) => void;
    rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ data: { ...snapshot(), state: "blocked", source: null, policyRevision: null, reasonCode: "beta_access_required" }, error: null });
    const { result, rerender } = renderHook(({ enabled }) => useQuoteAccess(identity, enabled), { initialProps: { enabled: true }, wrapper: wrapper() });
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    await act(async () => resolveOld({ data: snapshot(), error: null }));
    await waitFor(() => expect(result.current.state).toBe("blocked"));
    expect(result.current.automaticEnabled).toBe(false);
  });
  it("fails closed during refresh and after policy revocation", async () => {
    rpc.mockResolvedValueOnce({ data: snapshot(), error: null }).mockResolvedValueOnce({ data: { ...snapshot(), state: "blocked", reasonCode: "beta_access_required", source: null, policyRevision: null }, error: null });
    const { result } = renderHook(() => useQuoteAccess(identity), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.automaticEnabled).toBe(true));
    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.state).toBe("blocked"));
    expect(result.current.automaticEnabled).toBe(false);
  });
});
