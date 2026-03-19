import { describe, expect, it } from "vitest";

import {
  getArchivedDeleteErrorMessage,
  getArchivedDeleteReporting,
  toArchivedDeleteError,
  withArchivedDeleteReporting,
} from "./archive-delete-errors";

describe("archive delete errors", () => {
  it("falls back when an Error has a blank message", () => {
    expect(toArchivedDeleteError(new Error("")).message).toBe("Failed to delete archived part.");
  });

  it("sanitizes raw foreign-key constraint text for user-facing messages", () => {
    const error = {
      code: "23503",
      message:
        'update or delete on table "vendor_quote_results" violates foreign key constraint "published_quote_options_source_vendor_quote_id_fkey" on table "published_quote_options"',
      details: 'Key (id)=(quote-result-1) is still referenced from table "published_quote_options".',
      hint: null,
    };

    expect(getArchivedDeleteErrorMessage(error)).toBe(
      "Failed to delete archived part because related records still exist.",
    );
    expect(toArchivedDeleteError(error).message).toBe(
      "Failed to delete archived part because related records still exist.",
    );
  });

  it("preserves archived delete reporting when wrapping raw errors", () => {
    const wrapped = withArchivedDeleteReporting(new Error("Edge returned 404"), {
      operation: "archived_delete",
      fallbackPath: "job-archive-fallback",
      failureCategory: "edge_not_deployed",
      failureSummary:
        "Archived part deletion is unavailable in this environment because the cleanup service is not deployed.",
      likelyCause: "The job-archive-fallback Edge Function is unavailable in the active Supabase project.",
      recommendedChecks: ["Verify that job-archive-fallback is deployed to the active Supabase project."],
      httpStatus: 404,
      hasResponseBody: true,
      functionName: "job-archive-fallback",
      functionPath: "/functions/v1/job-archive-fallback",
      functionUrl: "https://previewref.supabase.co/functions/v1/job-archive-fallback",
      supabaseOrigin: "https://previewref.supabase.co",
      supabaseProjectRef: "previewref",
      rawErrorName: "Error",
      rawErrorMessage: "Edge returned 404",
      rawErrorStatus: 404,
      partIds: ["job-1"],
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(toArchivedDeleteError(wrapped).message).toBe(
      "Archived part deletion is unavailable in this environment because the cleanup service is not deployed.",
    );
    expect(getArchivedDeleteReporting(wrapped)).toMatchObject({
      failureCategory: "edge_not_deployed",
      httpStatus: 404,
      partIds: ["job-1"],
      organizationId: "org-1",
      userId: "user-1",
    });
  });
});
