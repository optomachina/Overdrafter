import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PostgrestSingleResponse } from "@supabase/supabase-js";
import { callRpc, callUntypedRpc, untypedSupabase } from "./rpc";

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
