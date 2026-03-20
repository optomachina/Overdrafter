import type { User } from "@supabase/supabase-js";
import type { AppMembership } from "@/features/quotes/types";

export const MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE =
  "We couldn't find a workspace membership for this account. Refresh once; if it still fails, contact support.";

export type MembershipResolutionStatus = "idle" | "retrying" | "exhausted";

export type WorkspaceReadiness =
  | { status: "anonymous" }
  | { status: "loading" }
  | { status: "unverified" }
  | { status: "provisioning" }
  | { status: "provisioning_failed"; error: string }
  | { status: "ready"; membership: AppMembership };

export type WorkspaceReadinessInput = {
  user: User | null;
  isLoading: boolean;
  isVerifiedAuth: boolean;
  activeMembership: AppMembership | null;
  membershipCount: number;
  bootstrapStatus: "idle" | "pending" | "success" | "error";
  bootstrapErrorMessage: string | null;
  membershipResolutionStatus: MembershipResolutionStatus;
  membershipResolutionErrorMessage: string | null;
  membershipResolutionAttempt: number;
};

/**
 * Derives the current workspace readiness state from session and bootstrap inputs.
 * Pure function with no side effects.
 */
export function deriveWorkspaceReadiness(input: WorkspaceReadinessInput): WorkspaceReadiness {
  const {
    user,
    isLoading,
    isVerifiedAuth,
    activeMembership,
    bootstrapStatus,
    bootstrapErrorMessage,
    membershipResolutionStatus,
    membershipResolutionErrorMessage,
  } = input;

  if (!user) {
    return { status: "anonymous" };
  }

  if (isLoading) {
    return { status: "loading" };
  }

  if (!isVerifiedAuth) {
    return { status: "unverified" };
  }

  if (activeMembership) {
    return { status: "ready", membership: activeMembership };
  }

  if (membershipResolutionStatus === "exhausted") {
    return {
      status: "provisioning_failed",
      error: membershipResolutionErrorMessage ?? MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
    };
  }

  // No membership yet — check bootstrap state
  if (
    membershipResolutionStatus === "retrying" ||
    bootstrapStatus === "idle" ||
    bootstrapStatus === "pending" ||
    bootstrapStatus === "success"
  ) {
    return { status: "provisioning" };
  }

  // Bootstrap error — check if it's the benign "already has org" case
  if (
    bootstrapErrorMessage &&
    bootstrapErrorMessage.toLowerCase().includes("already has an organization membership")
  ) {
    // Session refetch is in progress
    return { status: "provisioning" };
  }

  return {
    status: "provisioning_failed",
    error: bootstrapErrorMessage ?? "Failed to set up your workspace.",
  };
}
