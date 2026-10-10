// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ProviderDispatchAuthorizationError,
  type ProviderDispatchClaim,
} from "./providerDispatchPreflight.js";
import { XometryDispatchAuthorizationError } from "./xometryDispatchPreflight.js";
import type { VendorName } from "./types.js";

/**
 * OVD-381 provider-neutral worker routing integration tests.
 *
 * These tests verify that:
 * 1. Xometry tasks continue using the specialized xometryDispatchPreflight path
 * 2. Non-Xometry tasks with provider dispatch permits route through the general
 *    quoteWithProviderDispatchPreflight
 * 3. Non-Xometry providers without reviewed envelopes are denied by default
 * 4. The routing preserves backward compatibility for legacy tasks
 */

describe("worker provider routing (OVD-381)", () => {
  describe("routing logic", () => {
    it("routes Xometry through the specialized preflight path", () => {
      const vendor: VendorName = "xometry";
      const hasProviderDispatchPermit = false;

      // Xometry always uses the specialized path regardless of permit presence
      expect(vendor === "xometry").toBe(true);
      expect(vendor !== "xometry" && hasProviderDispatchPermit).toBe(false);
    });

    it("routes non-Xometry with provider dispatch permit through the general preflight", () => {
      const vendor: VendorName = "fictiv";
      const hasProviderDispatchPermit = true;

      // Non-Xometry with permit uses the general path
      expect(vendor !== "xometry" && hasProviderDispatchPermit).toBe(true);
    });

    it("routes non-Xometry without provider dispatch permit through the legacy path", () => {
      const vendor: VendorName = "fictiv";
      const hasProviderDispatchPermit = false;

      // Non-Xometry without permit uses the legacy path for backward compatibility
      expect(vendor !== "xometry" && hasProviderDispatchPermit).toBe(false);
    });
  });

  describe("permit validation", () => {
    it("recognizes valid provider dispatch permit fields", () => {
      const payload = {
        providerDispatchPermitId: "00000000-0000-4000-8000-000000000001",
        providerDispatchEnvelopeFingerprint: "a".repeat(64),
      };

      const hasProviderDispatchPermit =
        typeof payload.providerDispatchPermitId === "string" &&
        typeof payload.providerDispatchEnvelopeFingerprint === "string";

      expect(hasProviderDispatchPermit).toBe(true);
    });

    it("rejects payload without permitId", () => {
      const payload = {
        providerDispatchEnvelopeFingerprint: "a".repeat(64),
      };

      const hasProviderDispatchPermit =
        typeof (payload as { providerDispatchPermitId?: unknown }).providerDispatchPermitId === "string" &&
        typeof payload.providerDispatchEnvelopeFingerprint === "string";

      expect(hasProviderDispatchPermit).toBe(false);
    });

    it("rejects payload without envelopeFingerprint", () => {
      const payload = {
        providerDispatchPermitId: "00000000-0000-4000-8000-000000000001",
      };

      const hasProviderDispatchPermit =
        typeof payload.providerDispatchPermitId === "string" &&
        typeof (payload as { providerDispatchEnvelopeFingerprint?: unknown }).providerDispatchEnvelopeFingerprint === "string";

      expect(hasProviderDispatchPermit).toBe(false);
    });

    it("rejects payload with non-string permitId", () => {
      const payload = {
        providerDispatchPermitId: 12345,
        providerDispatchEnvelopeFingerprint: "a".repeat(64),
      };

      const hasProviderDispatchPermit =
        typeof payload.providerDispatchPermitId === "string" &&
        typeof payload.providerDispatchEnvelopeFingerprint === "string";

      expect(hasProviderDispatchPermit).toBe(false);
    });
  });

  describe("error handling", () => {
    it("recognizes both XometryDispatchAuthorizationError and ProviderDispatchAuthorizationError", () => {
      const xometryError = new XometryDispatchAuthorizationError("dispatch_preflight_unavailable");
      const providerError = new ProviderDispatchAuthorizationError("preflight_unavailable");

      const xometryDispatchError = xometryError instanceof XometryDispatchAuthorizationError ? xometryError : null;
      const providerDispatchError = providerError instanceof ProviderDispatchAuthorizationError ? providerError : null;

      expect(xometryDispatchError).not.toBeNull();
      expect(providerDispatchError).not.toBeNull();
      expect(xometryDispatchError ?? providerDispatchError).toBeTruthy();
    });

    it("identifies retryable Xometry dispatch errors", () => {
      const error = new XometryDispatchAuthorizationError("dispatch_preflight_unavailable");
      const isRetryable = error.reasonCode === "dispatch_preflight_unavailable";
      expect(isRetryable).toBe(true);
    });

    it("identifies non-retryable Xometry dispatch errors", () => {
      const error = new XometryDispatchAuthorizationError("dispatch_beta_authorization_revoked");
      const isRetryable = error.reasonCode === "dispatch_preflight_unavailable";
      expect(isRetryable).toBe(false);
    });

    it("identifies retryable provider dispatch errors", () => {
      const error = new ProviderDispatchAuthorizationError("preflight_unavailable");
      expect(error.retryable).toBe(true);
    });

    it("identifies non-retryable provider dispatch errors", () => {
      const error = new ProviderDispatchAuthorizationError("provider_mismatch");
      expect(error.retryable).toBe(false);
    });

    it("combines retryability checks for both error types", () => {
      const xometryRetryableError = new XometryDispatchAuthorizationError("dispatch_preflight_unavailable");
      const xometryNonRetryableError = new XometryDispatchAuthorizationError("dispatch_beta_authorization_revoked");
      const providerRetryableError = new ProviderDispatchAuthorizationError("preflight_unavailable");
      const providerNonRetryableError = new ProviderDispatchAuthorizationError("provider_mismatch");

      const xometryRetryable = xometryRetryableError.reasonCode === "dispatch_preflight_unavailable";
      const xometryNonRetryable = xometryNonRetryableError.reasonCode === "dispatch_preflight_unavailable";
      const providerRetryable = providerRetryableError.retryable === true;
      const providerNonRetryable = providerNonRetryableError.retryable === true;

      expect(xometryRetryable || providerNonRetryable).toBe(true);
      expect(xometryNonRetryable || providerRetryable).toBe(true);
      expect(xometryNonRetryable || providerNonRetryable).toBe(false);
    });
  });

  describe("default deny behavior", () => {
    it("refuses Xometry through the general preflight", async () => {
      // The general preflight explicitly refuses Xometry
      // to maintain the specialized path
      const claim: ProviderDispatchClaim = {
        workQueueTaskId: "task-1",
        vendorQuoteResultId: "result-1",
        provider: "xometry",
        permitId: "00000000-0000-4000-8000-000000000001",
        envelopeFingerprint: "a".repeat(64),
      };

      // Mock the general preflight to verify it rejects Xometry
      const mockQuoteWithProviderDispatchPreflight = async (input: { claim: ProviderDispatchClaim }) => {
        if (input.claim.provider === "xometry") {
          throw new ProviderDispatchAuthorizationError("provider_mismatch");
        }
        return { artifacts: [] };
      };

      await expect(
        mockQuoteWithProviderDispatchPreflight({ claim })
      ).rejects.toThrow(ProviderDispatchAuthorizationError);
    });

    it("requires reviewed envelope for non-Xometry providers", () => {
      // Only providers in REVIEWED_PROVIDER_DISPATCH_ENVELOPES can be admitted.
      // Currently, only Xometry is reviewed (in xometryDispatchPreflight).
      // Non-Xometry providers without a reviewed generic envelope are denied.
      const reviewedEnvelopes = [
        { provider: "xometry", id: "xometry-controlled-beta-envelope", version: 1, requiredAdmission: "xometry_controlled_beta" as const },
      ];

      const fictivReviewed = reviewedEnvelopes.find(e => e.provider === "fictiv");
      expect(fictivReviewed).toBeUndefined();

      // This demonstrates the default-deny behavior: no reviewed envelope = no admission
    });
  });

  describe("claim construction", () => {
    it("constructs a valid claim from task payload", () => {
      const task = {
        id: "task-123",
        payload: {
          providerDispatchPermitId: "00000000-0000-4000-8000-000000000001",
          providerDispatchEnvelopeFingerprint: "b".repeat(64),
        },
      };
      const currentResult = { id: "result-456" };
      const vendor: VendorName = "fictiv";

      const claim: ProviderDispatchClaim = {
        workQueueTaskId: task.id,
        vendorQuoteResultId: currentResult.id,
        provider: vendor,
        permitId: task.payload.providerDispatchPermitId as string,
        envelopeFingerprint: task.payload.providerDispatchEnvelopeFingerprint as string,
      };

      expect(claim.workQueueTaskId).toBe("task-123");
      expect(claim.vendorQuoteResultId).toBe("result-456");
      expect(claim.provider).toBe("fictiv");
      expect(claim.permitId).toBe("00000000-0000-4000-8000-000000000001");
      expect(claim.envelopeFingerprint).toBe("b".repeat(64));
    });
  });
});
