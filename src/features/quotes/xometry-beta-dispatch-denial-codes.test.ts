import { describe, expect, it } from "vitest";
import { REQUESTED_SERVICE_TYPE_OPTIONS } from "./service-intent";
import {
  LIVE_DISPATCH_PROVIDER_LABELS,
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
      expect(withThreads).toContain("You can clear Threads in the request editor if the part does not need them, then retry.");
      expect(withThreads).not.toContain("cannot be cleared");
      expect(withThreads).not.toContain("a part with thread callouts is outside the beta");
    });
  });

  it("keeps the drawing thread note off every other denial", () => {
    for (const code of [
      "xometry_beta_quantity_one_required",
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

  // OVD-993: the remaining envelope denials name the form field and a value the server accepts.
  describe("OVD-993 envelope field copy", () => {
    it.each([
      [
        "xometry_beta_cnc_milling_required",
        "Process",
        "If this part is CNC milled",
        "set Process to CNC milling",
        "a part made by another process is outside the beta",
      ],
      [
        "xometry_beta_6061_t6_required",
        "Material",
        "If this part is 6061-T6 aluminum",
        "set Material to 6061-T6 aluminum",
        "a part in another material is outside the beta",
      ],
      [
        "xometry_beta_as_machined_required",
        "Finish",
        "If this part needs no finish",
        "set Finish to As machined or leave it blank",
        "a part that needs another finish is outside the beta",
      ],
    ])("%s names the %s field, the accepted value and the way out", (code, field, condition, instruction, limit) => {
      const message = getXometryBetaScopeFailureMessage(postgrestError(code));
      expect(message).toContain(field);
      expect(message).toContain(condition);
      expect(message).toContain(`${instruction}, then retry`);
      expect(message).toContain(limit);
      // The instruction is conditional: a part that needs another value is never told to change it.
      expect(message.indexOf(condition)).toBeLessThan(message.indexOf(instruction));
      expectBoundedCopy(message);
    });

    it("tells the generic path's process denial to set a blank or unadmitted Process without naming a process list", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError("provider_dispatch_process_not_admitted"), "fictiv");
      expect(message).toContain("this request's Process is blank or not one of them");
      expect(message).toContain("Set Process to the process that makes this part, then retry");
      expect(message).toContain("if Fictiv is not admitted for that process, the part is outside the beta");
      // The admitted list lives in the server-side registry, and the generic resolver checks no material or finish.
      expect(message).not.toMatch(/CNC|mill/i);
      expect(message).not.toContain("Material");
      expect(message).not.toContain("Finish");
      expectBoundedCopy(message);
    });

    it("tells the drawing denial to wait for verification and retry, never to remove or re-register the drawing", () => {
      const message = getXometryBetaScopeFailureMessage(postgrestError("xometry_beta_compatible_drawing_required"));
      expect(message).toContain("a drawing only as a PDF whose uploaded bytes have been verified");
      expect(message).toContain("this part's drawing has not passed that check");
      expect(message).toContain("Wait for file processing to finish, then retry the scope check");
      expect(message).toContain("if it still fails, contact support");
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
      expect(message).toContain("controlled Fictiv beta dispatch quotes manufacturing only");
      expect(message).toContain("this request is outside the beta");
      // Nothing in the dialog changes the job's services, so no retry, set or remove instruction.
      expect(message).not.toMatch(/\b(?:retry|set|remove|clear|change|then)\b/i);
      expectBoundedCopy(message);
    });

    // The provider label comes from LIVE_DISPATCH_PROVIDER_LABELS and is the only provider-specific text.
    it.each([...OVD993_ACTIONABLE_CODES, ...OVD993_EXPLAINED_CODES])(
      "names the configured provider from the label source, never a hard-coded one, for %s",
      (code) => {
        const fictiv = getXometryBetaScopeFailureMessage(postgrestError(code), "fictiv");
        const xometry = getXometryBetaScopeFailureMessage(postgrestError(code), "xometry");
        expect(fictiv).toContain(LIVE_DISPATCH_PROVIDER_LABELS.fictiv);
        expect(fictiv).not.toContain(LIVE_DISPATCH_PROVIDER_LABELS.xometry);
        expect(xometry).toContain(LIVE_DISPATCH_PROVIDER_LABELS.xometry);
        expect(xometry).not.toContain(LIVE_DISPATCH_PROVIDER_LABELS.fictiv);
        expect(getXometryBetaScopeFailureMessage(postgrestError(code))).toBe(xometry);
        expect(fictiv.split(LIVE_DISPATCH_PROVIDER_LABELS.fictiv).join(LIVE_DISPATCH_PROVIDER_LABELS.xometry)).toBe(xometry);
      },
    );
  });

  it("keeps the generic copy for explicit denials without a field mapping", () => {
    for (const code of ["provider_dispatch_job_busy", "provider_dispatch_scope_mismatch", "xometry_beta_trusted_step_required"]) {
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
