import { describe, expect, it } from "vitest";
import type { User } from "@supabase/supabase-js";
import type { AppMembership } from "@/features/quotes/types";
import { deriveRootAccessState } from "./root-access-state";

const user = { id: "user-1" } as User;

function membership(role: AppMembership["role"]): AppMembership {
  return {
    id: `membership-${role}`,
    role,
    organizationId: "org-1",
    organizationName: "Example Org",
    organizationSlug: "example-org",
  };
}

describe("deriveRootAccessState", () => {
  it("keeps shell selection neutral while access restoration is incomplete", () => {
    expect(
      deriveRootAccessState({
        user,
        activeMembership: null,
        isAuthInitializing: true,
      }),
    ).toEqual({ status: "restoring" });
  });

  it.each(["internal_admin", "internal_estimator"] as const)(
    "selects the internal experience for %s memberships",
    (role) => {
      expect(
        deriveRootAccessState({
          user,
          activeMembership: membership(role),
          isAuthInitializing: false,
        }),
      ).toEqual({ status: "internal" });
    },
  );

  it("selects the client destination only after client membership resolves", () => {
    expect(
      deriveRootAccessState({
        user,
        activeMembership: membership("client"),
        isAuthInitializing: false,
      }),
    ).toEqual({ status: "client" });
  });

  it("checks capability access for a resolved user without a membership", () => {
    expect(
      deriveRootAccessState({
        user,
        activeMembership: null,
        isAuthInitializing: false,
      }),
    ).toEqual({ status: "capability_check" });
  });

  it("selects the public experience only after anonymous restoration resolves", () => {
    expect(
      deriveRootAccessState({
        user: null,
        activeMembership: null,
        isAuthInitializing: false,
      }),
    ).toEqual({ status: "anonymous" });
  });
});
