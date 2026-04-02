import { VendorAdapter } from "./base.js";
import {
  VendorAutomationError,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
} from "../types.js";

export class SendCutSendAdapter extends VendorAdapter {
  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode === "live") {
      throw new VendorAutomationError(
        "SendCutSend live automation is not implemented; manual vendor follow-up is required.",
        "not_implemented",
        {
          vendor: "sendcutsend",
          reason: "live_adapter_not_implemented",
          requiresManualVendorFollowUp: true,
          requestedQuantity: input.requestedQuantity,
        },
      );
    }

    return {
      vendor: "sendcutsend",
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: `simulated://sendcutsend/manual/${input.part.id}`,
      dfmIssues: [],
      notes: [
        "CNC billet quotes for SendCutSend are modeled as manual vendor follow-up in v1.",
      ],
      artifacts: [],
      rawPayload: {
        mode: this.config.workerMode,
        source: "sendcutsend-adapter",
        requiresManualVendorFollowUp: true,
        requestedQuantity: input.requestedQuantity,
      },
    };
  }
}
