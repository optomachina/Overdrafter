import { describe, expect, it } from "vitest";
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
