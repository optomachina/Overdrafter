// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobileAuthUpstreamFetch } from "./upstream-fetch";

describe("mobile authentication upstream fetch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards requests while replacing the signal with a bounded one", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("ok"),
    );
    const boundedFetch = createMobileAuthUpstreamFetch(1_000, fetchImplementation);

    const response = await boundedFetch("https://project.supabase.co/auth/v1/user", {
      method: "GET",
    });

    await expect(response.text()).resolves.toBe("ok");
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/user",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("aborts a stalled upstream at the configured deadline", async () => {
    vi.useFakeTimers();
    const fetchImplementation = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const boundedFetch = createMobileAuthUpstreamFetch(250, fetchImplementation);

    const pending = boundedFetch("https://project.supabase.co/auth/v1/user");
    const rejection = expect(pending).rejects.toThrow("upstream deadline exceeded");
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
  });

  it("preserves caller cancellation", async () => {
    const caller = new AbortController();
    const fetchImplementation = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const boundedFetch = createMobileAuthUpstreamFetch(1_000, fetchImplementation);

    const pending = boundedFetch("https://project.supabase.co/auth/v1/user", {
      signal: caller.signal,
    });
    const rejection = expect(pending).rejects.toThrow("caller cancelled");
    caller.abort(new Error("caller cancelled"));

    await rejection;
  });
});
