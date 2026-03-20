import { supabase } from "@/integrations/supabase/client";
import { hasVerifiedAuth } from "@/lib/auth-status";
import { buildAuthRedirectUrl } from "@/lib/auth-redirect";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";
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

function emitSessionPayloadDiagnostic(session: AppSessionData, source: string): void {
  recordWorkspaceSessionDiagnostic("info", source, "Fetched app-session payload.", {
    authState: session.authState ?? "anonymous",
    isVerifiedAuth: session.isVerifiedAuth,
    userId: session.user?.id ?? null,
    membershipCount: session.memberships.length,
    memberships: session.memberships.map((membership) => ({
      organizationId: membership.organizationId,
      role: membership.role,
    })),
    hasDerivedActiveMembership: session.memberships.length > 0,
  });
}

export async function fetchAppSessionData(): Promise<AppSessionData> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    const session = await fixtureGateway.getSessionData();
    emitSessionPayloadDiagnostic(session, "session-api.fetch.fixture");
    return session;
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
    const session: AppSessionData = {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
    };
    emitSessionPayloadDiagnostic(session, "session-api.fetch.no-local-session");
    return session;
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
      const session: AppSessionData = {
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "invalid_session",
      };
      emitSessionPayloadDiagnostic(session, "session-api.fetch.auth-fallback");
      return session;
    }

    if (isSessionMissingError) {
      // AuthSessionMissingError despite a local session — transient race, not a permanent logout.
      console.warn("[auth] AuthSessionMissingError with local session present — classifying as session_error (transient)");
      const session: AppSessionData = {
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "session_error",
      };
      emitSessionPayloadDiagnostic(session, "session-api.fetch.auth-fallback");
      return session;
    }

    // Other unexpected errors while a local session exists → transient failure.
    console.warn("[auth] Unexpected getUser() error with local session — classifying as session_error (transient)");
    const transientSession: AppSessionData = {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "session_error",
    };
    emitSessionPayloadDiagnostic(transientSession, "session-api.fetch.auth-fallback");
    return transientSession;
  }

  if (!user) {
    const session: AppSessionData = {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
    };
    emitSessionPayloadDiagnostic(session, "session-api.fetch.no-user");
    return session;
  }

  const membershipQuery = supabase
    .from("organization_memberships")
    .select("id, organization_id, role, organizations(id, name, slug)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const { data, error: membershipQueryError } = (await membershipQuery) as PostgrestResponse<MembershipJoinRow>;

  if (membershipQueryError) {
    // Membership query failed, but auth succeeded — return the user with empty memberships
    // and a flag so callers can retry rather than treating this as anonymous.
    console.warn("[auth] Membership query failed for authenticated user:", membershipQueryError.message);
    const session: AppSessionData = {
      user,
      memberships: [],
      isVerifiedAuth: hasVerifiedAuth(user),
      authState: "authenticated",
      membershipError: membershipQueryError.message,
    };
    emitSessionPayloadDiagnostic(session, "session-api.fetch.membership-error");
    return session;
  }

  const memberships: AppMembership[] = (data ?? []).map((row) => ({
    id: row.id,
    role: row.role,
    organizationId: row.organization_id,
    organizationName: row.organizations?.name ?? "Unassigned organization",
    organizationSlug: row.organizations?.slug ?? "unassigned",
  }));

  const session: AppSessionData = {
    user,
    memberships,
    isVerifiedAuth: hasVerifiedAuth(user),
    authState: "authenticated",
  };
  emitSessionPayloadDiagnostic(session, "session-api.fetch.authenticated");
  return session;
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
