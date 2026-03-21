import { supabase } from "@/integrations/supabase/client";
import { hasVerifiedAuth } from "@/lib/auth-status";
import { buildAuthRedirectUrl } from "@/lib/auth-redirect";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";
import type { AppMembership, AppSessionData } from "@/features/quotes/types";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import type { PostgrestResponse } from "@supabase/supabase-js";
import { readLiveSupabaseBootstrap } from "./shared/startup-auth";

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

  const bootstrap = await readLiveSupabaseBootstrap();
  const hasLocalSession = bootstrap.session !== null;
  recordWorkspaceSessionDiagnostic(
    "info",
    "session-api.fetch.local-session-check",
    "Checked browser-persisted Supabase session before network auth fetch.",
    {
      hasLocalSession,
      userId: bootstrap.session?.user?.id ?? null,
      authState: bootstrap.authState,
    },
  );

  if (bootstrap.authState === "anonymous") {
    const session: AppSessionData = {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
    };
    emitSessionPayloadDiagnostic(session, "session-api.fetch.anonymous");
    return session;
  }

  if (bootstrap.authState === "invalid_session") {
    const session: AppSessionData = {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "invalid_session",
    };
    emitSessionPayloadDiagnostic(session, "session-api.fetch.invalid-session");
    return session;
  }

  if (bootstrap.authState === "session_error") {
    const session: AppSessionData = {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "session_error",
    };
    emitSessionPayloadDiagnostic(session, "session-api.fetch.session-error");
    return session;
  }

  const user = bootstrap.user;

  const membershipQuery = supabase
    .from("organization_memberships")
    .select("id, organization_id, role, organizations(id, name, slug)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const { data, error } = (await membershipQuery) as PostgrestResponse<MembershipJoinRow>;

  if (error) {
    const session: AppSessionData = {
      user,
      memberships: [],
      isVerifiedAuth: hasVerifiedAuth(user),
      authState: "authenticated",
      membershipError: error.message,
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
