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

    if (
      (isAuthError(userError) && authErrorName === "AuthSessionMissingError") ||
      authErrorName === "AuthSessionMissingError" ||
      isDeletedAuthUserError(userError) ||
      isInvalidRefreshTokenError(userError)
    ) {
      return {
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState:
          isDeletedAuthUserError(userError) || isInvalidRefreshTokenError(userError)
            ? "invalid_session"
            : "anonymous",
      };
    }

    throw userError;
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

  const { data, error } = (await membershipQuery) as PostgrestResponse<MembershipJoinRow>;

  if (error) {
    throw error;
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
