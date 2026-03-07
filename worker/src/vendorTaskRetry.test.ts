// @vitest-environment node

import { describe, expect, it } from "vitest";
import { VendorAutomationError } from "./types";
import {
  failureCodeForError,
  isRetryableVendorTaskError,
  nextRetryAt,
  retryCountForAttempts,
} from "./vendorTaskRetry";

describe("vendorTaskRetry", () => {
  it("classifies retryable and terminal vendor automation errors", () => {
    expect(
      isRetryableVendorTaskError(
        new VendorAutomationError("navigation failed", "navigation_failure"),
      ),
    ).toBe(true);
    expect(
      isRetryableVendorTaskError(
        new VendorAutomationError("upload failed", "upload_failure", {
          reason: "browser_upload_timeout",
        }),
      ),
    ).toBe(true);
    expect(
      isRetryableVendorTaskError(
        new VendorAutomationError("missing cad", "upload_failure", {
          reason: "missing_cad_file",
        }),
      ),
    ).toBe(false);
    expect(
      isRetryableVendorTaskError(
        new VendorAutomationError("login required", "login_required"),
      ),
    ).toBe(false);
    expect(
      isRetryableVendorTaskError(
        new VendorAutomationError("selector drift", "selector_failure"),
      ),
    ).toBe(false);
    expect(
      isRetryableVendorTaskError(
        new VendorAutomationError("unexpected ui", "unexpected_ui_state"),
      ),
    ).toBe(false);
  });

  it("treats structural task errors as terminal and transport failures as retryable", () => {
    expect(
      isRetryableVendorTaskError(new Error("No approved requirement found for part part-1.")),
    ).toBe(false);
    expect(
      isRetryableVendorTaskError(new Error("Vendor quote result row was not found.")),
    ).toBe(false);
    expect(
      isRetryableVendorTaskError(new Error("Failed to download storage object cad/part.step.")),
    ).toBe(true);
  });

  it("derives retry counts, schedules, and failure codes", () => {
    const start = new Date("2026-03-07T12:00:00.000Z");

    expect(retryCountForAttempts(1)).toBe(0);
    expect(retryCountForAttempts(3)).toBe(2);
    expect(nextRetryAt(1, start)).toBe("2026-03-07T12:01:00.000Z");
    expect(nextRetryAt(2, start)).toBe("2026-03-07T12:05:00.000Z");
    expect(nextRetryAt(3, start)).toBe("2026-03-07T12:15:00.000Z");
    expect(nextRetryAt(4, start)).toBeNull();
    expect(
      failureCodeForError(new VendorAutomationError("captcha", "captcha")),
    ).toBe("captcha");
    expect(failureCodeForError(new Error("boom"))).toBe("task_failure");
  });
});
