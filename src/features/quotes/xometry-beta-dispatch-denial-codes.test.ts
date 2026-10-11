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

  it("keeps bounded copy for other explicit server denials delivered as plain records", () => {
    expect(getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_exact_scope_required")))
      .toBe("This package is not currently eligible for controlled Xometry beta dispatch. Review its access, files, and manufacturing requirements.");
  });

  it("keeps the retry copy for transport failures", () => {
    expect(getXometryBetaScopeFailureMessage(new TypeError("Failed to fetch")))
      .toBe("The current Xometry confirmation scope could not be verified. Try the scope check again.");
  });
});
