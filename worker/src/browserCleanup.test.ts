// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { runFailClosedBrowserCleanup } from "./browserCleanup";

describe("runFailClosedBrowserCleanup", () => {
  it("rejects with an Error if an injected termination hook returns", async () => {
    const terminateProcess = vi.fn(() => undefined) as unknown as (
      message: string,
    ) => never;

    await expect(
      runFailClosedBrowserCleanup(
        () => new Promise<never>(() => undefined),
        "cleanup timed out",
        { cleanupTimeoutMs: 1, terminateProcess },
      ),
    ).rejects.toThrow("cleanup timed out");
    expect(terminateProcess).toHaveBeenCalledWith("cleanup timed out");
  });
});
