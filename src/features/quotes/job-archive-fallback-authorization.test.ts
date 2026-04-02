import { describe, expect, it } from "vitest";
import { canUserDestructivelyEditJobWithoutAuthContext } from "../../../supabase/functions/job-archive-fallback/authorization";

describe("job archive fallback authorization", () => {
  it("allows the job creator", () => {
    expect(
      canUserDestructivelyEditJobWithoutAuthContext({
        createdByMatchesUser: true,
        isInternalAdmin: false,
        canEditDirectProject: false,
        canEditProjectViaJoinTable: false,
      }),
    ).toBe(true);
  });

  it("allows internal admins without project membership", () => {
    expect(
      canUserDestructivelyEditJobWithoutAuthContext({
        createdByMatchesUser: false,
        isInternalAdmin: true,
        canEditDirectProject: false,
        canEditProjectViaJoinTable: false,
      }),
    ).toBe(true);
  });

  it("rejects plain organization members such as client users", () => {
    expect(
      canUserDestructivelyEditJobWithoutAuthContext({
        createdByMatchesUser: false,
        isInternalAdmin: false,
        canEditDirectProject: false,
        canEditProjectViaJoinTable: false,
      }),
    ).toBe(false);
  });

  it("allows project editors reached through a direct jobs.project_id link", () => {
    expect(
      canUserDestructivelyEditJobWithoutAuthContext({
        createdByMatchesUser: false,
        isInternalAdmin: false,
        canEditDirectProject: true,
        canEditProjectViaJoinTable: false,
      }),
    ).toBe(true);
  });

  it("allows project editors reached through project_jobs", () => {
    expect(
      canUserDestructivelyEditJobWithoutAuthContext({
        createdByMatchesUser: false,
        isInternalAdmin: false,
        canEditDirectProject: false,
        canEditProjectViaJoinTable: true,
      }),
    ).toBe(true);
  });

  it("rejects users with no matching ownership or membership", () => {
    expect(
      canUserDestructivelyEditJobWithoutAuthContext({
        createdByMatchesUser: false,
        isInternalAdmin: false,
        canEditDirectProject: false,
        canEditProjectViaJoinTable: false,
      }),
    ).toBe(false);
  });
});
