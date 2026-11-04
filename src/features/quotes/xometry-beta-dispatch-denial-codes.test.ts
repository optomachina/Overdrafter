import { describe, expect, it } from "vitest";
import { REQUESTED_SERVICE_TYPE_OPTIONS } from "./service-intent";
import {
  QUOTE_REQUEST_FIX_LABELS,
  getQuoteRequestFix,
  getXometryBetaScopeDenialCode,
  getXometryBetaScopeExplainedDenialCode,
  getXometryBetaScopeFailureMessage,
} from "./xometry-beta-dispatch";

// supabase-js returns RPC failures as plain records, not Error instances.
const postgrestError = (message: string) => ({ code: "P0001", details: null, hint: null, message });

// OVD-993: the remaining envelope denials. The first five name a field or a wait the
// customer can act on; the last two only explain a job-level refusal.
const OVD993_ACTIONABLE_CODES = [
  "xometry_beta_cnc_milling_required",
  "xometry_beta_6061_t6_required",
  "xometry_beta_as_machined_required",
  "provider_dispatch_process_not_admitted",
  "xometry_beta_compatible_drawing_required",
] as const;
const OVD993_EXPLAINED_CODES = [
  "xometry_beta_manufacturing_quote_only",
  "provider_dispatch_manufacturing_quote_only",
] as const;

/** No raw server code, no generic fallback, in customer copy. */
function expectBoundedCopy(message: string) {
  expect(message).not.toMatch(/_(?:required|supported|admitted|only)\b/);
  expect(message).not.toContain("provider_dispatch_");
  expect(message).not.toContain("xometry_beta_");
  expect(message).not.toContain("not currently eligible");
}

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
  ])("reads the OVD-981 field denial %s from a plain record and an Error", (code) => {
    expect(getXometryBetaScopeDenialCode(postgrestError(code))).toBe(code);
    expect(getXometryBetaScopeDenialCode(new Error(code))).toBe(code);
    expect(getXometryBetaScopeDenialCode(postgrestError(`${code}_other`))).toBeNull();
    expect(getXometryBetaScopeDenialCode(postgrestError(`prefix ${code}`))).toBeNull();
  });

  it.each(OVD993_ACTIONABLE_CODES)("reads the OVD-993 envelope denial %s from a plain record and an Error", (code) => {
    expect(getXometryBetaScopeDenialCode(postgrestError(code))).toBe(code);
    expect(getXometryBetaScopeDenialCode(new Error(code))).toBe(code);
    expect(getXometryBetaScopeDenialCode(postgrestError(`${code}_other`))).toBeNull();
    expect(getXometryBetaScopeDenialCode(postgrestError(`prefix ${code}`))).toBeNull();
  });

  it("keeps the explained-only denials out of the actionable codes", () => {
    for (const code of OVD993_EXPLAINED_CODES) {
      expect(getXometryBetaScopeDenialCode(postgrestError(code))).toBeNull();
    }
  });

  it("ignores non-actionable, embedded, and unknown messages", () => {
    expect(getXometryBetaScopeDenialCode(postgrestError("xometry_beta_exact_scope_required"))).toBeNull();
    expect(getXometryBetaScopeDenialCode(new Error("prefix xometry_beta_confirmed_sourcing_address_required"))).toBeNull();
    expect(getXometryBetaScopeDenialCode(new TypeError("Failed to fetch"))).toBeNull();
    expect(getXometryBetaScopeDenialCode(null)).toBeNull();
  });
});

describe("getXometryBetaScopeExplainedDenialCode", () => {
  it.each(OVD993_EXPLAINED_CODES)("reads %s exactly from a plain record and an Error", (code) => {
    expect(getXometryBetaScopeExplainedDenialCode(postgrestError(code))).toBe(code);
    expect(getXometryBetaScopeExplainedDenialCode(new Error(code))).toBe(code);
    expect(getXometryBetaScopeExplainedDenialCode(postgrestError(`${code}_other`))).toBeNull();
    expect(getXometryBetaScopeExplainedDenialCode(postgrestError(`prefix ${code}`))).toBeNull();
  });

  it("ignores actionable, lookalike and unknown messages", () => {
    for (const code of OVD993_ACTIONABLE_CODES) {
      expect(getXometryBetaScopeExplainedDenialCode(postgrestError(code))).toBeNull();
    }
    expect(getXometryBetaScopeExplainedDenialCode(postgrestError("xometry_beta_manufacturing_quote"))).toBeNull();
    expect(getXometryBetaScopeExplainedDenialCode(new TypeError("Failed to fetch"))).toBeNull();
    expect(getXometryBetaScopeExplainedDenialCode(null)).toBeNull();
  });
});

