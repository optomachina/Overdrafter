import { describe, expect, it } from "vitest";
import {
  extractDenialCode,
  getXometryBetaScopeFailureMessage,
  isExplicitXometryBetaDispatchDenial,
} from "./xometry-beta-dispatch";

describe("extractDenialCode", () => {
  it("returns null for non-Xometry errors", () => {
    const error = new Error("Some generic error");
    expect(extractDenialCode(error)).toBeNull();
  });

  it("extracts xometry_beta_confirmed_sourcing_address_required", () => {
    const error = new Error("xometry_beta_confirmed_sourcing_address_required");
    expect(extractDenialCode(error)).toBe("xometry_beta_confirmed_sourcing_address_required");
  });

  it("extracts xometry_beta_tightest_tolerance_required", () => {
    const error = new Error("xometry_beta_tightest_tolerance_required");
    expect(extractDenialCode(error)).toBe("xometry_beta_tightest_tolerance_required");
  });

  it("extracts xometry_beta_exact_scope_required", () => {
    const error = new Error("xometry_beta_exact_scope_required");
    expect(extractDenialCode(error)).toBe("xometry_beta_exact_scope_required");
  });

  it("extracts xometry_beta_scope_changed", () => {
    const error = new Error("xometry_beta_scope_changed");
    expect(extractDenialCode(error)).toBe("xometry_beta_scope_changed");
  });

  it("extracts xometry_beta_notice_changed", () => {
    const error = new Error("xometry_beta_notice_changed");
    expect(extractDenialCode(error)).toBe("xometry_beta_notice_changed");
  });

  it("handles error messages with additional context", () => {
    const error = new Error("PostgrestError: xometry_beta_confirmed_sourcing_address_required at line 123");
    expect(extractDenialCode(error)).toBe("xometry_beta_confirmed_sourcing_address_required");
  });

  it("handles non-Error objects with message property", () => {
    const error = { message: "xometry_beta_tightest_tolerance_required" };
    expect(extractDenialCode(error)).toBe("xometry_beta_tightest_tolerance_required");
  });
});

describe("getXometryBetaScopeFailureMessage", () => {
  it("returns specific message for missing sourcing address", () => {
    const error = new Error("xometry_beta_confirmed_sourcing_address_required");
    const message = getXometryBetaScopeFailureMessage(error);
    expect(message).toContain("confirmed shipping address");
    expect(message).toContain("Settings");
  });

  it("returns specific message for missing tolerance", () => {
    const error = new Error("xometry_beta_tightest_tolerance_required");
    const message = getXometryBetaScopeFailureMessage(error);
    expect(message).toContain("tightest tolerance");
    expect(message).toContain("provide");
  });

  it("returns specific message for scope mismatch", () => {
    const error = new Error("xometry_beta_exact_scope_required");
    const message = getXometryBetaScopeFailureMessage(error);
    expect(message).toContain("specifications");
    expect(message).toContain("requirements");
  });

  it("returns generic denial message for other xometry_beta errors", () => {
    const error = new Error("xometry_beta_scope_changed");
    const message = getXometryBetaScopeFailureMessage(error);
    expect(message).toContain("not currently eligible");
  });

  it("returns generic message for non-explicit denials", () => {
    const error = new Error("Network error");
    const message = getXometryBetaScopeFailureMessage(error);
    expect(message).toContain("could not be verified");
  });
});

describe("isExplicitXometryBetaDispatchDenial", () => {
  it("returns true for xometry_beta_ prefixed errors", () => {
    expect(isExplicitXometryBetaDispatchDenial(new Error("xometry_beta_confirmed_sourcing_address_required"))).toBe(true);
    expect(isExplicitXometryBetaDispatchDenial(new Error("xometry_beta_exact_scope_required"))).toBe(true);
  });

  it("returns true for founding beta access errors", () => {
    expect(isExplicitXometryBetaDispatchDenial(new Error("Founding Beta access is required"))).toBe(true);
  });

  it("returns true for permission errors", () => {
    expect(isExplicitXometryBetaDispatchDenial(new Error("No permission to request quotes"))).toBe(true);
  });

  it("returns false for generic errors", () => {
    expect(isExplicitXometryBetaDispatchDenial(new Error("Network timeout"))).toBe(false);
    expect(isExplicitXometryBetaDispatchDenial(new Error("Database error"))).toBe(false);
  });
});
