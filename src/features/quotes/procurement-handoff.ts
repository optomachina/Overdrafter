export const PROCUREMENT_SHIPPING_OPTIONS = [
  {
    value: "standard_ground",
    label: "Standard shipping",
    description: "Use the normal shipping path unless we confirm a change.",
  },
  {
    value: "expedite_review",
    label: "Review expediting",
    description: "Flag this handoff for lead-time follow-up before release.",
  },
  {
    value: "customer_account",
    label: "Use my account",
    description: "Route carrier selection through the buyer's shipping account.",
  },
] as const;

export const PROCUREMENT_BILLING_OPTIONS = [
  {
    value: "po_required",
    label: "PO required",
    description: "Collect or confirm a purchase order before release.",
  },
  {
    value: "invoice_after_approval",
    label: "Invoice after approval",
    description: "Treat procurement as manual follow-up with invoice coordination.",
  },
  {
    value: "confirm_before_charge",
    label: "Confirm before charge",
    description: "Do not advance procurement until the buyer confirms next steps.",
  },
] as const;

export type ProcurementShippingOption = (typeof PROCUREMENT_SHIPPING_OPTIONS)[number]["value"];
export type ProcurementBillingOption = (typeof PROCUREMENT_BILLING_OPTIONS)[number]["value"];

export type ProcurementHandoffState = {
  shippingPlan: ProcurementShippingOption;
  billingPlan: ProcurementBillingOption;
  shipToContact: string;
  shipToLocation: string;
  billingContactName: string;
  billingContactEmail: string;
  poReference: string;
  specialInstructions: string;
};

export type ProcurementHandoffSummary = {
  ready: boolean;
  missingFields: string[];
  shippingLabel: string;
  billingLabel: string;
  shipToSummary: string;
  billingContactSummary: string;
  poSummary: string;
  instructionsSummary: string;
};

export function createDefaultProcurementHandoffState(): ProcurementHandoffState {
  return {
    shippingPlan: "standard_ground",
    billingPlan: "confirm_before_charge",
    shipToContact: "",
    shipToLocation: "",
    billingContactName: "",
    billingContactEmail: "",
    poReference: "",
    specialInstructions: "",
  };
}

function findOptionLabel<T extends { value: string; label: string }>(options: readonly T[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}

function normalizeValue(value: string) {
  return value.trim();
}

export function summarizeProcurementHandoff(
  state: ProcurementHandoffState,
): ProcurementHandoffSummary {
  const shipToContact = normalizeValue(state.shipToContact);
  const shipToLocation = normalizeValue(state.shipToLocation);
  const billingContactName = normalizeValue(state.billingContactName);
  const billingContactEmail = normalizeValue(state.billingContactEmail);
  const poReference = normalizeValue(state.poReference);
  const specialInstructions = normalizeValue(state.specialInstructions);
  const missingFields: string[] = [];

  if (!shipToContact) {
    missingFields.push("ship-to contact");
  }

  if (!shipToLocation) {
    missingFields.push("ship-to location");
  }

  if (!billingContactName) {
    missingFields.push("billing contact name");
  }

  if (!billingContactEmail) {
    missingFields.push("billing contact email");
  }

  return {
    ready: missingFields.length === 0,
    missingFields,
    shippingLabel: findOptionLabel(PROCUREMENT_SHIPPING_OPTIONS, state.shippingPlan),
    billingLabel: findOptionLabel(PROCUREMENT_BILLING_OPTIONS, state.billingPlan),
    shipToSummary:
      shipToContact && shipToLocation
        ? `${shipToContact} · ${shipToLocation}`
        : shipToContact || shipToLocation || "Add a ship-to contact and location.",
    billingContactSummary:
      billingContactName && billingContactEmail
        ? `${billingContactName} · ${billingContactEmail}`
        : billingContactName || billingContactEmail || "Add a billing contact name and email.",
    poSummary:
      poReference || (state.billingPlan === "po_required" ? "PO will follow in manual procurement handoff." : "No PO reference captured yet."),
    instructionsSummary: specialInstructions || "No special instructions captured yet.",
  };
}
