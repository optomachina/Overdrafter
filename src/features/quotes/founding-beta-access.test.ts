import { describe, expect, it } from "vitest";
import {
  getFoundingBetaStatusFromError,
  getFoundingBetaStatusFromRefetch,
  getFoundingBetaUploadMessage,
  isFoundingBetaEnforcementError,
  parseFoundingBetaAccess,
} from "./founding-beta-access";

const NOTICE = {
  policyRevision: "founding-beta-2026-08-15",
  termsPath: "/legal/beta-terms",
  privacyPath: "/legal/privacy",
};

describe("Founding Beta access contract", () => {
  it.each(["eligible", "not_enrolled", "notice_required", "revoked"] as const)(
    "accepts the %s server state",
    (state) => {
      expect(parseFoundingBetaAccess({ ...NOTICE, state })).toEqual({ ...NOTICE, state });
    },
  );

  it.each([null, {}, { ...NOTICE, state: "pro" }, { state: "eligible" }])(
    "fails closed for malformed access payloads",
    (payload) => {
      expect(() => parseFoundingBetaAccess(payload)).toThrow("could not be verified");
    },
  );

  it("uses beta-neutral blocked copy and the configured support address", () => {
    expect(getFoundingBetaUploadMessage("not_enrolled")).toContain("blaineswilson@gmail.com");
    expect(getFoundingBetaUploadMessage("revoked")).toContain("Existing parts and quotes remain available");
    expect(getFoundingBetaUploadMessage("notice_required")).toContain("accept the current Founding Beta notice");
    expect(getFoundingBetaUploadMessage("unavailable")).not.toMatch(/pro|required plan|upgrade/i);
  });

  it("maps server enforcement errors back to the safe client state", () => {
    expect(getFoundingBetaStatusFromError(new Error("founding_beta_revoked"))).toBe("revoked");
    expect(getFoundingBetaStatusFromError({ message: "founding_beta_notice_required" })).toBe("notice_required");
    expect(getFoundingBetaStatusFromError(new Error("permission denied"))).toBeNull();
    expect(isFoundingBetaEnforcementError(
      new Error("Founding Beta access and current notice acceptance are required."),
    )).toBe(true);
    expect(getFoundingBetaStatusFromError({
      message: { toString: () => "founding_beta_revoked" },
    })).toBeNull();
  });

  it("rejects stale eligible data when an authoritative refetch fails", () => {
    expect(getFoundingBetaStatusFromRefetch({
      data: { state: "eligible" },
      isError: true,
    })).toBe("unavailable");
    expect(getFoundingBetaStatusFromRefetch({
      data: { state: "eligible" },
      isError: false,
    })).toBe("eligible");
  });
});
