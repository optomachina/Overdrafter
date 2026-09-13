import { afterEach, describe, expect, it, vi } from "vitest";
import { collectStableEgressEvidence } from "./verify-xometry-stable-egress.mjs";
import { OVD410_PRODUCTION_CONTRACT } from "./xometry-stable-egress-contract.mjs";
import { runWithinBudget, diagnosticStageLimits } from "./ovd419-diagnostic-budget.mjs";

afterEach(() => vi.useRealTimers());
describe("diagnostic deadline composition", () => {
  it("pins the stable-egress collector's actual 18-command contribution", async () => {
    const calls = [];
    await collectStableEgressEvidence(OVD410_PRODUCTION_CONTRACT, { runCommand: async (_, args) => { calls.push(args); return {}; } });
    expect(calls).toHaveLength(18);
  });
  it("accounts for preparation separately from server execution and replacement", () => {
    expect(diagnosticStageLimits({ preparationMs: 200, mutationMs: 300, executionMs: 400, readMs: 10 }))
      .toEqual({ replaceMs: 510, executeMs: 600, restoreMs: 500 });
  });
  it("aborts a hung read even when the transport ignores its timeout", async () => {
    vi.useFakeTimers(); let signal;
    const outcome = runWithinBudget((s) => { signal = s; return new Promise(() => {}); }, { timeoutMs: 30 }).catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(30);
    expect(await outcome).toBe("diagnostic_operation_unsettled"); expect(signal.aborted).toBe(true);
  });
  it("caps a child by its phase's remaining time and never starts after expiry", async () => {
    vi.useFakeTimers(); let cap;
    const result = runWithinBudget((_, ms) => { cap = ms; return new Promise(() => {}); }, { timeoutMs: 100, deadlineAt: Date.now() + 20 }).catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(20); expect(await result).toBe("diagnostic_operation_unsettled"); expect(cap).toBe(20);
    const fn = vi.fn(); await expect(runWithinBudget(fn, { timeoutMs: 100, deadlineAt: Date.now() })).rejects.toThrow("diagnostic_budget_exhausted"); expect(fn).not.toHaveBeenCalled();
  });
  it("propagates parent cancellation immediately, removes listeners and stops late work", async () => {
    vi.useFakeTimers(); const parent = new AbortController(); let child;
    const outcome = runWithinBudget((signal) => { child = signal; return new Promise(() => {}); }, { timeoutMs: 1000, signal: parent.signal }).catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(1); parent.abort();
    expect(await outcome).toBe("diagnostic_operation_unsettled"); expect(child.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
});
