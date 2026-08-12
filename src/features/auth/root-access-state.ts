import type { User } from "@supabase/supabase-js";
import type { AppMembership } from "@/features/quotes/types";

export type RootAccessState =
  | { status: "restoring" }
  | { status: "anonymous" }
  | { status: "client" }
  | { status: "internal" }
  | { status: "capability_check" };

type RootAccessStateInput = {
  user: User | null;
  activeMembership: AppMembership | null;
  isAuthInitializing: boolean;
};

/**
 * Resolves the root experience only after startup identity and membership
 * restoration agree on the user's access. Transient authenticated sessions
 * must not select a workspace shell before their membership is known.
 */
export function deriveRootAccessState({
  user,
  activeMembership,
  isAuthInitializing,
}: RootAccessStateInput): RootAccessState {
  if (isAuthInitializing) {
    return { status: "restoring" };
  }

  if (activeMembership?.role === "client") {
    return { status: "client" };
  }

  if (
    activeMembership?.role === "internal_admin" ||
    activeMembership?.role === "internal_estimator"
  ) {
    return { status: "internal" };
  }

  if (user) {
    return { status: "capability_check" };
  }

  return { status: "anonymous" };
}
