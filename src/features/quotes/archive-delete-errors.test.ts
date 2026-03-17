import { describe, expect, it } from "vitest";

import { getArchivedDeleteErrorMessage, toArchivedDeleteError } from "./archive-delete-errors";

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
});
