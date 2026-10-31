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
    "xometry_beta_single_quantity_required",
    "xometry_beta_special_delivery_date_not_supported",
    "xometry_beta_special_requirements_not_supported",
    "provider_dispatch_special_requirements_not_supported",
    "provider_dispatch_exact_scope_required",
  ])("reads the OVD-981 and OVD-998 field denial %s from a plain record and an Error", (code) => {
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
  it("asks for a confirmed destination without sending the customer to Settings", () => {
    const message = getXometryBetaScopeFailureMessage(
      postgrestError("xometry_beta_confirmed_sourcing_address_required"),
    );
    expect(message).toBe(
      "Xometry needs a confirmed shipping address for supplier quotes. Review and confirm your organization's shipping address.",
    );
  });

  it("reads the generic path's missing destination and names its provider (OVD-1068)", () => {
    const denial = postgrestError("provider_dispatch_confirmed_destination_required");
    expect(getXometryBetaScopeDenialCode(denial)).toBe("provider_dispatch_confirmed_destination_required");
    const message = getXometryBetaScopeFailureMessage(denial, "fictiv");
    expect(message).toContain("Fictiv needs a confirmed shipping address");
    expect(message).not.toContain("provider_dispatch_");
    expect(message).not.toContain("Xometry");
  });

  it("explains the beta tolerance floor", () => {
    const message = getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_standard_tolerance_required"));
    expect(message).toContain("tightest tolerance");
    expect(message).toContain("±0.005 in");
  });

  it.each([
    ["xometry_beta_quantity_one_required", ["quantity 1 only", "Set Qty to 1", "Quote quantities"]],
    ["xometry_beta_special_delivery_date_not_supported", ["Need by", "Clear Need by"]],
  ])("names the field to change for %s", (code, fragments) => {
    const message = getXometryBetaScopeFailureMessage(postgrestError(code));
    for (const fragment of fragments) {
      expect(message).toContain(fragment);
    }
    expect(message).not.toContain("_required");
    expect(message).not.toContain("_supported");
    expect(message).not.toContain("not currently eligible");
  });

  // OVD-998 (OVD-987 P2): with the user quantity switch on the legacy Xometry resolver admits one
  // quantity of any size, so its denial must not repeat the switch-off "quantity 1" instruction.
  describe("xometry_beta_single_quantity_required copy", () => {
    it("asks for exactly one quantity without a false Qty 1 instruction and without a retry-around", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_single_quantity_required"));
      expect(message).toContain("quotes one quantity per request");
      expect(message).toContain("Remove extra Quote quantities so exactly one quantity of 1 or more remains");
      expect(message).toContain("request it as its own quote");
      expect(message).not.toContain("quantity 1 only");
      expect(message).not.toContain("Set Qty to 1");
      expect(message).not.toContain("_required");
      expect(message).not.toContain("not currently eligible");
    });

    it("leaves the switch-off quantity 1 copy as it was", () => {
      expect(getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_quantity_one_required"))).toBe(
        "The controlled Xometry beta quotes quantity 1 only. Set Qty to 1 and clear extra Quote quantities, then retry.",
      );
    });
  });

  // OVD-991: every field both server scope checks deny as a special requirement, in form words.
  const SPECIAL_REQUIREMENT_FRAGMENTS = [
    "Threads",
    "Notes",
    "packaging, shipping, certification, sourcing and release notes",
    "required certifications",
    "material certification",
    "a certificate of conformance",
    "an inspection level other than Standard",
    "preferred suppliers",
    "a sourcing preference other than Best value",
    "material provisioning other than Supplier to source",
    "a release hold or block",
  ];

  describe.each([
    ["xometry_beta_special_requirements_not_supported", false],
    ["provider_dispatch_special_requirements_not_supported", true],
  ])("special requirements copy for %s", (code, namesNeedBy) => {
    it("names every denied field and says a part that needs them is outside the beta", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError(code));
      for (const fragment of SPECIAL_REQUIREMENT_FRAGMENTS) {
        expect(message).toContain(fragment);
      }
      expect(message).toContain("cannot carry");
      expect(message).toContain("it is outside the beta");
      expect(message).toContain("Remove them only if the part does not need them");
    });

    it("never tells the customer to clear the fields unconditionally", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError(code));
      expect(message).not.toMatch(/\bclear\b/i);
      expect(message).not.toContain("does not support special requirements");
      expect(message).not.toContain("_required");
      expect(message).not.toContain("_supported");
      expect(message).not.toContain("not currently eligible");
    });

    it(namesNeedBy ? "names the Need by date the generic check also denies" : "leaves the Need by date to its own denial", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError(code));
      expect(message.includes("Need by date")).toBe(namesNeedBy);
    });

    it("adds the drawing thread note only when the drawing has thread callouts", () => {
      const plain = getXometryBetaScopeFailureMessage(postgrestError(code), "fictiv");
      const withThreads = getXometryBetaScopeFailureMessage(postgrestError(code), "fictiv", {
        drawingThreads: true,
      });
      expect(plain).not.toContain("thread callouts");
      expect(
        getXometryBetaScopeFailureMessage(postgrestError(code), "fictiv", { drawingThreads: false }),
      ).toBe(plain);
      expect(withThreads.startsWith(plain)).toBe(true);
      expect(withThreads).toContain("Thread callouts read from the drawing are saved as Threads");
      expect(withThreads).toContain("cannot be cleared");
      expect(withThreads).toContain("a part with thread callouts is outside the beta");
    });
  });

  it("keeps the drawing thread note off every other denial", () => {
    for (const code of [
      "xometry_beta_quantity_one_required",
      "xometry_beta_single_quantity_required",
      "xometry_beta_special_delivery_date_not_supported",
      "provider_dispatch_exact_scope_required",
      "provider_dispatch_job_busy",
    ]) {
      const message = getXometryBetaScopeFailureMessage(postgrestError(code), "fictiv", { drawingThreads: true });
      expect(message).not.toContain("thread callouts");
    }
  });

  describe("provider_dispatch_exact_scope_required copy", () => {
    it("asks for one quantity without a false Qty 1 instruction and points a file mismatch at support", () => {
      const message = getXometryBetaScopeFailureMessage(
        postgrestError("provider_dispatch_exact_scope_required"),
        "fictiv",
      );
      expect(message).toContain("one part at one quantity from its approved files");
      expect(message).toContain("Remove extra Quote quantities so one quantity remains");
      expect(message).toContain("does not match its approved files; contact support");
      // The generic path accepts a single quantity of any size.
      expect(message).not.toContain("Qty");
      expect(message).not.toContain("quantity 1");
      expect(message).not.toContain("the files you uploaded");
    });
  });

  // OVD-991: Fictiv customers must never read "Xometry" in a Fictiv denial.
  it.each([
    "xometry_beta_quantity_one_required",
    "xometry_beta_single_quantity_required",
    "xometry_beta_special_delivery_date_not_supported",
    "xometry_beta_special_requirements_not_supported",
    "provider_dispatch_special_requirements_not_supported",
    "provider_dispatch_exact_scope_required",
  ])("names the configured provider, never Xometry, in the field copy for %s", (code) => {
    const message = getXometryBetaScopeFailureMessage(postgrestError(code), "fictiv");
    expect(message).toContain("controlled Fictiv beta");
    expect(message).not.toContain("Xometry");
    expect(getXometryBetaScopeFailureMessage(postgrestError(code), "xometry")).toContain("controlled Xometry beta");
    expect(getXometryBetaScopeFailureMessage(postgrestError(code))).toContain("controlled Xometry beta");
  });

  it("names the configured provider in the generic denial and retry copy", () => {
    expect(getXometryBetaScopeFailureMessage(postgrestError("provider_dispatch_scope_mismatch"), "fictiv")).toContain(
      "controlled Fictiv beta dispatch",
    );
    expect(getXometryBetaScopeFailureMessage(new TypeError("Failed to fetch"), "fictiv")).toBe(
      "The current Fictiv confirmation scope could not be verified. Try the scope check again.",
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
