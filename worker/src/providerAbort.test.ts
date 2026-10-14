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

  it("a pre-aborted signal stops before the launch guard, onLaunch and the adapter", async () => {
    const controller = new AbortController();
    controller.abort();
    const guard = vi.fn(async () => {});
    const onLaunch = vi.fn();
    const adapter = vi.fn(async () => {});
    const quote = guardProviderQuote(guard, adapter, onLaunch);
    await expect(quote({ ...bareInput, signal: controller.signal })).rejects.toMatchObject({ checkpoint: "before_launch" });
    expect(guard).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
  });

  it("an abort during the launch guard stops before onLaunch and the adapter", async () => {
    const controller = new AbortController();
    const guard = vi.fn(async () => controller.abort());
    const onLaunch = vi.fn();
    const adapter = vi.fn(async () => {});
    const quote = guardProviderQuote(guard, adapter, onLaunch);
    await expect(quote({ ...bareInput, signal: controller.signal })).rejects.toMatchObject({ checkpoint: "before_launch" });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(onLaunch).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
  });

  it("without a signal the launch guard still runs, then onLaunch, then the adapter", async () => {
    const order: string[] = [];
    const quote = guardProviderQuote(
      async (name) => void order.push(`guard:${name}`),
      async () => void order.push("adapter"),
      () => order.push("launch"),
    );
    await quote(bareInput);
    expect(order).toEqual(["guard:before_launch", "launch", "adapter"]);
  });

  it("is rethrown unchanged by adapters, like other dispatch decisions", () => {
    expect(isDispatchDecisionError(new ProviderAbortedError("before_save"))).toBe(true);
    expect(isDispatchDecisionError(new Error("navigation timeout"))).toBe(false);
  });
});
