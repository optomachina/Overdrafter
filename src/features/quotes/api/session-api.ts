import { supabase } from "@/integrations/supabase/client";
import { hasVerifiedAuth } from "@/lib/auth-status";
import { buildAuthRedirectUrl } from "@/lib/auth-redirect";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";
import type { AppMembership, AppSessionData } from "@/features/quotes/types";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import type { PostgrestResponse } from "@supabase/supabase-js";
import { callRpc } from "./shared/rpc";
import {
  getStartupBootstrapAgeMs,
  readLiveSupabaseBootstrap,
  readStartupSupabaseBootstrap,
} from "./shared/startup-auth";

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
    isPlatformAdmin: session.isPlatformAdmin ?? false,
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

  // Reuse the memoized startup result if it resolved recently — avoids a duplicate
  // getSession + getUser round-trip on the initial page load fetch.
  const STARTUP_REUSE_WINDOW_MS = 2_000;
  const startupAge = getStartupBootstrapAgeMs();
  const bootstrap = await (
    startupAge !== null && startupAge < STARTUP_REUSE_WINDOW_MS
      ? readStartupSupabaseBootstrap()
      : readLiveSupabaseBootstrap()
  );
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
    recordWorkspaceSessionDiagnostic(
      "warn",
      "session-api.fetch.session-error",
      "Auth bootstrap returned a transient or ambiguous session state.",
      {
        hadStoredAccessToken: bootstrap.hadStoredAccessToken,
        hasBootstrapSession: Boolean(bootstrap.session),
        bootstrapUserId: bootstrap.session?.user?.id ?? null,
      },
    );
  }

  const user = bootstrap.user ?? bootstrap.session?.user ?? null;

  if (!user) {
    const session: AppSessionData = {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "session_error",
    };
    emitSessionPayloadDiagnostic(session, "session-api.fetch.session-error");
    return session;
  }

  const membershipQuery = supabase
    .from("organization_memberships")
    .select("id, organization_id, role, organizations(id, name, slug)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const [membershipResult, platformAdminResult] = await Promise.all([
    membershipQuery as unknown as Promise<PostgrestResponse<MembershipJoinRow>>,
    callRpc("api_get_is_platform_admin", {}),
  ]);
  const { data, error } = membershipResult;
  const isPlatformAdmin = platformAdminResult.data === true;
  const platformAdminErrorMessage =
    platformAdminResult.error?.message ??
    (typeof platformAdminResult.data === "boolean" ? null : "Failed to load platform admin status.");

  if (error || platformAdminErrorMessage) {
    const memberships: AppMembership[] = (data ?? []).map((row) => ({
      id: row.id,
      role: row.role,
      organizationId: row.organization_id,
      organizationName: row.organizations?.name ?? "Unassigned organization",
      organizationSlug: row.organizations?.slug ?? "unassigned",
    }));
    const session: AppSessionData = {
      user,
      memberships: error ? [] : memberships,
      isVerifiedAuth: hasVerifiedAuth(user),
      isPlatformAdmin,
      authState: "authenticated",
      membershipError: error?.message ?? platformAdminErrorMessage ?? undefined,
    };
    emitSessionPayloadDiagnostic(
      session,
      error ? "session-api.fetch.membership-error" : "session-api.fetch.platform-admin-error",
    );
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
    isPlatformAdmin,
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
