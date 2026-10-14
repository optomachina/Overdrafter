// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { isDispatchDecisionError } from "./dispatchDecisionError";
import { abortAwareCheckpoint, ProviderAbortedError, throwIfProviderAborted, withProviderAbortSignal } from "./providerAbort";
import { guardProviderQuote } from "./providerKillSwitch";
import type { VendorQuoteAdapterInput } from "./types";

const bareInput = { quoteRunId: "run" } as unknown as VendorQuoteAdapterInput;

describe("provider abort signal (OVD-748)", () => {
  it("leaves an input without a signal untouched", () => {
    expect(withProviderAbortSignal(bareInput, undefined)).toBe(bareInput);
    expect(abortAwareCheckpoint(undefined, undefined)).toBeUndefined();
    expect(() => throwIfProviderAborted(undefined, "before_upload")).not.toThrow();
  });

  it("runs an un-aborted adapter through every checkpoint unchanged", async () => {
    const inner = vi.fn(async () => {});
    const bound = withProviderAbortSignal({ ...bareInput, providerKillSwitchCheckpoint: inner }, new AbortController().signal);
    await bound.providerKillSwitchCheckpoint?.("before_navigation");
    await bound.providerKillSwitchCheckpoint?.("before_save");
    expect(inner.mock.calls).toEqual([["before_navigation"], ["before_save"]]);
  });

  it("aborted before start: the first checkpoint throws and the kill switch is not read", async () => {
    const inner = vi.fn(async () => {});
    const controller = new AbortController();
    controller.abort();
    const bound = withProviderAbortSignal({ ...bareInput, providerKillSwitchCheckpoint: inner }, controller.signal);
    await expect(bound.providerKillSwitchCheckpoint?.("before_navigation")).rejects.toMatchObject({
      code: "provider_aborted",
      checkpoint: "before_navigation",
    });
    expect(inner).not.toHaveBeenCalled();
  });

  it("aborted while the checkpoint read is in flight: stops before the next step", async () => {
    const controller = new AbortController();
    const bound = withProviderAbortSignal(
      { ...bareInput, providerKillSwitchCheckpoint: async () => controller.abort() },
      controller.signal,
    );
    await expect(bound.providerKillSwitchCheckpoint?.("before_upload")).rejects.toBeInstanceOf(ProviderAbortedError);
  });

  it("composes with a caller signal: either one aborts", async () => {
    const caller = new AbortController();
    const lease = new AbortController();
    const bound = withProviderAbortSignal({ ...bareInput, signal: caller.signal }, lease.signal);
    await bound.providerKillSwitchCheckpoint?.("before_navigation");
    caller.abort();
    await expect(bound.providerKillSwitchCheckpoint?.("before_upload")).rejects.toBeInstanceOf(ProviderAbortedError);
  });

  it("survives the kill switch guard, which replaces the checkpoint", async () => {
    const controller = new AbortController();
    const guard = vi.fn(async () => {});
    const seen: string[] = [];
    const quote = guardProviderQuote(guard, async (input) => {
      await input.providerKillSwitchCheckpoint?.("before_navigation");
      seen.push("navigation");
      controller.abort();
      await input.providerKillSwitchCheckpoint?.("before_upload");
      seen.push("upload");
    });
    await expect(quote({ ...bareInput, signal: controller.signal })).rejects.toBeInstanceOf(ProviderAbortedError);
    expect(seen).toEqual(["navigation"]);
    expect(guard.mock.calls.map(([name]) => name)).toEqual(["before_launch", "before_navigation"]);
  });

  it("is rethrown unchanged by adapters, like other dispatch decisions", () => {
    expect(isDispatchDecisionError(new ProviderAbortedError("before_save"))).toBe(true);
    expect(isDispatchDecisionError(new Error("navigation timeout"))).toBe(false);
  });
});
