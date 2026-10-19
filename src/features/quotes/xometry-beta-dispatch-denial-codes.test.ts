import { describe, expect, it } from "vitest";
import {
  getXometryBetaScopeDenialCode,
  getXometryBetaScopeFailureMessage,
} from "./xometry-beta-dispatch";

// supabase-js returns RPC failures as plain records, not Error instances.
const postgrestError = (message: string) => ({ code: "P0001", details: null, hint: null, message });

describe("getXometryBetaScopeDenialCode", () => {
  it("reads the named destination denial from a plain PostgrestError record", () => {
    expect(getXometryBetaScopeDenialCode(postgrestError("xometry_beta_confirmed_sourcing_address_required")))
      .toBe("xometry_beta_confirmed_sourcing_address_required");
  });

  it("reads the tolerance denial from an Error", () => {
    expect(getXometryBetaScopeDenialCode(new Error("xometry_beta_standard_tolerance_required")))
      .toBe("xometry_beta_standard_tolerance_required");
  });

  it.each([
    "xometry_beta_quantity_one_required",
    "xometry_beta_special_delivery_date_not_supported",
    "xometry_beta_special_requirements_not_supported",
    "provider_dispatch_special_requirements_not_supported",
    "provider_dispatch_exact_scope_required",
  ])("reads the OVD-981 field denial %s from a plain record and an Error", (code) => {
    expect(getXometryBetaScopeDenialCode(postgrestError(code))).toBe(code);
    expect(getXometryBetaScopeDenialCode(new Error(code))).toBe(code);
    expect(getXometryBetaScopeDenialCode(postgrestError(`${code}_other`))).toBeNull();
    expect(getXometryBetaScopeDenialCode(postgrestError(`prefix ${code}`))).toBeNull();
  });

  it("ignores non-actionable, embedded, and unknown messages", () => {
    expect(getXometryBetaScopeDenialCode(postgrestError("xometry_beta_exact_scope_required"))).toBeNull();
    expect(getXometryBetaScopeDenialCode(new Error("prefix xometry_beta_confirmed_sourcing_address_required"))).toBeNull();
    expect(getXometryBetaScopeDenialCode(new TypeError("Failed to fetch"))).toBeNull();
    expect(getXometryBetaScopeDenialCode(null)).toBeNull();
  });
});

describe("getXometryBetaScopeFailureMessage", () => {
  it("points a missing confirmed destination at Settings", () => {
    const message = getXometryBetaScopeFailureMessage(
      postgrestError("xometry_beta_confirmed_sourcing_address_required"),
    );
    expect(message).toContain("confirmed shipping address");
    expect(message).toContain("Settings");
    expect(message).not.toContain("xometry_beta_");
  });

  it("explains the beta tolerance floor", () => {
    const message = getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_standard_tolerance_required"));
    expect(message).toContain("tightest tolerance");
    expect(message).toContain("±0.005 in");
  });

  it.each([
    ["xometry_beta_quantity_one_required", ["quantity 1 only", "Set Qty to 1", "Quote quantities"]],
    ["xometry_beta_special_delivery_date_not_supported", ["Need by", "Clear Need by"]],
    ["xometry_beta_special_requirements_not_supported", ["Clear Notes", "Threads", "special requirements"]],
    ["provider_dispatch_special_requirements_not_supported", ["Need by", "Notes", "Threads", "special requirements"]],
    ["provider_dispatch_exact_scope_required", ["one part", "one quantity", "Set Qty to 1", "Quote quantities", "the files you uploaded"]],
  ])("names the field to change for %s", (code, fragments) => {
    const message = getXometryBetaScopeFailureMessage(postgrestError(code));
    for (const fragment of fragments) {
      expect(message).toContain(fragment);
    }
    expect(message).not.toContain("_required");
    expect(message).not.toContain("_supported");
    expect(message).not.toContain("not currently eligible");
  });

  it("names the configured provider in the OVD-981 field copy", () => {
    expect(getXometryBetaScopeFailureMessage(postgrestError("provider_dispatch_exact_scope_required"), "fictiv")).toContain(
      "controlled Fictiv beta",
    );
  });

  it("keeps the generic copy for explicit denials without a field mapping", () => {
    for (const code of ["provider_dispatch_job_busy", "provider_dispatch_scope_mismatch", "xometry_beta_cnc_milling_required"]) {
      expect(getXometryBetaScopeFailureMessage(postgrestError(code)))
        .toBe("This package is not currently eligible for controlled Xometry beta dispatch. Review its access, files, and manufacturing requirements.");
    }
  });

  it("keeps bounded copy for other explicit server denials delivered as plain records", () => {
    expect(getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_exact_scope_required")))
      .toBe("This package is not currently eligible for controlled Xometry beta dispatch. Review its access, files, and manufacturing requirements.");
  });

  it("keeps the retry copy for transport failures", () => {
    expect(getXometryBetaScopeFailureMessage(new TypeError("Failed to fetch")))
      .toBe("The current Xometry confirmation scope could not be verified. Try the scope check again.");
  });
});
