import { VendorAdapter } from "./base.js";
import type { VendorQuoteAdapterInput, VendorQuoteAdapterOutput } from "../types.js";

export class FictivAdapter extends VendorAdapter {
  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    const requiresManualReview =
      Boolean(input.drawingFile) &&
      (input.requirement.tightest_tolerance_inch ?? 0.01) <= 0.002;

    if (requiresManualReview) {
      return {
        vendor: "fictiv",
        status: "manual_review_pending",
        unitPriceUsd: null,
        totalPriceUsd: null,
        leadTimeBusinessDays: null,
        quoteUrl:
          this.config.workerMode === "live"
            ? "https://www.fictiv.com/"
            : `simulated://fictiv/manual/${input.part.id}`,
        dfmIssues: [],
        notes: [
          "Attached drawing and tight tolerance triggered the Fictiv manual-review lane.",
        ],
        artifacts: [],
        rawPayload: {
          mode: this.config.workerMode,
          source: "fictiv-adapter",
          manualReview: true,
        },
      };
    }

    const total = Math.round(this.simulatedBaseAmount(input) * 1.08 * 100) / 100;

    return {
      vendor: "fictiv",
      status: "instant_quote_received",
      unitPriceUsd: Math.round((total / input.requirement.quantity) * 100) / 100,
      totalPriceUsd: total,
      leadTimeBusinessDays: 7,
      quoteUrl:
        this.config.workerMode === "live"
          ? "https://www.fictiv.com/"
          : `simulated://fictiv/${input.part.id}`,
      dfmIssues: [],
      notes: ["Simulated Fictiv quote generated from the deterministic worker model."],
      artifacts: [],
      rawPayload: {
        mode: this.config.workerMode,
        source: "fictiv-adapter",
      },
    };
  }
}
