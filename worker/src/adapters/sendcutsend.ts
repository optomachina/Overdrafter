import { VendorAdapter } from "./base.js";
import type { VendorQuoteAdapterInput, VendorQuoteAdapterOutput } from "../types.js";

export class SendCutSendAdapter extends VendorAdapter {
  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    return {
      vendor: "sendcutsend",
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl:
        this.config.workerMode === "live"
          ? "https://sendcutsend.com/faq/how-does-a-formal-quote-work/"
          : `simulated://sendcutsend/manual/${input.part.id}`,
      dfmIssues: [],
      notes: [
        "CNC billet quotes for SendCutSend are modeled as manual vendor follow-up in v1.",
      ],
      artifacts: [],
      rawPayload: {
        mode: this.config.workerMode,
        source: "sendcutsend-adapter",
        requiresManualVendorFollowUp: true,
      },
    };
  }
}