/** OVD-1163: popup copy is plain and short and names no supplier or beta machinery. */
function expectPlainCopy(message: string) {
  expect(message).not.toMatch(/\b(?:scope|dispatch|package|envelope|controlled beta)\b/i);
  expect(message).not.toMatch(/\b(?:Xometry|Fictiv)\b/);
  expect(message).not.toMatch(/\bbeta\b/i);
}

const ALL_COPY_CODES = [
  "xometry_beta_confirmed_sourcing_address_required",
  "provider_dispatch_confirmed_destination_required",
  "xometry_beta_standard_tolerance_required",
  "xometry_beta_quantity_one_required",
  "xometry_beta_single_quantity_required",
  "xometry_beta_special_delivery_date_not_supported",
  "xometry_beta_special_requirements_not_supported",
  "provider_dispatch_special_requirements_not_supported",
  "provider_dispatch_exact_scope_required",
  "provider_dispatch_job_busy",
  "xometry_beta_exact_scope_required",
  ...OVD993_ACTIONABLE_CODES,
  ...OVD993_EXPLAINED_CODES,
] as const;

describe("getXometryBetaScopeFailureMessage", () => {
  // OVD-1163: deliberate copy change. Every denial reads plainly and names no supplier.
  it.each(ALL_COPY_CODES)("keeps %s plain, supplier-neutral and bounded", (code) => {
    for (const provider of ["xometry", "fictiv"] as const) {
      const message = getXometryBetaScopeFailureMessage(postgrestError(code), provider, { drawingThreads: true });
      expectPlainCopy(message);
      expectBoundedCopy(message);
      expect(getXometryBetaScopeFailureMessage(postgrestError(code), provider)).toBe(
        getXometryBetaScopeFailureMessage(postgrestError(code)),
      );
    }
  });

  it("keeps the transport retry copy plain too", () => {
    const message = getXometryBetaScopeFailureMessage(new TypeError("Failed to fetch"), "fictiv");
    expect(message).toBe("We couldn't check this part just now. Check again.");
    expectPlainCopy(message);
  });

  it("asks for a confirmed destination without sending the customer to Settings", () => {
    const message = getXometryBetaScopeFailureMessage(
      postgrestError("xometry_beta_confirmed_sourcing_address_required"),
    );
    expect(message).toBe("Confirm your organization's shipping address so suppliers can quote.");
  });

  it("reads the generic path's missing destination with the same copy (OVD-1068)", () => {
    const denial = postgrestError("provider_dispatch_confirmed_destination_required");
    expect(getXometryBetaScopeDenialCode(denial)).toBe("provider_dispatch_confirmed_destination_required");
    expect(getXometryBetaScopeFailureMessage(denial, "fictiv")).toBe(
      getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_confirmed_sourcing_address_required")),
    );
  });

  it("explains the tolerance floor", () => {
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
    expect(message).toContain("check again");
    expectBoundedCopy(message);
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
    "a saved release hold or block (contact support)",
  ];

  describe.each([
    ["xometry_beta_special_requirements_not_supported", false],
    ["provider_dispatch_special_requirements_not_supported", true],
  ])("special requirements copy for %s", (code, namesNeedBy) => {
    it("names every denied field and says a part that needs them can't be quoted here yet", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError(code));
      for (const fragment of SPECIAL_REQUIREMENT_FRAGMENTS) {
        expect(message).toContain(fragment);
      }
      expect(message).toContain("We can't quote");
      expect(message).toContain("If this part needs any of them, it can't be quoted here yet");
      expect(message).toContain("Remove them only if the part does not need them");
    });

    it("never tells the customer to clear the fields unconditionally", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError(code));
      expect(message).not.toMatch(/\bclear\b/i);
      expect(message).not.toContain("does not support special requirements");
      expectBoundedCopy(message);
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
      expect(withThreads).toContain("You can clear Threads in the request editor if the part does not need them, then check again.");
      expect(withThreads).not.toContain("cannot be cleared");
      expect(withThreads).not.toContain("a part with thread callouts");
    });
  });

  it("keeps the drawing thread note off every other denial", () => {
    for (const code of [
      "xometry_beta_quantity_one_required",
      "xometry_beta_single_quantity_required",
      "xometry_beta_special_delivery_date_not_supported",
      "provider_dispatch_exact_scope_required",
      "provider_dispatch_job_busy",
      ...OVD993_ACTIONABLE_CODES,
      ...OVD993_EXPLAINED_CODES,
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
      expect(message).toContain("supplier applies to this part");
      expect(message).toContain("one part and one Quote quantity");
      expect(message).toContain("approved files must also match");
      expect(message).toContain("contact support");
      // The generic path accepts a single quantity of any size.
      expect(message).not.toContain("Qty");
      expect(message).not.toContain("quantity 1");
      expect(message).not.toContain("the files you uploaded");
    });
  });

  // OVD-993 / OVD-1163: the remaining denials name the form field and a value the server accepts.
  describe("envelope field copy", () => {
    it("names the Process field, the accepted value and the condition before the instruction", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_cnc_milling_required"));
      const condition = "If this part is CNC milled";
      const instruction = "set Process to CNC milling, then check again";
      expect(message).toContain(condition);
      expect(message).toContain(instruction);
      // The instruction is conditional: a part made another way is never told to change it.
      expect(message.indexOf(condition)).toBeLessThan(message.indexOf(instruction));
      expectBoundedCopy(message);
    });

    it("says only 6061-T6 aluminum can be quoted and makes the material change conditional (fix offered beside it)", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_6061_t6_required"));
      expect(message).toBe("We can quote 6061-T6 aluminum only right now. Use it only if this part is 6061-T6.");
      expect(getQuoteRequestFix("xometry_beta_6061_t6_required")).toBe("use_6061_t6");
      expect(QUOTE_REQUEST_FIX_LABELS.use_6061_t6).toBe("Use 6061-T6 aluminum");
    });

    // OVD-1163 item 5: the finish refusal says plainly that finishes can't be quoted yet.
    it("says plainly that finishes can't be quoted yet and offers the as-machined fix", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_as_machined_required"));
      expect(message).toBe("Finishes can't be quoted yet. You can get a quote for this part as machined, without the finish.");
      expect(message).not.toMatch(/set Finish|leave it blank/);
      expect(getQuoteRequestFix("xometry_beta_as_machined_required")).toBe("quote_as_machined");
      expect(QUOTE_REQUEST_FIX_LABELS.quote_as_machined).toBe("Quote as machined (price won't include the finish)");
    });

    it("offers a fix for no other denial", () => {
      for (const code of ALL_COPY_CODES) {
        const fix = getQuoteRequestFix(getXometryBetaScopeDenialCode(postgrestError(code)));
        expect(fix, code).toBe(
          code === "xometry_beta_6061_t6_required" ? "use_6061_t6" : code === "xometry_beta_as_machined_required" ? "quote_as_machined" : null,
        );
      }
      expect(getQuoteRequestFix(null)).toBeNull();
    });

    it("tells the generic path's process denial to set a blank or unadmitted Process without naming a process list", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError("provider_dispatch_process_not_admitted"), "fictiv");
      expect(message).toContain("This request's Process is blank or can't be quoted by this supplier");
      expect(message).toContain("Set Process to the process that makes this part, then check again");
      // The admitted list lives in the server-side registry, and the generic resolver checks no material or finish.
      expect(message).not.toMatch(/CNC|mill/i);
      expect(message).not.toContain("Material");
      expect(message).not.toContain("Finish");
      expectBoundedCopy(message);
    });

    it("tells the drawing denial to wait for verification and check again, never to remove or re-register the drawing", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_compatible_drawing_required"));
      expect(message).toContain("The drawing must be a PDF whose uploaded bytes have been verified");
      expect(message).toContain("this part's drawing hasn't passed that check yet");
      expect(message).toContain("Wait for file processing to finish, then check again");
      expect(message).toContain("If it still fails, contact support");
      expect(message).not.toMatch(/\bremove\b/i);
      expect(message).not.toMatch(/register/i);
      expectBoundedCopy(message);
    });

    it.each(OVD993_EXPLAINED_CODES)("explains %s in the form's words without promising an action", (code) => {
      const message = getXometryBetaScopeFailureMessage(postgrestError(code), "fictiv");
      expect(message).toContain("Requested services include a service other than Manufacturing quote");
      // Every option the form offers is named, so the customer recognizes which one applies.
      for (const option of REQUESTED_SERVICE_TYPE_OPTIONS) {
        expect(message, option.code).toContain(option.label);
      }
      expect(message).toContain("Requested services are recorded when the part is uploaded");
      expect(message).toContain("only manufacturing can be quoted here");
      // Nothing in the dialog changes the job's services, so no retry, set or remove instruction.
      expect(message).not.toMatch(/\b(?:retry|set|remove|clear|change|then)\b/i);
      expectBoundedCopy(message);
    });
  });

  it("keeps the generic copy for explicit denials without a field mapping", () => {
    for (const code of ["provider_dispatch_job_busy", "provider_dispatch_scope_mismatch", "xometry_beta_trusted_step_required", "xometry_beta_exact_scope_required"]) {
      expect(getXometryBetaScopeFailureMessage(postgrestError(code)))
        .toBe("This part can't be quoted here right now. Review its files and manufacturing requirements.");
    }
  });
});

