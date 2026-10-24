import { VendorAutomationError } from "../types.js";

export const OSHCUT_PORTAL_DISABLED_MESSAGE =
  "OSH Cut portal automation is disabled until row-bound cart configuration exists (OVD-1022)";

/** Unconditional source-level stop. No configuration, permit, or environment override. */
export function refuseOshcutPortalAutomation(): void {
  throw new VendorAutomationError(OSHCUT_PORTAL_DISABLED_MESSAGE, "unexpected_ui_state", {
    vendor: "oshcut",
    reason: "oshcut_portal_automation_disabled",
    terminalState: "unsupported",
    providerInteractionAttempted: false,
    providerMutationPossible: false,
  });
}
