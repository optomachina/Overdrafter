import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { isAuthSessionMissingError, type Session } from "@supabase/supabase-js";
import type { AppMembership, AppSessionData } from "@/features/quotes/types";
import { getFixtureSessionDataForSearch } from "@/features/quotes/client-workspace-fixtures";
import { fetchAppSessionData } from "@/features/quotes/api/session-access";
import {
  getStoredSupabaseAccessToken,
  readStartupSupabaseBootstrap,
  removeStoredSupabaseSession,
} from "@/features/quotes/api/shared/startup-auth";
import { WORKSPACE_SHARED_STALE_TIME_MS } from "@/features/quotes/workspace-navigation";
import { supabase } from "@/integrations/supabase/client";
import { hasVerifiedAuth } from "@/lib/auth-status";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";

const APP_SESSION_QUERY_KEY = ["app-session"] as const;
const EMPTY_MEMBERSHIPS: AppMembership[] = [];
const EMPTY_APP_SESSION: AppSessionData = {
  user: null,
  memberships: [],
  isVerifiedAuth: false,
  authState: "anonymous",
};

export { getSupabaseAuthStorageKey } from "@/features/quotes/api/shared/startup-auth";

type InitialAuthCheckState = "checking" | "none" | "present";

export function useAppSession() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const pendingAuthTransitionRef = useRef(false);
  const retryTimeoutRef = useRef<number | null>(null);
  const initialAuthCheckRef = useRef<InitialAuthCheckState>("checking");
  const hasResolvedInitialRestoreRef = useRef(false);
  const terminalAuthStateRef = useRef<"invalid_session" | null>(null);
  const sessionErrorRetriedRef = useRef(false);
  const membershipErrorRetriedRef = useRef(false);
  const fixtureSession = getFixtureSessionDataForSearch(location.search);
  const isFixtureSession = fixtureSession !== null;
  const startupHadStoredTokenRef = useRef(Boolean(fixtureSession ? false : getStoredSupabaseAccessToken()));
  const [initialAuthCheck, setInitialAuthCheck] = useState<InitialAuthCheckState>(
    fixtureSession ? "none" : "checking",
  );
  const [hasResolvedInitialRestore, setHasResolvedInitialRestore] = useState(Boolean(fixtureSession));
  const sessionQueryKey = isFixtureSession
    ? [...APP_SESSION_QUERY_KEY, "fixture", location.pathname, location.search]
    : APP_SESSION_QUERY_KEY;

  const updateInitialAuthCheck = useCallback((next: InitialAuthCheckState) => {
    initialAuthCheckRef.current = next;
    setInitialAuthCheck(next);
  }, []);

  const markInitialRestoreResolved = useCallback((source: string, details?: Record<string, unknown>) => {
    if (hasResolvedInitialRestoreRef.current) {
      return;
    }

    hasResolvedInitialRestoreRef.current = true;
    setHasResolvedInitialRestore(true);
    recordWorkspaceSessionDiagnostic(
      "info",
      source,
      "Finished initial startup auth restoration.",
      {
        ...details,
        initialAuthCheck: initialAuthCheckRef.current,
      },
    );
  }, []);

  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  const scheduleSessionRefresh = useCallback(() => {
    // Supabase fires auth callbacks while holding an internal lock.
    // Deferring the refetch avoids re-entering auth APIs during sign-in/out.
    if (typeof window === "undefined") {
      void queryClient.invalidateQueries({ queryKey: APP_SESSION_QUERY_KEY });
      return;
    }

    if (retryTimeoutRef.current !== null) {
      return;
    }

    retryTimeoutRef.current = window.setTimeout(() => {
      retryTimeoutRef.current = null;
      void queryClient.invalidateQueries({ queryKey: APP_SESSION_QUERY_KEY });
    }, 0);
  }, [queryClient]);

  const seedSessionFromSupabaseSession = useCallback(
    (session: Session, source: string) => {
      queryClient.setQueryData<AppSessionData>(APP_SESSION_QUERY_KEY, (current) => ({
        user: session.user,
        memberships: current?.user?.id === session.user.id ? current.memberships : EMPTY_MEMBERSHIPS,
        isVerifiedAuth: hasVerifiedAuth(session.user),
        authState: "authenticated",
        membershipError: current?.user?.id === session.user.id ? current.membershipError : undefined,
      }));
      recordWorkspaceSessionDiagnostic(
        "info",
        source,
        "Seeded app-session cache from a Supabase auth session.",
        {
          userId: session.user.id,
          email: session.user.email ?? null,
        },
      );
      sessionErrorRetriedRef.current = false;
      membershipErrorRetriedRef.current = false;
    },
    [queryClient],
  );

  useEffect(() => {
    if (isFixtureSession) {
      updateInitialAuthCheck("none");
      hasResolvedInitialRestoreRef.current = true;
      setHasResolvedInitialRestore(true);
      return;
    }

    let cancelled = false;

    recordWorkspaceSessionDiagnostic(
      "info",
      "use-app-session.initial-check.start",
      "Checking browser-persisted Supabase session on app boot.",
      {
        hasStoredAccessToken: startupHadStoredTokenRef.current,
      },
    );

    void readStartupSupabaseBootstrap()
      .then((bootstrap) => {
        if (cancelled) {
          return;
        }

        if (bootstrap.authState === "invalid_session") {
          pendingAuthTransitionRef.current = false;
          updateInitialAuthCheck("none");
          markInitialRestoreResolved("use-app-session.initial-check.invalid-session", {
            hadStoredAccessToken: bootstrap.hadStoredAccessToken,
          });
          return;
        }

        if (!bootstrap.session) {
          pendingAuthTransitionRef.current = false;
          updateInitialAuthCheck("none");
          markInitialRestoreResolved("use-app-session.initial-check.no-session", {
            authState: bootstrap.authState,
            hadStoredAccessToken: bootstrap.hadStoredAccessToken,
          });
          return;
        }

        if (
          terminalAuthStateRef.current === "invalid_session" ||
          (bootstrap.hadStoredAccessToken && !getStoredSupabaseAccessToken())
        ) {
          pendingAuthTransitionRef.current = false;
          updateInitialAuthCheck("none");
          markInitialRestoreResolved("use-app-session.initial-check.discarded-terminal-session", {
            authState: terminalAuthStateRef.current ?? bootstrap.authState,
            hadStoredAccessToken: bootstrap.hadStoredAccessToken,
          });
          return;
        }

        pendingAuthTransitionRef.current = true;
        updateInitialAuthCheck("present");
        seedSessionFromSupabaseSession(
          bootstrap.session,
          bootstrap.authState === "session_error"
            ? "use-app-session.initial-check.seed-session-error"
            : "use-app-session.initial-check.seed",
        );
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        pendingAuthTransitionRef.current = false;
        updateInitialAuthCheck("none");
        markInitialRestoreResolved("use-app-session.initial-check.unexpected-error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [isFixtureSession, markInitialRestoreResolved, seedSessionFromSupabaseSession, updateInitialAuthCheck]);

  useEffect(() => {
    if (isFixtureSession) {
      return;
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      recordWorkspaceSessionDiagnostic(
        session ? "info" : "warn",
        "use-app-session.auth-state-change",
        "Received Supabase auth state change event.",
        {
          event,
          hasSession: Boolean(session),
          userId: session?.user.id ?? null,
          initialAuthCheck: initialAuthCheckRef.current,
          hasResolvedInitialRestore: hasResolvedInitialRestoreRef.current,
        },
      );

      if (!session) {
        if (!pendingAuthTransitionRef.current && initialAuthCheckRef.current !== "checking") {
          sessionErrorRetriedRef.current = false;
          membershipErrorRetriedRef.current = false;
          updateInitialAuthCheck("none");
          markInitialRestoreResolved("use-app-session.auth-state-change.signed-out");
          clearRetryTimeout();
          queryClient.setQueryData(APP_SESSION_QUERY_KEY, EMPTY_APP_SESSION);
          return;
        }

        recordWorkspaceSessionDiagnostic(
          "info",
          "use-app-session.auth-state-change.null-session-deferred",
          "Deferred clearing auth state for a null auth event while startup restoration is still in progress.",
          {
            initialAuthCheck: initialAuthCheckRef.current,
            pendingAuthTransition: pendingAuthTransitionRef.current,
          },
        );
        return;
      }

      pendingAuthTransitionRef.current = true;
      terminalAuthStateRef.current = null;
      updateInitialAuthCheck("present");
      seedSessionFromSupabaseSession(session, "use-app-session.auth-state-change.seed");
      scheduleSessionRefresh();
    });

    return () => {
      clearRetryTimeout();
      subscription.unsubscribe();
    };
  }, [
    clearRetryTimeout,
    isFixtureSession,
    markInitialRestoreResolved,
    queryClient,
    scheduleSessionRefresh,
    seedSessionFromSupabaseSession,
    updateInitialAuthCheck,
  ]);

  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    queryFn: async () => {
      if (fixtureSession) {
        return fixtureSession;
      }

      const result = await fetchAppSessionData();
      const currentSession = queryClient.getQueryData<AppSessionData>(APP_SESSION_QUERY_KEY);

      recordWorkspaceSessionDiagnostic(
        result.authState === "invalid_session" ? "warn" : "info",
        "use-app-session.query.result",
        "Resolved network-backed app-session fetch.",
        {
          authState: result.authState ?? "anonymous",
          userId: result.user?.id ?? null,
          membershipCount: result.memberships.length,
          membershipError: result.membershipError ?? null,
          initialAuthCheck: initialAuthCheckRef.current,
        },
      );

      if (result.authState === "authenticated") {
        if (result.membershipError) {
          if (!membershipErrorRetriedRef.current) {
            membershipErrorRetriedRef.current = true;
            scheduleSessionRefresh();
          }
          return result;
        }

        membershipErrorRetriedRef.current = false;
        sessionErrorRetriedRef.current = false;
        terminalAuthStateRef.current = null;
        pendingAuthTransitionRef.current = false;
        markInitialRestoreResolved("use-app-session.query.authenticated", {
          userId: result.user?.id ?? null,
          membershipCount: result.memberships.length,
        });
        return result;
      }

      if (result.authState === "invalid_session") {
        terminalAuthStateRef.current = "invalid_session";
        sessionErrorRetriedRef.current = false;
        membershipErrorRetriedRef.current = false;
        pendingAuthTransitionRef.current = false;
        updateInitialAuthCheck("none");
        markInitialRestoreResolved("use-app-session.query.invalid-session");
        return result;
      }

      if (result.authState === "session_error") {
        if (!sessionErrorRetriedRef.current) {
          sessionErrorRetriedRef.current = true;
          scheduleSessionRefresh();
        }
        return currentSession ?? result;
      }

      if (
        result.authState === "anonymous" &&
        pendingAuthTransitionRef.current &&
        currentSession?.authState === "authenticated" &&
        currentSession.user
      ) {
        pendingAuthTransitionRef.current = false;
        scheduleSessionRefresh();
        return currentSession;
      }

      pendingAuthTransitionRef.current = false;
      terminalAuthStateRef.current = null;
      sessionErrorRetriedRef.current = false;
      membershipErrorRetriedRef.current = false;
      updateInitialAuthCheck("none");
      markInitialRestoreResolved("use-app-session.query.anonymous");
      return result;
    },
    initialData: fixtureSession ?? undefined,
    staleTime: fixtureSession ? Infinity : WORKSPACE_SHARED_STALE_TIME_MS,
  });

  const memberships = sessionQuery.data?.memberships ?? EMPTY_MEMBERSHIPS;
  const activeMembership: AppMembership | null = memberships[0] ?? null;
  const isAuthInitializing =
    !hasResolvedInitialRestore &&
    (initialAuthCheck === "present" || (initialAuthCheck === "checking" && startupHadStoredTokenRef.current));

  useEffect(() => {
    if (sessionQuery.isLoading) {
      return;
    }

    recordWorkspaceSessionDiagnostic("info", "use-app-session.derived-state", "Derived app-session hook state.", {
      authState: sessionQuery.data?.authState ?? "anonymous",
      isVerifiedAuth: sessionQuery.data?.isVerifiedAuth ?? false,
      userId: sessionQuery.data?.user?.id ?? null,
      membershipCount: memberships.length,
      memberships: memberships.map((membership) => ({
        organizationId: membership.organizationId,
        role: membership.role,
      })),
      hasActiveMembership: Boolean(activeMembership),
      isAuthInitializing,
      membershipError: sessionQuery.data?.membershipError ?? null,
    });
  }, [
    activeMembership,
    isAuthInitializing,
    memberships,
    sessionQuery.data?.authState,
    sessionQuery.data?.isVerifiedAuth,
    sessionQuery.data?.membershipError,
    sessionQuery.data?.user?.id,
    sessionQuery.isLoading,
  ]);

  useEffect(() => {
    if (isFixtureSession || sessionQuery.isLoading || sessionQuery.data?.authState !== "invalid_session") {
      return;
    }

    if (!getStoredSupabaseAccessToken()) {
      return;
    }

    recordWorkspaceSessionDiagnostic(
      "warn",
      "use-app-session.invalid-session-clear",
      "Clearing local Supabase session storage after terminal invalid_session classification.",
    );
    removeStoredSupabaseSession();
    queryClient.setQueryData(APP_SESSION_QUERY_KEY, EMPTY_APP_SESSION);
  }, [isFixtureSession, queryClient, sessionQuery.data?.authState, sessionQuery.isLoading]);

  const signOut = async () => {
    if (isFixtureSession) {
      queryClient.setQueryData(sessionQueryKey, EMPTY_APP_SESSION);
      return;
    }

    void queryClient.cancelQueries({ queryKey: APP_SESSION_QUERY_KEY });
    const accessToken = getStoredSupabaseAccessToken();

    recordWorkspaceSessionDiagnostic(
      "info",
      "use-app-session.sign-out",
      "Signing out the current user and clearing local Supabase session storage.",
      {
        hasAccessToken: Boolean(accessToken),
      },
    );

    clearRetryTimeout();
    terminalAuthStateRef.current = null;
    sessionErrorRetriedRef.current = false;
    membershipErrorRetriedRef.current = false;
    updateInitialAuthCheck("none");
    hasResolvedInitialRestoreRef.current = true;
    setHasResolvedInitialRestore(true);
    removeStoredSupabaseSession();
    queryClient.setQueryData(APP_SESSION_QUERY_KEY, EMPTY_APP_SESSION);

    const { error } = await supabase.auth.signOut({ scope: "global" });

    if (!error) {
      return;
    }

    if (isAuthSessionMissingError(error)) {
      recordWorkspaceSessionDiagnostic(
        "info",
        "use-app-session.sign-out.missing-session",
        "Supabase signOut reported no remaining browser session after optimistic logout.",
      );
      removeStoredSupabaseSession();
      queryClient.setQueryData(APP_SESSION_QUERY_KEY, EMPTY_APP_SESSION);
      return;
    }

    recordWorkspaceSessionDiagnostic(
      "warn",
      "use-app-session.sign-out.failed",
      "Supabase signOut failed after optimistic logout.",
      {
        error: String(error),
        hasAccessToken: Boolean(accessToken),
      },
    );
  };

  return {
    ...sessionQuery,
    user: sessionQuery.data?.user ?? null,
    memberships,
    isVerifiedAuth: sessionQuery.data?.isVerifiedAuth ?? false,
    authState: sessionQuery.data?.authState ?? "anonymous",
    membershipError: sessionQuery.data?.membershipError ?? null,
    isAuthInitializing,
    hasResolvedInitialAuth: hasResolvedInitialRestore,
    initialAuthCheck,
    activeOrganizationId: activeMembership?.organizationId ?? null,
    activeMembership,
    signOut,
  };
}
