import { describe, expect, it } from "vitest";
import type { AppMembership } from "@/features/quotes/types";
import type { WorkspaceReadinessInput } from "./workspace-readiness";
import {
  deriveWorkspaceReadiness,
  MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
} from "./workspace-readiness";

const mockUser = { id: "user-1", email: "user@example.com" } as WorkspaceReadinessInput["user"];

const mockMembership: AppMembership = {
  id: "mem-1",
  role: "client",
  organizationId: "org-1",
  organizationName: "Test Org",
  organizationSlug: "test-org",
};

function base(overrides: Partial<WorkspaceReadinessInput> = {}): WorkspaceReadinessInput {
  return {
    user: mockUser,
    isLoading: false,
    isVerifiedAuth: true,
    activeMembership: mockMembership,
    membershipCount: 1,
    bootstrapStatus: "idle",
    bootstrapErrorMessage: null,
    membershipResolutionStatus: "idle",
    membershipResolutionErrorMessage: null,
    membershipResolutionAttempt: 0,
    ...overrides,
  };
}

describe("deriveWorkspaceReadiness", () => {
  it("returns anonymous when there is no user", () => {
    expect(deriveWorkspaceReadiness(base({ user: null }))).toEqual({ status: "anonymous" });
  });

  it("returns loading when isLoading is true", () => {
    expect(deriveWorkspaceReadiness(base({ isLoading: true }))).toEqual({ status: "loading" });
  });

  it("returns unverified when user is not verified", () => {
    expect(
      deriveWorkspaceReadiness(base({ isVerifiedAuth: false, activeMembership: null, membershipCount: 0 })),
    ).toEqual({ status: "unverified" });
  });

  it("returns ready when membership exists", () => {
    expect(deriveWorkspaceReadiness(base())).toEqual({
      status: "ready",
      membership: mockMembership,
    });
  });

  it("returns provisioning when bootstrap is idle and no membership", () => {
    expect(
      deriveWorkspaceReadiness(base({ activeMembership: null, membershipCount: 0, bootstrapStatus: "idle" })),
    ).toEqual({ status: "provisioning" });
  });

  it("returns provisioning when bootstrap is pending", () => {
    expect(
      deriveWorkspaceReadiness(base({ activeMembership: null, membershipCount: 0, bootstrapStatus: "pending" })),
    ).toEqual({ status: "provisioning" });
  });

  it("returns provisioning when bootstrap is success but membership not yet propagated", () => {
    expect(
      deriveWorkspaceReadiness(base({ activeMembership: null, membershipCount: 0, bootstrapStatus: "success" })),
    ).toEqual({ status: "provisioning" });
  });

  it("returns provisioning while membership recovery is retrying after bootstrap success", () => {
    expect(
      deriveWorkspaceReadiness(
        base({
          activeMembership: null,
          membershipCount: 0,
          bootstrapStatus: "success",
          membershipResolutionStatus: "retrying",
          membershipResolutionAttempt: 2,
        }),
      ),
    ).toEqual({ status: "provisioning" });
  });

  it("returns provisioning when bootstrap error is 'already has an organization membership'", () => {
    expect(
      deriveWorkspaceReadiness(
        base({
          activeMembership: null,
          membershipCount: 0,
          bootstrapStatus: "error",
          bootstrapErrorMessage: "User already has an organization membership",
        }),
      ),
    ).toEqual({ status: "provisioning" });
  });

  it("returns provisioning_failed when membership recovery is exhausted after bootstrap success", () => {
    expect(
      deriveWorkspaceReadiness(
        base({
          activeMembership: null,
          membershipCount: 0,
          bootstrapStatus: "success",
          membershipResolutionStatus: "exhausted",
          membershipResolutionErrorMessage: MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
        }),
      ),
    ).toEqual({
      status: "provisioning_failed",
      error: MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
    });
  });

  it("returns provisioning_failed when benign bootstrap conflict exhausts membership recovery", () => {
    expect(
      deriveWorkspaceReadiness(
        base({
          activeMembership: null,
          membershipCount: 0,
          bootstrapStatus: "error",
          bootstrapErrorMessage: "User already has an organization membership",
          membershipResolutionStatus: "exhausted",
          membershipResolutionErrorMessage: MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
        }),
      ),
    ).toEqual({
      status: "provisioning_failed",
      error: MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
    });
  });

  it("returns provisioning_failed on other bootstrap errors", () => {
    expect(
      deriveWorkspaceReadiness(
        base({
          activeMembership: null,
          membershipCount: 0,
          bootstrapStatus: "error",
          bootstrapErrorMessage: "Internal server error",
        }),
      ),
    ).toEqual({ status: "provisioning_failed", error: "Internal server error" });
  });

  it("returns provisioning_failed with fallback message when error message is null", () => {
    const result = deriveWorkspaceReadiness(
      base({
        activeMembership: null,
        membershipCount: 0,
        bootstrapStatus: "error",
        bootstrapErrorMessage: null,
      }),
    );
    expect(result.status).toBe("provisioning_failed");
  });

  it("prioritises loading over unverified", () => {
    expect(
      deriveWorkspaceReadiness(base({ isLoading: true, isVerifiedAuth: false })),
    ).toEqual({ status: "loading" });
  });
});
