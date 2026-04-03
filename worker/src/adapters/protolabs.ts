import { VendorAdapter } from "./base.js";
import {
  VendorAutomationError,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
} from "../types.js";

export class ProtolabsAdapter extends VendorAdapter {
  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode === "live") {
      throw new VendorAutomationError(
        "Protolabs live automation is not implemented; manual vendor follow-up is required.",
        "not_implemented",
        {
          vendor: "protolabs",
          reason: "live_adapter_not_implemented",
          requiresManualVendorFollowUp: true,
          requestedQuantity: input.requestedQuantity,
        },
      );
    }

    const total = Math.round(this.simulatedBaseAmount(input) * 1.15 * 100) / 100;

    return {
      vendor: "protolabs",
      status: "official_quote_received",
      unitPriceUsd: Math.round((total / Math.max(1, input.requestedQuantity)) * 100) / 100,
      totalPriceUsd: total,
      leadTimeBusinessDays: 4,
      quoteUrl: `simulated://protolabs/${input.part.id}`,
      dfmIssues: input.requirement.tightest_tolerance_inch && input.requirement.tightest_tolerance_inch <= 0.002
        ? ["Tight tolerance likely requires manual process validation."]
        : [],
      notes: ["Simulated Protolabs quote generated from the deterministic worker model."],
      artifacts: [],
      rawPayload: {
        mode: this.config.workerMode,
        source: "protolabs-adapter",
        requestedQuantity: input.requestedQuantity,
      },
    };
  }
}
