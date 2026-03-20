import { supabase } from "@/integrations/supabase/client";
import { hasVerifiedAuth } from "@/lib/auth-status";
import { buildAuthRedirectUrl } from "@/lib/auth-redirect";
import type { AppMembership, AppSessionData } from "@/features/quotes/types";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import { isAuthError } from "@supabase/supabase-js";
import type { PostgrestResponse } from "@supabase/supabase-js";
import { isDeletedAuthUserError, isInvalidRefreshTokenError } from "./shared/schema-errors";

type MembershipJoinRow = {
  id: string;
  organization_id: string;
  role: AppMembership["role"];
  organizations: {
    id: string;
    name: string;
    slug: string;
  } | null;
};

export async function fetchAppSessionData(): Promise<AppSessionData> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.getSessionData();
  }

  // Check for a locally-persisted session before making any network calls.
  // getSession() reads from memory/storage and does not hit the network.
  const {
    data: { session: localSession },
  } = await supabase.auth.getSession();

  const hasLocalSession = localSession !== null;
  console.warn("[auth] fetchAppSessionData: localSession present =", hasLocalSession);

  if (!hasLocalSession) {
    // No local session — skip the network call entirely.
    return {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
    };
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    const authErrorName =
      typeof (userError as { name?: unknown })?.name === "string"
        ? (userError as { name: string }).name
        : userError instanceof Error
          ? userError.name
          : "";

    console.warn("[auth] getUser() failed:", authErrorName, userError.message);

    const isTerminalError = isDeletedAuthUserError(userError) || isInvalidRefreshTokenError(userError);
    const isSessionMissingError =
      (isAuthError(userError) && authErrorName === "AuthSessionMissingError") ||
      authErrorName === "AuthSessionMissingError";

    if (isTerminalError) {
      // Truly invalid credentials — safe to treat as permanent logout.
      console.warn("[auth] Terminal auth error — classifying as invalid_session");
      return {
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "invalid_session",
      };
    }

    if (isSessionMissingError) {
      // AuthSessionMissingError despite a local session — transient race, not a permanent logout.
      console.warn("[auth] AuthSessionMissingError with local session present — classifying as session_error (transient)");
      return {
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "session_error" as AppSessionData["authState"],
      };
    }

    // Other unexpected errors while a local session exists → transient failure.
    console.warn("[auth] Unexpected getUser() error with local session — classifying as session_error (transient)");
    return {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "session_error" as AppSessionData["authState"],
    };
  }

  if (!user) {
    return {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
    };
  }

  const membershipQuery = supabase
    .from("organization_memberships")
    .select("id, organization_id, role, organizations(id, name, slug)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const { data, error: membershipError } = (await membershipQuery) as PostgrestResponse<MembershipJoinRow>;

  if (membershipError) {
    // Membership query failed, but auth succeeded — return the user with empty memberships
    // and a flag so callers can retry rather than treating this as anonymous.
    console.warn("[auth] Membership query failed for authenticated user:", membershipError.message);
    return {
      user,
      memberships: [],
      isVerifiedAuth: hasVerifiedAuth(user),
      authState: "authenticated",
      membershipError: membershipError.message,
    };
  }

  const memberships: AppMembership[] = (data ?? []).map((row) => ({
    id: row.id,
    role: row.role,
    organizationId: row.organization_id,
    organizationName: row.organizations?.name ?? "Unassigned organization",
    organizationSlug: row.organizations?.slug ?? "unassigned",
  }));

  return {
    user,
    memberships,
    isVerifiedAuth: hasVerifiedAuth(user),
    authState: "authenticated",
  };
}

export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: buildAuthRedirectUrl("/signin?mode=recovery"),
  });

  if (error) {
    throw error;
  }
}

export async function resendSignupConfirmation(email: string): Promise<void> {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: buildAuthRedirectUrl("/"),
    },
  });

  if (error) {
    throw error;
  }
}

export async function updateCurrentUserPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({
    password,
  });

  if (error) {
    throw error;
  }
}
