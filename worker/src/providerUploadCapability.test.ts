import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decideProviderUploadCapability,
  normalizeProviderUploadExtensions,
  normalizeProviderUploadMimeTypes,
} from "./providerUploadCapability.js";

const envelope = {
  provider: "xometry",
  route: "quote",
  surface: "cad-upload",
  revision: "r1",
  extensions: [".STEP", "stp"],
  policyRevision: "xometry-controlled-beta-2026-08-17.v1",
  evidenceReference: "OVD-373",
};
const admissionResolver = {
  policy_present: true,
  provider_admitted: true,
  generically_dispatchable: false,
  provider: "xometry",
  admission_state: "controlled_beta_only",
  policy_revision: envelope.policyRevision,
  evidence_reference: envelope.evidenceReference,
  permission_basis: "existing_controlled_beta_path",
  supported_processes: ["cnc_milling"],
  accepted_file_extensions: ["step", "stp"],
  session_owner: "overdrafter_managed",
  reviewed_at: "2026-08-17T00:00:00.000Z",
  expires_at: null,
  reason_code: "controlled_beta_only",
};
const observed = {
  ...envelope,
  state: "fresh" as const,
  acceptAttributePresent: true,
  mimeTypes: ["model/step"],
  evidenceRefs: ["issue:OVD-387"],
};

afterEach(() => vi.restoreAllMocks());

function timedInput(approved = false) {
  const releaseEnvelope = { ...envelope,
    provider: approved ? "quickparts" : "xometry", route: "quote_home", surface: "account_quote_modal",
    revision: "xometry-account-quote-modal.v1",
  };
  return {
    releaseEnvelope,
    admissionResolver: { ...admissionResolver, provider: releaseEnvelope.provider,
      generically_dispatchable: approved, admission_state: approved ? "approved" : "controlled_beta_only",
      reason_code: approved ? "provider_approved" : "controlled_beta_only",
      permission_basis: approved ? "written_provider_authorization" : "existing_controlled_beta_path",
      expires_at: "2026-10-02T12:00:00.000Z" as string | null,
    },
    observed: { ...releaseEnvelope, state: "fresh" as const, acceptAttributePresent: approved,
      extensions: approved ? ["step", "stp"] : undefined },
  };
}

function decide(input: {
  releaseEnvelope?: typeof envelope;
  admissionResolver?: typeof admissionResolver;
  observed?: typeof observed;
} = {}) {
  return decideProviderUploadCapability({
    releaseEnvelope: input.releaseEnvelope ?? envelope,
    admissionResolver: input.admissionResolver ?? admissionResolver,
    observed: input.observed ?? observed,
  });
}

