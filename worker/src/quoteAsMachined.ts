import type { ApprovedRequirementRecord } from "./types.js";

/**
 * OVD-1163: the server's normalization for Process, Material and Finish
 * (private.resolve_xometry_beta_dispatch_scope_with_access): trimmed,
 * lowercased, every character outside a-z and 0-9 dropped.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The requirement a supplier is asked to quote. When the customer chose
 * "Quote as machined" (spec_snapshot.quoteAsMachined, set by
 * public.api_set_client_part_quote_as_machined) for the part's current
 * drawing finish, the supplier is asked for an as-machined quote. The approved
 * requirement, and so the scope fingerprint, keep the drawing finish; a choice
 * made for another finish is ignored, exactly as the server ignores it.
 */
export function supplierQuoteRequirement(requirement: ApprovedRequirementRecord): ApprovedRequirementRecord {
  const snapshot = record(requirement.spec_snapshot) ? requirement.spec_snapshot : null;
  const choice = snapshot && record(snapshot.quoteAsMachined) ? snapshot.quoteAsMachined : null;
  const finish = normalize(requirement.finish ?? "");
  if (!choice || typeof choice.finish !== "string" || finish === "" || finish === "asmachined") {
    return requirement;
  }
  if (normalize(choice.finish) !== finish) {
    return requirement;
  }
  return { ...requirement, finish: "As machined" };
}
