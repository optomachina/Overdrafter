// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ProviderUploadCapabilityObserved } from "./providerUploadCapabilityTypes";
import {
  createXometryUploadCapabilityCheckpoint,
  parseXometryAdmission,
  supabaseXometryAdmissionReader,
  XOMETRY_ADMISSION_RPC,
} from "./xometryUploadAdmission";

function admissionPayload(overrides: Record<string, unknown> = {}) {
  return {
    schema: "xometry-admission-read.v1",
    policy_present: true,
    provider_admitted: true,
    generically_dispatchable: false,
    provider: "xometry",
    admission_state: "controlled_beta_only",
    policy_revision: "xometry-beta-v1",
    evidence_reference: "OVD-379",
    permission_basis: "existing_controlled_beta_path",
    supported_processes: ["cnc_milling"],
    accepted_file_extensions: ["step", "stp"],
    session_owner: "overdrafter_managed",
    reviewed_at: "2026-01-01T00:00:00.000Z",
    expires_at: null,
    reason_code: "controlled_beta_only",
    ...overrides,
  };
}

const observed: ProviderUploadCapabilityObserved = {
  state: "fresh",
  provider: "xometry",
  route: "quote_home",
  surface: "dashboard_upload",
  revision: "xometry-upload-surface.v1",
  acceptAttributePresent: true,
  extensions: ["step", "stp"],
  mimeTypes: [],
};

const DENYING = [
  "observation_missing",
  "ambiguous_input",
  "denied",
  "observation_stale",
  "route_or_selector_drift",
];

describe("Xometry upload capability checkpoint (OVD-414)", () => {
  it("passes when the database admission is current and the observed surface matches it", async () => {
    const decision = await createXometryUploadCapabilityCheckpoint(async () => admissionPayload())(observed);
    expect(decision.classification).toBe("matches_policy");
    expect(decision.allowedExtensions).toEqual(["step", "stp"]);
  });

  it("denies when the observed accept list differs from the admission list", async () => {
    const decision = await createXometryUploadCapabilityCheckpoint(async () => admissionPayload())({
      ...observed,
      extensions: ["step", "stp", "exe"],
    });
    expect(decision.classification).toBe("format_added");
  });

  it("denies a disabled or expired admission with a classification only", async () => {
    const disabled = await createXometryUploadCapabilityCheckpoint(async () =>
      admissionPayload({ provider_admitted: false, admission_state: "disabled", reason_code: "provider_disabled" }),
    )(observed);
    expect(DENYING).toContain(disabled.classification);
    expect(disabled.allowedExtensions).toEqual([]);
    const expired = await createXometryUploadCapabilityCheckpoint(async () =>
      admissionPayload({ expires_at: "2026-01-02T00:00:00.000Z" }),
    )(observed);
    expect(expired.allowedExtensions).toEqual([]);
    expect(expired.classification).not.toBe("matches_policy");
  });

  it("denies when the RPC errors, without leaking the error", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "secret db detail", code: "XX000" } });
    const decision = await createXometryUploadCapabilityCheckpoint(supabaseXometryAdmissionReader({ rpc } as never))(observed);
    expect(rpc).toHaveBeenCalledWith(XOMETRY_ADMISSION_RPC);
    expect(decision.classification).toBe("observation_missing");
    expect(JSON.stringify(decision)).not.toContain("secret");
  });

  it("denies when the RPC is missing from the database", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const decision = await createXometryUploadCapabilityCheckpoint(supabaseXometryAdmissionReader({ rpc } as never))(observed);
    expect(decision.classification).toBe("observation_missing");
    expect(decision.allowedExtensions).toEqual([]);
  });

  it("denies when the reader throws or returns nothing", async () => {
    const thrown = await createXometryUploadCapabilityCheckpoint(async () => {
      throw new Error("boom");
    })(observed);
    expect(thrown.classification).toBe("observation_missing");
    const empty = await createXometryUploadCapabilityCheckpoint(async () => null)(observed);
    expect(empty.classification).toBe("observation_missing");
  });

  it("denies when the read exceeds the timeout", async () => {
    const decision = await createXometryUploadCapabilityCheckpoint(() => new Promise(() => undefined), 10)(observed);
    expect(decision.classification).toBe("observation_missing");
  });

  it.each([
    ["a string", "nope"],
    ["an array", []],
    ["a wrong schema", admissionPayload({ schema: "other.v1" })],
    ["an extra key", admissionPayload({ extra: 1 })],
    ["a non-boolean flag", admissionPayload({ provider_admitted: "true" })],
    ["a non-array extension list", admissionPayload({ accepted_file_extensions: "step" })],
  ])("denies a malformed response: %s", async (_label, payload) => {
    expect(parseXometryAdmission(payload)).toBeNull();
    const decision = await createXometryUploadCapabilityCheckpoint(async () => payload)(observed);
    expect(decision.classification).toBe("ambiguous_input");
    expect(decision.allowedExtensions).toEqual([]);
  });

  it("denies when the admission lacks a policy revision or evidence reference", async () => {
    const decision = await createXometryUploadCapabilityCheckpoint(async () =>
      admissionPayload({ policy_revision: null, evidence_reference: null }),
    )(observed);
    expect(decision.classification).not.toBe("matches_policy");
    expect(decision.allowedExtensions).toEqual([]);
  });
});
