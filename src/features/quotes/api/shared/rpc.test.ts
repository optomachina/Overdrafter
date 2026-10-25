import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PostgrestSingleResponse } from "@supabase/supabase-js";
import { callRpc, callUntypedRpc, untypedSupabase } from "./rpc";
import { supabase } from "@/integrations/supabase/client";
import { __resetWorkerWakeForTests } from "./worker-wake";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(), functions: { invoke: vi.fn() } },
}));

describe("RPC timeout handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("should timeout callUntypedRpc after 30 seconds by default", async () => {
    const slowRpcPromise = new Promise<PostgrestSingleResponse<unknown>>(() => {
      // Never resolves
    });

    vi.spyOn(untypedSupabase, "rpc").mockReturnValue(slowRpcPromise);

    const callPromise = callUntypedRpc("api_slow_function", { arg: "value" });

    // Fast-forward time by 30 seconds
    vi.advanceTimersByTime(30_000);

    await expect(callPromise).rejects.toThrow("RPC call to api_slow_function timed out after 30000ms");
  });

  it("should not timeout if RPC completes before timeout", async () => {
    const successResponse: PostgrestSingleResponse<string> = {
      data: "success",
      error: null,
      count: null,
      status: 200,
      statusText: "OK",
    };

    const fastRpcPromise = Promise.resolve(successResponse);

    vi.spyOn(untypedSupabase, "rpc").mockReturnValue(fastRpcPromise);

    const callPromise = callUntypedRpc("api_fast_function", { arg: "value" });

    // Fast-forward time by only 1 second
    vi.advanceTimersByTime(1_000);

    const result = await callPromise;
    expect(result.data).toBe("success");
    expect(result.error).toBeNull();
  });

  it("should allow RPC errors to propagate normally", async () => {
    const errorResponse: PostgrestSingleResponse<unknown> = {
      data: null,
      error: {
        name: "PostgrestError",
        message: "Database error",
        details: "Table not found",
        hint: null,
        code: "42P01",
      },
      count: null,
      status: 400,
      statusText: "Bad Request",
    };

    const errorRpcPromise = Promise.resolve(errorResponse);

    vi.spyOn(untypedSupabase, "rpc").mockReturnValue(errorRpcPromise);

    const result = await callUntypedRpc("api_error_function");

    expect(result.error).not.toBeNull();
    expect(result.error?.message).toBe("Database error");
  });

  it("should handle multiple concurrent RPC calls with independent timeouts", async () => {
    const slowPromise = new Promise<PostgrestSingleResponse<unknown>>(() => {
      // Never resolves
    });

    const fastPromise = Promise.resolve<PostgrestSingleResponse<string>>({
      data: "fast",
      error: null,
      count: null,
      status: 200,
      statusText: "OK",
    });

    const rpcSpy = vi.spyOn(untypedSupabase, "rpc");
    rpcSpy.mockReturnValueOnce(slowPromise).mockReturnValueOnce(fastPromise);

    const slowCall = callUntypedRpc("api_slow");
    const fastCall = callUntypedRpc("api_fast");

    // Fast call should complete
    vi.advanceTimersByTime(1_000);
    const fastResult = await fastCall;
    expect(fastResult.data).toBe("fast");

    // Slow call should timeout
    vi.advanceTimersByTime(29_000);
    await expect(slowCall).rejects.toThrow("RPC call to api_slow timed out after 30000ms");
  });
});

describe.each(["typed", "untyped"] as const)("%s RPC worker wake", (kind) => {
  const successResponse: PostgrestSingleResponse<number> = {
    data: 1,
    error: null,
    count: null,
    status: 200,
    statusText: "OK",
  };
  const submit = () => kind === "typed"
    ? callRpc("api_request_extraction", { p_job_id: "job-1" })
    : callUntypedRpc("api_request_extraction", { p_job_id: "job-1" });
  const invoke = vi.mocked(supabase.functions.invoke);

  beforeEach(() => {
    vi.useFakeTimers();
    __resetWorkerWakeForTests();
    vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", "true");
    vi.spyOn(untypedSupabase, "rpc").mockResolvedValue(successResponse);
    invoke.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => {
    __resetWorkerWakeForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("wakes once after success and returns the original response", async () => {
    expect(invoke).not.toHaveBeenCalled();
    await expect(submit()).resolves.toBe(successResponse);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("worker-wake", { body: {} });
  });

  it("waits for RPC success before waking", async () => {
    let resolveRpc!: (response: PostgrestSingleResponse<number>) => void;
    vi.mocked(untypedSupabase.rpc).mockReturnValue(new Promise((resolve) => {
      resolveRpc = resolve;
    }));
    const result = submit();
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    resolveRpc(successResponse);
    await expect(result).resolves.toBe(successResponse);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not wake on an RPC error response", async () => {
    const response: PostgrestSingleResponse<unknown> = {
      data: null,
      error: { name: "PostgrestError", message: "Failed", details: "", hint: "", code: "XX000" },
      count: null,
      status: 400,
      statusText: "Bad Request",
    };
    vi.mocked(untypedSupabase.rpc).mockResolvedValue(response);
    await expect(submit()).resolves.toBe(response);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not wake on an RPC rejection", async () => {
    const error = new Error("RPC failed");
    vi.mocked(untypedSupabase.rpc).mockRejectedValue(error);
    await expect(submit()).rejects.toBe(error);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not wake on timeout, even if the RPC later succeeds", async () => {
    let resolveRpc!: (response: PostgrestSingleResponse<number>) => void;
    vi.mocked(untypedSupabase.rpc).mockReturnValue(new Promise((resolve) => {
      resolveRpc = resolve;
    }));
    const result = submit();
    const assertion = expect(result).rejects.toThrow("timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    resolveRpc(successResponse);
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not wake when disabled", async () => {
    vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", "false");
    await expect(submit()).resolves.toBe(successResponse);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("debounces successful submissions across ten seconds", async () => {
    await submit();
    await vi.advanceTimersByTimeAsync(9_999);
    await submit();
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await submit();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("returns without waiting for the wake invocation", async () => {
    invoke.mockReturnValue(new Promise(() => undefined));
    await expect(submit()).resolves.toBe(successResponse);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("preserves RPC success when the wake invocation rejects", async () => {
    invoke.mockRejectedValue(new Error("Sensitive wake failure payload"));
    await expect(submit()).resolves.toBe(successResponse);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("preserves RPC success when the wake invocation throws", async () => {
    invoke.mockImplementation(() => {
      throw new Error("Sensitive wake failure payload");
    });
    await expect(submit()).resolves.toBe(successResponse);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not wake for a non-allowlisted RPC", async () => {
    const read = kind === "typed"
      ? callRpc("api_get_quote_access", { p_job_id: "job-1" })
      : callUntypedRpc("api_get_quote_access", { p_job_id: "job-1" });
    await expect(read).resolves.toBe(successResponse);
    expect(invoke).not.toHaveBeenCalled();
  });
});
