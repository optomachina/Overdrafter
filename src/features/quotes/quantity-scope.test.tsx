import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchQuantityScope,
  parseQuantityScope,
  useQuantityScope,
  type QuantityScopeIdentity,
} from "./quantity-scope";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/features/quotes/api/shared/rpc", () => ({ callUntypedRpc: rpc }));

const identity: QuantityScopeIdentity = {
  actorUserId: "user-1",
  organizationId: "org-1",
  jobId: "job-1",
};
const single = (id = identity) => ({ ...id, schema: "quantity-scope.v1", state: "single_only", grant: null });
const multiple = (grant = "participant", id = identity) => ({
  ...id,
  schema: "quantity-scope.v1",
  state: "multiple_allowed",
  grant,
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  rpc.mockReset();
});
afterEach(cleanup);

describe("quantity scope contract", () => {
  it("reads one RPC for the job and returns the verified answer", async () => {
    rpc.mockResolvedValue({ data: multiple("request"), error: null });
    expect(await fetchQuantityScope(identity)).toEqual(multiple("request"));
    expect(rpc).toHaveBeenCalledExactlyOnceWith("api_get_quantity_scope", { p_job_id: identity.jobId });
  });

  it.each(["participant", "request"])("accepts a scoped grant for a %s", (grant) => {
    expect(parseQuantityScope(multiple(grant), identity)).toEqual(multiple(grant));
  });

  it("accepts single only with no grant", () => {
    expect(parseQuantityScope(single(), identity)).toEqual(single());
  });

  it.each([
    { actorUserId: "user-2" },
    { organizationId: "org-2" },
    { jobId: "job-2" },
    { schema: "quantity-scope.v2" },
    { state: "unknown" },
    { state: "multiple_allowed" },
    { grant: "participant" },
    { grant: "global" },
    { extra: 1 },
  ])("rejects a mismatched or invalid answer %j", (patch) => {
    expect(() => parseQuantityScope({ ...single(), ...patch }, identity)).toThrow("could not be verified");
  });

  it("rejects a multiple_allowed answer with no grant, a missing key and non-objects", () => {
    expect(() => parseQuantityScope({ ...multiple(), grant: null }, identity)).toThrow("could not be verified");
    const { grant: _grant, ...withoutGrant } = single();
    expect(() => parseQuantityScope(withoutGrant, identity)).toThrow("could not be verified");
    for (const value of [null, undefined, "multiple_allowed", [], 1]) {
      expect(() => parseQuantityScope(value, identity)).toThrow("could not be verified");
    }
  });

  it("does not trust an answer when the caller identity is empty", () => {
    const empty = { actorUserId: "", organizationId: "", jobId: "" };
    expect(() => parseQuantityScope({ ...multiple(), ...empty }, empty)).toThrow("could not be verified");
  });

  it("does not expose server errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "sensitive database detail" } });
    await expect(fetchQuantityScope(identity)).rejects.toThrow(/^Quantity scope could not be verified\.$/);
  });
});

describe("quantity scope hook", () => {
  it("makes no request and stays fixed at 1 while the flag is off", () => {
    const { result } = renderHook(() => useQuantityScope(identity, false), { wrapper: wrapper() });
    expect(result.current.status).toBe("single_only");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("makes no request without an identity", () => {
    const { result } = renderHook(() => useQuantityScope(null, true), { wrapper: wrapper() });
    expect(result.current.status).toBe("single_only");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("is loading, then offers a quantity above 1 only when the server scoped it", async () => {
    rpc.mockResolvedValue({ data: multiple(), error: null });
    const { result } = renderHook(() => useQuantityScope(identity, true), { wrapper: wrapper() });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("multiple_allowed"));
  });

  it("stays fixed at 1 when the server says single only", async () => {
    rpc.mockResolvedValue({ data: single(), error: null });
    const { result } = renderHook(() => useQuantityScope(identity, true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).toBe("single_only"));
  });

  it.each([
    ["an RPC error", () => rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } })],
    ["a network failure", () => rpc.mockRejectedValue(new Error("offline"))],
    ["an answer for another job", () => rpc.mockResolvedValue({ data: multiple("request", { ...identity, jobId: "job-9" }), error: null })],
    ["an unrecognised answer", () => rpc.mockResolvedValue({ data: { allowed: true }, error: null })],
  ])("fails closed to quantity 1 on %s", async (_name, arrange) => {
    arrange();
    const { result } = renderHook(() => useQuantityScope(identity, true), { wrapper: wrapper() });
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    await waitFor(() => expect(result.current.status).toBe("single_only"));
  });

  it("ignores a late answer for a previous job", async () => {
    let resolveOld: (value: unknown) => void = () => {};
    rpc
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ data: single({ ...identity, jobId: "job-2" }), error: null });
    const { result, rerender } = renderHook(
      ({ id }: { id: QuantityScopeIdentity }) => useQuantityScope(id, true),
      { initialProps: { id: identity }, wrapper: wrapper() },
    );
    rerender({ id: { ...identity, jobId: "job-2" } });
    await act(async () => resolveOld({ data: multiple(), error: null }));
    await waitFor(() => expect(result.current.status).toBe("single_only"));
  });
});
