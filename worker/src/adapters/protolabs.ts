import { VendorAdapter } from "./base.js";
import type { VendorQuoteAdapterInput, VendorQuoteAdapterOutput } from "../types.js";

export class ProtolabsAdapter extends VendorAdapter {
  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    const total = Math.round(this.simulatedBaseAmount(input) * 1.15 * 100) / 100;

    return {
      vendor: "protolabs",
      status: "official_quote_received",
      unitPriceUsd: Math.round((total / input.requirement.quantity) * 100) / 100,
      totalPriceUsd: total,
      leadTimeBusinessDays: 4,
      quoteUrl:
        this.config.workerMode === "live"
          ? "https://www.protolabs.com/"
          : `simulated://protolabs/${input.part.id}`,
      dfmIssues: input.requirement.tightest_tolerance_inch && input.requirement.tightest_tolerance_inch <= 0.002
        ? ["Tight tolerance likely requires manual process validation."]
        : [],
      notes: ["Simulated Protolabs quote generated from the deterministic worker model."],
      artifacts: [],
      rawPayload: {
        mode: this.config.workerMode,
        source: "protolabs-adapter",
      },
    };
  }
}