describe("set-field denial copy (OVD-995)", () => {
  it.each([
    "xometry_beta_special_requirements_not_supported",
    "provider_dispatch_special_requirements_not_supported",
  ])("names only known set fields for %s", (code) => {
    const message = getXometryBetaScopeFailureMessage(postgrestError(code), "fictiv", {
      requestComplete: true,
      request: {
        threads: null, notes: "Deburr", serviceNotes: null, requestedByDate: null,
        shipping: { packagingNotes: null, shippingNotes: null, requestedByDateOverride: null },
        certifications: { requiredCertifications: [], materialCertificationRequired: false,
          certificateOfConformanceRequired: false, inspectionLevel: "standard", notes: null },
        sourcing: { preferredSuppliers: [], regionPreferenceOverride: "best_value", materialProvisioning: "supplier_to_source", notes: null },
        release: { releaseStatus: "released", reviewDisposition: null, quoteBlockedUntilRelease: null, notes: null },
      },
    });
    expect(message).toContain("We can't quote Notes yet.");
    expect(message).not.toContain("Threads");
    expect(message).not.toContain("certifications");
    expect(message).not.toContain("Need by date");
    expect(message).not.toContain("release hold");
  });
  it("omits default-valued metadata and whitespace-only text", () => {
    const message = getXometryBetaScopeFailureMessage(postgrestError("provider_dispatch_special_requirements_not_supported"), "fictiv", {
      requestComplete: true,
      request: {
        threads: " ", notes: " ", serviceNotes: " ",
        shipping: { packagingNotes: null, shippingNotes: null, requestedByDateOverride: null },
        certifications: { requiredCertifications: [], materialCertificationRequired: false,
          certificateOfConformanceRequired: false, inspectionLevel: "standard", notes: null },
        sourcing: { preferredSuppliers: [], regionPreferenceOverride: "best_value", materialProvisioning: "supplier_to_source", notes: null },
        release: { releaseStatus: "released", reviewDisposition: null, quoteBlockedUntilRelease: null, notes: null },
      },
    });
    expect(message).toContain("the saved special requirements");
    expect(message).not.toContain("Threads");
    expect(message).not.toContain("certifications");
    expect(message).not.toContain("release hold");
  });
  it.each([
    "xometry_beta_special_requirements_not_supported",
    "provider_dispatch_special_requirements_not_supported",
  ])("names the full list for %s when the draft is not known to be complete (QA: saved packaging notes)", (code) => {
    // The part page's draft comes from the client part metadata, which omits packaging notes;
    // normalization still fills every key with null, so the shape alone cannot prove completeness.
    const message = getXometryBetaScopeFailureMessage(postgrestError(code), "fictiv", {
      request: {
        threads: null, notes: "Deburr all edges", serviceNotes: null, requestedByDate: null,
        shipping: { packagingNotes: null, shippingNotes: null, requestedByDateOverride: null },
        certifications: { requiredCertifications: [], materialCertificationRequired: false,
          certificateOfConformanceRequired: false, inspectionLevel: "standard", notes: null },
        sourcing: { preferredSuppliers: [], regionPreferenceOverride: "best_value", materialProvisioning: "supplier_to_source", notes: null },
        release: { releaseStatus: "released", reviewDisposition: null, quoteBlockedUntilRelease: null, notes: null },
      },
    });
    expect(message).toContain("Notes (including service, packaging, shipping, certification, sourcing and release notes)");
    expect(message).toContain("Threads");
    expect(message).not.toContain("We can't quote Notes yet.");
  });
  it("does not invent a set field when the complete client payload is empty", () => {
    const message = getXometryBetaScopeFailureMessage(postgrestError("provider_dispatch_special_requirements_not_supported"), "fictiv", {
      requestComplete: true,
      request: {
        threads: null, notes: null, serviceNotes: null, requestedByDate: null,
        shipping: { packagingNotes: null, shippingNotes: null, requestedByDateOverride: null },
        certifications: { requiredCertifications: [], materialCertificationRequired: false,
          certificateOfConformanceRequired: false, inspectionLevel: "standard", notes: null },
        sourcing: { preferredSuppliers: [], regionPreferenceOverride: "best_value", materialProvisioning: "supplier_to_source", notes: null },
        release: { releaseStatus: "released", reviewDisposition: null, quoteBlockedUntilRelease: null, notes: null },
      },
    });
    expect(message).toContain("the saved special requirements");
    expect(message).not.toContain("Threads");
  });
});

it.each(["xometry", "fictiv"] as const)("gives %s the single positive quantity remedy without naming a supplier", (provider) => {
  const message = getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_single_quantity_required"), provider);
  expect(message).not.toMatch(/Xometry|Fictiv/);
  expect(message).toContain("exactly one quantity of 1 or more");
  expect(message).toContain("Remove extra Quote quantities");
  expect(message).toContain("request it as its own quote");
  expect(message).not.toMatch(/quantity 1 only|Set Qty to 1|limit|maximum|_required/);
});
