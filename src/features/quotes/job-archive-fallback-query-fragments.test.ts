import { describe, expect, it, vi } from "vitest";
import { buildBlobOwnershipExclusionClause } from "../../../supabase/functions/job-archive-fallback/query-fragments";

describe("job archive fallback query fragments", () => {
  it("skips uuid array construction when there are no orphan blob ids", () => {
    const arrayBuilder = vi.fn();
    const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });

    const fragment = buildBlobOwnershipExclusionClause(sqlTag, arrayBuilder, []);

    expect(arrayBuilder).not.toHaveBeenCalled();
    expect(fragment.values).toEqual([]);
    expect(fragment.strings.join("")).toBe("");
  });

  it("builds the orphan blob exclusion clause when orphan blob ids exist", () => {
    const arrayToken = { token: "uuid-array" };
    const arrayBuilder = vi.fn(() => arrayToken);
    const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });

    const fragment = buildBlobOwnershipExclusionClause(sqlTag, arrayBuilder, ["blob-1"]);

    expect(arrayBuilder).toHaveBeenCalledWith(["blob-1"], "uuid");
    expect(fragment.values).toEqual([arrayToken]);
    expect(fragment.strings.join(" ")).toContain("blob.id = any(");
  });
});
