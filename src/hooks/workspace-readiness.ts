import type { User } from "@supabase/supabase-js";
import type { AppMembership } from "@/features/quotes/types";

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
  bootstrapStatus: "idle" | "pending" | "success" | "error";
  bootstrapErrorMessage: string | null;
};

/**
 * Derives the current workspace readiness state from session and bootstrap inputs.
 * Pure function with no side effects.
 */
export function deriveWorkspaceReadiness(input: WorkspaceReadinessInput): WorkspaceReadiness {
  const { user, isLoading, isVerifiedAuth, activeMembership, bootstrapStatus, bootstrapErrorMessage } = input;

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

  // No membership yet — check bootstrap state
  if (bootstrapStatus === "idle" || bootstrapStatus === "pending" || bootstrapStatus === "success") {
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
