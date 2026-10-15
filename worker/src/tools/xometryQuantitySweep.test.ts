// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { VendorAdapter } from "../adapters/base.js";
import { PROVIDER_KILL_SWITCH_STATE_SCHEMA } from "../providerKillSwitch.js";
import { runQuote } from "./xometryQuantitySweep.js";

const authorization = { nonExportControlled: true, cadFileSha256: "a".repeat(64), drawingFileSha256: null };

function sweepQuote(adapter: VendorAdapter, quantity: number, reader: (provider: string) => Promise<unknown>) {
  return runQuote(adapter, quantity, "/cad/part.step", null, "/staged/part.step", null, authorization, reader);
}

describe("xometry sweep kill switch", () => {
  it("refuses the next quantity when the switch is engaged between quantities", async () => {
    let engaged = false;
    const reader = async (provider: string) => ({
      schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA,
      provider,
      engaged,
      globalEngaged: false,
    });
    const quote = vi.fn(async () => ({
      vendor: "xometry",
      status: "instant_quote_received",
      totalPriceUsd: 1,
      unitPriceUsd: 1,
      leadTimeBusinessDays: 1,
      quoteUrl: null,
      rawPayload: {},
      artifacts: [],
    }));
    const adapter = { quote } as unknown as VendorAdapter;

    const first = await sweepQuote(adapter, 1, reader);
    expect(first.error).toBeNull();
    engaged = true;
    await expect(sweepQuote(adapter, 5, reader)).rejects.toMatchObject({
      reasonCode: "provider_kill_switch_engaged",
      checkpoint: "before_launch",
    });
    expect(quote).toHaveBeenCalledOnce();
  });

  it("hands the checkpoint to the adapter so engagement after launch stops the next mutation", async () => {
    let reads = 0;
    const reader = async (provider: string) => ({
      schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA,
      provider,
      engaged: reads++ >= 1,
      globalEngaged: false,
    });
    const mutation = vi.fn();
    const adapter = {
      quote: async (input: { providerKillSwitchCheckpoint?: (c: "before_upload") => Promise<void> }) => {
        await input.providerKillSwitchCheckpoint?.("before_upload");
        mutation();
      },
    } as unknown as VendorAdapter;

    await expect(sweepQuote(adapter, 1, reader)).rejects.toMatchObject({ checkpoint: "before_upload" });
    expect(mutation).not.toHaveBeenCalled();
  });
});