describe("provider upload capability contract", () => {
  it.each([false, true])("uses explicit time for expiry boundaries (approved=%s)", (approved) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T00:00:00.000Z"));
    const input = timedInput(approved);
    const expiry = Date.parse(input.admissionResolver.expires_at!);
    for (const nowMs of [expiry - 1, expiry, expiry + 1]) {
      const timed = { ...input, nowMs };
      expect(decideProviderUploadCapability(timed)).toMatchObject(nowMs < expiry
        ? { classification: approved ? "matches_policy" : "reviewed_missing_accept_xometry", allowedExtensions: ["step", "stp"] }
        : { classification: "observation_stale", allowedExtensions: [] });
    }
    expect(Date.now).not.toHaveBeenCalled();
  });

  it("classifies an expired admitted snapshot as stale with the default clock", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-02T12:00:00.000Z"));
    expect(decideProviderUploadCapability(timedInput())).toMatchObject({ classification: "observation_stale", allowedExtensions: [] });
    expect(Date.now).toHaveBeenCalledTimes(1);
  });

  it("captures the compatibility clock once even across the reviewed-exception checks", () => {
    const clock = vi.spyOn(Date, "now")
      .mockReturnValueOnce(Date.parse("2026-10-02T11:59:59.999Z"))
      .mockReturnValue(Date.parse("2026-10-02T12:00:00.001Z"));
    expect(decideProviderUploadCapability(timedInput())).toMatchObject({ classification: "reviewed_missing_accept_xometry", allowedExtensions: ["step", "stp"] });
    expect(clock).toHaveBeenCalledTimes(1);
  });

  it.each([null, "2099-01-01T00:00:00.000Z"])("rejects a future review with expiry %s", (expires_at) => {
    const nowMs = Date.parse("2026-10-02T12:00:00.000Z");
    const input = timedInput();
    input.admissionResolver.reviewed_at = "2026-10-02T12:00:00.001Z";
    input.admissionResolver.expires_at = expires_at;
    expect(decideProviderUploadCapability({ ...input, nowMs })).toMatchObject({ classification: "denied", allowedExtensions: [] });
    input.admissionResolver.reviewed_at = "2026-10-02T12:00:00.000Z";
    expect(decideProviderUploadCapability({ ...input, nowMs })).toMatchObject({ classification: "reviewed_missing_accept_xometry", allowedExtensions: ["step", "stp"] });
  });

  it.each([undefined, null, "2026-10-02", Number.NaN, Infinity, -Infinity, 1.5, 8640000000000001, -8640000000000001])("fails closed for supplied invalid time %s without ambient fallback", (nowMs) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-02T11:59:59.999Z"));
    expect(decideProviderUploadCapability({ ...timedInput(), nowMs } as never)).toMatchObject({ classification: "ambiguous_input", allowedExtensions: [] });
    expect(clock).not.toHaveBeenCalled();
  });

  it("keeps explicit-clock decisions identical under differing ambient clocks", () => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("ambient clock must not be read"); });
    const input = { ...timedInput(), nowMs: Date.parse("2026-10-02T11:59:59.999Z") };
    const first = decideProviderUploadCapability(input);
    clock.mockReturnValue(Date.parse("2099-01-01T00:00:00.000Z"));
    expect(decideProviderUploadCapability(input)).toEqual(first);
    expect(first.allowedExtensions).toEqual(["step", "stp"]);
    expect(clock).not.toHaveBeenCalled();
  });

  it("normalizes, deduplicates, and sorts extensions while keeping MIME separate", () => {
    expect(normalizeProviderUploadExtensions([".STEP", "stp", ".step"])).toEqual(["step", "stp"]);
    expect(normalizeProviderUploadMimeTypes(["Application/STEP", "application/step"])).toEqual(["application/step"]);
    expect(normalizeProviderUploadMimeTypes(["model/x.json", "model/x-json", "model/x+json"])).toEqual(["model/x+json", "model/x-json", "model/x.json"]);
    expect(() => normalizeProviderUploadExtensions(["../step"])).toThrow();
    expect(() => normalizeProviderUploadExtensions([".tar.gz"])).toThrow();
    expect(() => normalizeProviderUploadMimeTypes(["step"])).toThrow();
  });

  it("allows only the exact release, admitted policy, and fresh observation intersection", () => {
    expect(decide()).toMatchObject({ contractVersion: "provider-upload-capability.v1", classification: "matches_policy", allowedExtensions: ["step", "stp"] });
    expect(decide({ observed: { ...observed, extensions: [".STEP"] } })).toMatchObject({ allowedExtensions: ["step"] });
  });

  it("reports additions and removals without allowing additions", () => {
    expect(decide({ observed: { ...observed, extensions: ["step", "stp", "pdf"] } })).toMatchObject({ classification: "format_added", allowedExtensions: ["step", "stp"], reportedAddedExtensions: ["pdf"] });
    expect(decide({ observed: { ...observed, extensions: ["step"] } })).toMatchObject({ classification: "format_removed", allowedExtensions: ["step"], reportedRemovedExtensions: ["stp"] });
  });

  it("supports the missing-accept exception only for the exact current Xometry resolver result", () => {
    const exact = { ...envelope, route: "quote_home", surface: "account_quote_modal", revision: "xometry-account-quote-modal.v1", extensions: ["step"] };
    expect(decide({ releaseEnvelope: exact, admissionResolver: { ...admissionResolver, accepted_file_extensions: ["step"] }, observed: { ...exact, extensions: undefined, state: "fresh", acceptAttributePresent: false } })).toMatchObject({ classification: "reviewed_missing_accept_xometry", allowedExtensions: ["step"] });
    expect(decide({ releaseEnvelope: exact, admissionResolver: { ...admissionResolver, accepted_file_extensions: ["step"] }, observed: { ...exact, extensions: ["step"], state: "fresh", acceptAttributePresent: false } })).toMatchObject({ classification: "reviewed_missing_accept_xometry", allowedExtensions: ["step"] });
    expect(decide({ admissionResolver: { ...admissionResolver, provider_admitted: false }, observed: { ...observed, acceptAttributePresent: false } })).toMatchObject({ classification: "denied", allowedExtensions: [] });
  });

  it.each([
    { policy: ["iges"], observed: undefined, allowed: [], classification: "unsupported" },
    { policy: ["iges"], observed: ["iges"], allowed: [], classification: "unsupported" },
    { policy: ["igs"], observed: undefined, allowed: [], classification: "unsupported" },
    { policy: ["step", "igs"], observed: ["igs"], allowed: [], classification: "format_added" },
    { policy: [".STEP", "stp", "iges"], observed: undefined, allowed: ["step", "stp"], classification: "reviewed_missing_accept_xometry" },
    { policy: ["step", "stp", "iges"], observed: [".STEP", "stp", "iges"], allowed: ["step", "stp"], classification: "format_added" },
    { policy: ["step", "stp", "iges"], observed: ["iges"], allowed: [], classification: "format_added" },
    { policy: ["step", "stp", "iges"], observed: ["stp"], allowed: ["stp"], classification: "format_removed" },
    { policy: ["step", "stp", "iges"], observed: [], allowed: [], classification: "format_removed" },
    { policy: [".STEP", "StP", ".step", ".IGES"], observed: [".STEP", "step", ".IGES"], allowed: ["step"], classification: "format_added" },
  ])("bounds reviewed missing-accept formats to STEP/STP: %j", ({ policy, observed: formats, allowed, classification }) => {
    const input = timedInput();
    input.releaseEnvelope.extensions = policy;
    input.admissionResolver.accepted_file_extensions = policy;
    input.observed.extensions = formats;
    expect(decideProviderUploadCapability({ ...input, nowMs: Date.parse("2026-10-02T11:00:00.000Z") }))
      .toMatchObject({ classification, allowedExtensions: allowed });
  });

  it("keeps the fallback inside both release and admission format policies", () => {
    const input = timedInput();
    input.releaseEnvelope.extensions = ["step", "stp", "iges"];
    input.admissionResolver.accepted_file_extensions = ["step", "iges"];
    expect(decideProviderUploadCapability({ ...input, nowMs: Date.parse("2026-10-02T11:00:00.000Z") }))
      .toMatchObject({ classification: "reviewed_missing_accept_xometry", allowedExtensions: ["step"] });
    input.releaseEnvelope.extensions = ["iges"];
    input.admissionResolver.accepted_file_extensions = ["step", "iges"];
    expect(decideProviderUploadCapability({ ...input, nowMs: Date.parse("2026-10-02T11:00:00.000Z") }))
      .toMatchObject({ classification: "unsupported", allowedExtensions: [] });
  });

  it.each(["route", "surface", "revision"] as const)("does not grant fallback when both input identities change %s", (field) => {
    const input = timedInput();
    input.releaseEnvelope[field] = "unreviewed";
    input.observed[field] = "unreviewed";
    expect(decideProviderUploadCapability({ ...input, nowMs: Date.parse("2026-10-02T11:00:00.000Z") }))
      .toMatchObject({ classification: "accept_missing", allowedExtensions: [] });
  });

  it("does not grant a controlled-beta fallback to generic-approved Xometry", () => {
    const input = timedInput(true);
    input.releaseEnvelope.provider = "xometry";
    input.admissionResolver.provider = "xometry";
    input.observed.provider = "xometry";
    input.observed.acceptAttributePresent = false;
    expect(decideProviderUploadCapability({ ...input, nowMs: Date.parse("2026-10-02T11:00:00.000Z") }))
      .toMatchObject({ classification: "accept_missing", allowedExtensions: [] });
  });

  it.each([false, true])("keeps explicit-accept IGES intersection for approved=%s", (approved) => {
    const input = timedInput(approved);
    input.releaseEnvelope.extensions = ["iges"];
    input.admissionResolver.accepted_file_extensions = ["iges"];
    input.observed.extensions = ["iges"];
    input.observed.acceptAttributePresent = true;
    expect(decideProviderUploadCapability({ ...input, nowMs: Date.parse("2026-10-02T11:00:00.000Z") }))
      .toMatchObject({ classification: "matches_policy", allowedExtensions: ["iges"] });
    input.observed.acceptAttributePresent = false;
    if (approved) expect(decideProviderUploadCapability({ ...input, nowMs: Date.parse("2026-10-02T11:00:00.000Z") }))
      .toMatchObject({ classification: "accept_missing", allowedExtensions: [] });
  });

  it("allows a current approved OVD-379 provider only when accept is present", () => {
    const quickpartsEnvelope = {
      ...envelope,
      provider: "quickparts",
      policyRevision: "ovd379-approved-v1",
      evidenceReference: "OVD-379",
    };
    const quickpartsResolver = {
      ...admissionResolver,
      generically_dispatchable: true,
      provider: "quickparts",
      admission_state: "approved",
      policy_revision: quickpartsEnvelope.policyRevision,
      evidence_reference: quickpartsEnvelope.evidenceReference,
      permission_basis: "written_provider_authorization",
      expires_at: "2099-01-01T00:00:00.000Z",
      reason_code: "provider_approved",
    };
    const quickpartsObserved = { ...observed, provider: "quickparts" };

    expect(decide({
      releaseEnvelope: quickpartsEnvelope,
      admissionResolver: quickpartsResolver,
      observed: quickpartsObserved,
    })).toMatchObject({ classification: "matches_policy", allowedExtensions: ["step", "stp"] });
    expect(decide({
      releaseEnvelope: quickpartsEnvelope,
      admissionResolver: quickpartsResolver,
      observed: { ...quickpartsObserved, acceptAttributePresent: false },
    })).toMatchObject({ classification: "accept_missing", allowedExtensions: [] });
  });

  it("allows an approved non-CNC provider when its present accept list intersects policy", () => {
    const oshCutEnvelope = {
      ...envelope,
      provider: "oshcut",
      policyRevision: "oshcut-approved-v1",
      evidenceReference: "OVD-379",
    };
    const oshCutResolver = {
      ...admissionResolver,
      generically_dispatchable: true,
      provider: "oshcut",
      admission_state: "approved",
      policy_revision: oshCutEnvelope.policyRevision,
      evidence_reference: oshCutEnvelope.evidenceReference,
      permission_basis: "provider_terms_allow_automation",
      supported_processes: ["sheet_metal"],
      expires_at: "2099-01-01T00:00:00.000Z",
      reason_code: "provider_approved",
    };

    expect(decide({
      releaseEnvelope: oshCutEnvelope,
      admissionResolver: oshCutResolver,
      observed: { ...observed, provider: "oshcut" },
    })).toMatchObject({ classification: "matches_policy", allowedExtensions: ["step", "stp"] });
  });

  it.each([
    ["missing resolver", { ...admissionResolver, policy_present: false, provider_admitted: false, provider: null, reason_code: "provider_unknown" }, "observation_missing"],
    ["expired resolver", { ...admissionResolver, provider_admitted: false, expires_at: "2000-01-01T00:00:00.000Z", reason_code: "policy_expired" }, "observation_stale"],
    ["incomplete resolver", { ...admissionResolver, provider_admitted: false, reviewed_at: null, reason_code: "policy_incomplete" }, "denied"],
    ["mismatched revision", { ...admissionResolver, policy_revision: "other.v1" }, "route_or_selector_drift"],
    ["mismatched evidence", { ...admissionResolver, evidence_reference: "OVD-999" }, "route_or_selector_drift"],
  ] as const)("fails closed for %s evidence", (_name, resolver, classification) => {
    const exact = { ...envelope, route: "quote_home", surface: "account_quote_modal", revision: "xometry-account-quote-modal.v1", extensions: ["step"] };
    expect(decide({ releaseEnvelope: exact, admissionResolver: { ...resolver, accepted_file_extensions: ["step"] }, observed: { ...exact, extensions: undefined, state: "fresh", acceptAttributePresent: false } })).toMatchObject({ classification, allowedExtensions: [] });
  });

  it("fails closed for stale observation and malformed resolver flags", () => {
    expect(decide({ observed: { ...observed, state: "stale" } })).toMatchObject({ classification: "observation_stale", allowedExtensions: [] });
    expect(decide({ admissionResolver: { ...admissionResolver, provider_admitted: "true" } as never })).toMatchObject({ classification: "denied", allowedExtensions: [] });
  });

  it.each([
    ["permission basis", { permission_basis: "other" }],
    ["process envelope", { supported_processes: [] }],
    ["session ownership", { session_owner: "other_owner" }],
  ])("requires the complete controlled-beta resolver fields for %s", (_name, patch) => {
    expect(decide({ admissionResolver: { ...admissionResolver, ...patch } })).toMatchObject({
      classification: "denied",
      allowedExtensions: [],
    });
  });

  it.each([
    ["missing", "observation_missing"], ["stale", "observation_stale"], ["ambiguous", "ambiguous_input"], ["loading", "formats_loading"],
    ["route_or_selector_drift", "route_or_selector_drift"], ["authentication_required", "authentication_required"], ["anti_bot_or_challenge", "anti_bot_or_challenge"],
    ["provider_error", "provider_error"], ["unclassified_response", "unclassified_response"],
  ] as const)("fails closed for observed %s", (state, classification) => {
    expect(decide({ observed: { ...observed, state } })).toMatchObject({ classification, allowedExtensions: [] });
  });

  it("rejects a fresh observation that omits extensions outside the reviewed exception", () => {
    expect(decide({ observed: { ...observed, extensions: undefined } })).toMatchObject({ classification: "ambiguous_input", allowedExtensions: [] });
  });

  it("fails closed for an unknown runtime observation state and unsupported policy", () => {
    expect(decide({ observed: { ...observed, state: "unexpected" } as never })).toMatchObject({ classification: "ambiguous_input", allowedExtensions: [] });
    expect(decide({ admissionResolver: { ...admissionResolver, accepted_file_extensions: ["iges"] } })).toMatchObject({ classification: "unsupported", allowedExtensions: [] });
  });

  it("rejects route drift, malformed input, and cross-provider identity", () => {
    expect(decide({ observed: { ...observed, route: "other" } })).toMatchObject({ classification: "route_or_selector_drift" });
    expect(decide({ admissionResolver: { ...admissionResolver, provider: "fictiv" } })).toMatchObject({ classification: "route_or_selector_drift" });
    expect(decide({ releaseEnvelope: { ...envelope, extensions: ["bad/path"] } })).toMatchObject({ classification: "ambiguous_input", allowedExtensions: [] });
  });

  it("returns only exact public issue references and omits internal evidence payloads", () => {
    expect(decide({ observed: { ...observed, evidenceRefs: ["issue:OVD-387", "policy:OVD-373", "release:xometry-controlled-beta-2026-08-17.v1", "surface:account_quote_modal", "sha256:0123456789abcdef0123456789abcdef", "token:secret"] } })).toMatchObject({ evidenceRefs: ["issue:OVD-387"], normalizedObservedMimeTypes: ["model/step"] });
  });
});
