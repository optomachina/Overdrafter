import { describe, expect, it } from "vitest";
import {
  buildProjectAssigneeBadgeModel,
  getProjectAssigneeBubbleColor,
  getProjectAssigneeInitials,
} from "@/features/quotes/project-assignee";
import type { ProjectAssigneeProfile } from "@/features/quotes/types";

function makeProfile(overrides: Partial<ProjectAssigneeProfile> = {}): ProjectAssigneeProfile {
  return {
    userId: "user-1",
    email: "blaine.wilson@example.com",
    givenName: "Blaine",
    familyName: "Wilson",
    fullName: "Blaine Wilson",
    ...overrides,
  };
}

describe("project-assignee", () => {
  it("prefers first and last name initials when both are available", () => {
    expect(getProjectAssigneeInitials(makeProfile())).toBe("BW");
  });

  it("falls back to a single provided name when profile data is partial", () => {
    expect(
      getProjectAssigneeInitials(
        makeProfile({
          givenName: "Prince",
          familyName: null,
          fullName: null,
          email: "prince@example.com",
        }),
      ),
    ).toBe("PR");
  });

  it("derives deterministic initials from the email local part when names are missing", () => {
    expect(
      getProjectAssigneeInitials(
        makeProfile({
          givenName: null,
          familyName: null,
          fullName: null,
          email: "sam_spade@example.com",
        }),
      ),
    ).toBe("SS");
  });

  it("uses a stable color for the same user identity", () => {
    const profile = makeProfile({ userId: "user-stable" });
    expect(getProjectAssigneeBubbleColor(profile)).toBe(getProjectAssigneeBubbleColor(profile));
  });

  it("treats a missing profile as an explicit unassigned state", () => {
    expect(buildProjectAssigneeBadgeModel(null)).toEqual({
      displayName: "Unassigned",
      initials: null,
      colorClassName: null,
      isUnassigned: true,
    });
  });
});
