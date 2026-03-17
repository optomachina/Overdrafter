import { describe, expect, it } from "vitest";
import { canUserEditJobWithoutAuthContext } from "../../../supabase/functions/job-archive-fallback/authorization";

describe("job archive fallback authorization", () => {
  it("allows the job creator", () => {
    expect(
      canUserEditJobWithoutAuthContext({
        createdByMatchesUser: true,
        isOrgMember: false,
        canEditDirectProject: false,
        canEditProjectViaJoinTable: false,
      }),
    ).toBe(true);
  });

  it("allows organization members such as client users", () => {
    expect(
      canUserEditJobWithoutAuthContext({
        createdByMatchesUser: false,
        isOrgMember: true,
        canEditDirectProject: false,
        canEditProjectViaJoinTable: false,
      }),
    ).toBe(true);
  });

  it("allows project editors reached through a direct jobs.project_id link", () => {
    expect(
      canUserEditJobWithoutAuthContext({
        createdByMatchesUser: false,
        isOrgMember: false,
        canEditDirectProject: true,
        canEditProjectViaJoinTable: false,
      }),
    ).toBe(true);
  });

  it("allows project editors reached through project_jobs", () => {
    expect(
      canUserEditJobWithoutAuthContext({
        createdByMatchesUser: false,
        isOrgMember: false,
        canEditDirectProject: false,
        canEditProjectViaJoinTable: true,
      }),
    ).toBe(true);
  });

  it("rejects users with no matching ownership or membership", () => {
    expect(
      canUserEditJobWithoutAuthContext({
        createdByMatchesUser: false,
        isOrgMember: false,
        canEditDirectProject: false,
        canEditProjectViaJoinTable: false,
      }),
    ).toBe(false);
  });
});
