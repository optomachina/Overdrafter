import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
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
type AnonymousFallbackState = "disabled" | "allowed" | "retrying";

function isSameUser(session: AppSessionData | null | undefined, userId: string): boolean {
  return session?.authState === "authenticated" && session.user?.id === userId;
}

function buildOptimisticSession(session: Session, candidates: Array<AppSessionData | null | undefined>): AppSessionData {
  const preserved = candidates.find((candidate) => isSameUser(candidate, session.user.id));

  return {
    user: session.user,
    memberships: preserved?.memberships ?? EMPTY_MEMBERSHIPS,
    isVerifiedAuth: hasVerifiedAuth(session.user),
    authState: "authenticated",
    membershipError: preserved?.membershipError,
  };
}

export function useAppSession() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const fixtureSession = getFixtureSessionDataForSearch(location.search);
  const isFixtureSession = fixtureSession !== null;
  const retryTimeoutRef = useRef<number | null>(null);
  const initialAuthCheckRef = useRef<InitialAuthCheckState>("checking");
  const hasResolvedInitialRestoreRef = useRef(false);
  const terminalStartupAuthStateRef = useRef<"invalid_session" | null>(null);
  const seededUserIdRef = useRef<string | null>(fixtureSession?.user?.id ?? null);
  const optimisticSessionRef = useRef<AppSessionData | null>(fixtureSession ?? null);
  const anonymousFallbackAttemptedAtRef = useRef<number | null>(null);
  const anonymousFallbackBaselineAtRef = useRef<number>(0);
  const sessionRefetchRef = useRef<(() => Promise<unknown>) | null>(null);
  const startupHadStoredTokenRef = useRef(false);
  const sessionErrorRetriedRef = useRef(false);
  const membershipErrorRetriedRef = useRef(false);
  if (!startupHadStoredTokenRef.current && !fixtureSession) {
    startupHadStoredTokenRef.current = Boolean(getStoredSupabaseAccessToken());
  }

  const [initialAuthCheck, setInitialAuthCheck] = useState<InitialAuthCheckState>(
    fixtureSession ? "none" : "checking",
  );
  const [hasResolvedInitialRestore, setHasResolvedInitialRestore] = useState(Boolean(fixtureSession));
  const [optimisticSession, setOptimisticSession] = useState<AppSessionData | null>(fixtureSession ?? null);
  const [anonymousFallbackState, setAnonymousFallbackState] = useState<AnonymousFallbackState>("disabled");

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

  const clearScheduledRetry = useCallback(() => {
    if (retryTimeoutRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  const resetRetryFlags = useCallback(() => {
    sessionErrorRetriedRef.current = false;
    membershipErrorRetriedRef.current = false;
  }, []);

  const scheduleSessionRefresh = useCallback(
    (source: string, details?: Record<string, unknown>) => {
      recordWorkspaceSessionDiagnostic(
        "info",
        source,
        "Scheduling an immediate app-session refetch.",
        details,
      );

      if (typeof window === "undefined") {
        void sessionRefetchRef.current?.();
        return;
      }

      if (retryTimeoutRef.current !== null) {
        return;
      }

      retryTimeoutRef.current = window.setTimeout(() => {
        retryTimeoutRef.current = null;
        void sessionRefetchRef.current?.();
      }, 0);
    },
    [],
  );

  const seedSessionFromSupabaseSession = useCallback(
    (session: Session, source: string) => {
      const currentSession = queryClient.getQueryData<AppSessionData>(APP_SESSION_QUERY_KEY);
      const currentQueryState = queryClient.getQueryState<AppSessionData>(APP_SESSION_QUERY_KEY);
      const seededSession = buildOptimisticSession(session, [currentSession, optimisticSessionRef.current]);
      seededUserIdRef.current = session.user.id;
      optimisticSessionRef.current = seededSession;
      setOptimisticSession(seededSession);
      setAnonymousFallbackState("allowed");
      anonymousFallbackBaselineAtRef.current = currentQueryState?.dataUpdatedAt ?? 0;
      anonymousFallbackAttemptedAtRef.current = null;
      terminalStartupAuthStateRef.current = null;
      resetRetryFlags();
      recordWorkspaceSessionDiagnostic(
        "info",
        source,
        "Seeded local app-session state from a Supabase auth session.",
        {
          userId: session.user.id,
          email: session.user.email ?? null,
          preservedMembershipCount: seededSession.memberships.length,
          preservedMembershipError: seededSession.membershipError ?? null,
        },
      );
    },
    [queryClient, resetRetryFlags],
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

        if (bootstrap.authState === "invalid_session" || bootstrap.authState === "anonymous") {
          if (seededUserIdRef.current) {
            updateInitialAuthCheck("none");
            markInitialRestoreResolved("use-app-session.initial-check.discarded-stale-anonymous", {
              authState: bootstrap.authState,
              seededUserId: seededUserIdRef.current,
            });
            return;
          }

          pendingAnonymousCleanup();
          updateInitialAuthCheck("none");
          markInitialRestoreResolved("use-app-session.initial-check.settled-anonymous", {
            authState: bootstrap.authState,
            hadStoredAccessToken: bootstrap.hadStoredAccessToken,
          });
          return;
        }

        const session = bootstrap.session;

        if (!session) {
          if (seededUserIdRef.current) {
            updateInitialAuthCheck("none");
            markInitialRestoreResolved("use-app-session.initial-check.discarded-stale-empty-session", {
              seededUserId: seededUserIdRef.current,
            });
            return;
          }

          pendingAnonymousCleanup();
          updateInitialAuthCheck("none");
          markInitialRestoreResolved("use-app-session.initial-check.no-session");
          return;
        }

        if (
          terminalStartupAuthStateRef.current === "invalid_session" ||
          (bootstrap.hadStoredAccessToken && !getStoredSupabaseAccessToken())
        ) {
          pendingAnonymousCleanup();
          updateInitialAuthCheck("none");
          markInitialRestoreResolved("use-app-session.initial-check.discarded-terminal-state", {
            authState: terminalStartupAuthStateRef.current ?? "anonymous",
            hadStoredAccessToken: bootstrap.hadStoredAccessToken,
          });
          return;
        }

        updateInitialAuthCheck("present");
        seedSessionFromSupabaseSession(
          session,
          bootstrap.authState === "session_error"
            ? "use-app-session.initial-check.seed-session-error"
            : "use-app-session.initial-check.seed",
        );
        markInitialRestoreResolved("use-app-session.initial-check.seeded-session", {
          authState: bootstrap.authState,
          userId: session.user.id,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        pendingAnonymousCleanup();
        updateInitialAuthCheck("none");
        markInitialRestoreResolved("use-app-session.initial-check.unexpected-error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    function pendingAnonymousCleanup() {
      clearScheduledRetry();
      optimisticSessionRef.current = null;
      anonymousFallbackBaselineAtRef.current = 0;
      anonymousFallbackAttemptedAtRef.current = null;
      setOptimisticSession(null);
      setAnonymousFallbackState("disabled");
      resetRetryFlags();
    }

    return () => {
      cancelled = true;
    };
  }, [
    clearScheduledRetry,
    isFixtureSession,
    markInitialRestoreResolved,
    resetRetryFlags,
    seedSessionFromSupabaseSession,
    updateInitialAuthCheck,
  ]);

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
        seededUserIdRef.current = null;
        clearScheduledRetry();
        optimisticSessionRef.current = null;
        anonymousFallbackBaselineAtRef.current = 0;
        anonymousFallbackAttemptedAtRef.current = null;
        setAnonymousFallbackState("disabled");
        setOptimisticSession(null);
        resetRetryFlags();

        if (initialAuthCheckRef.current !== "checking") {
          updateInitialAuthCheck("none");
          markInitialRestoreResolved("use-app-session.auth-state-change.signed-out");
          queryClient.setQueryData(APP_SESSION_QUERY_KEY, EMPTY_APP_SESSION);
          return;
        }

        recordWorkspaceSessionDiagnostic(
          "info",
          "use-app-session.auth-state-change.null-session-deferred",
          "Deferred clearing auth state for a null auth event while startup restoration is still in progress.",
          {
            initialAuthCheck: initialAuthCheckRef.current,
          },
        );
        return;
      }

      terminalStartupAuthStateRef.current = null;
      updateInitialAuthCheck("present");
      seedSessionFromSupabaseSession(session, "use-app-session.auth-state-change.seed");
      markInitialRestoreResolved("use-app-session.auth-state-change.seeded-session", {
        event,
        userId: session.user.id,
      });
      scheduleSessionRefresh("use-app-session.auth-state-change.refresh", {
        event,
        userId: session.user.id,
      });
    });

    return () => {
      clearScheduledRetry();
      subscription.unsubscribe();
    };
  }, [
    clearScheduledRetry,
    isFixtureSession,
    markInitialRestoreResolved,
    queryClient,
    resetRetryFlags,
    scheduleSessionRefresh,
    seedSessionFromSupabaseSession,
    updateInitialAuthCheck,
  ]);

  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    queryFn: async (): Promise<AppSessionData> => {
      if (fixtureSession) {
        return fixtureSession;
      }

      const result = await fetchAppSessionData();

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

      return result;
    },
    initialData: fixtureSession ?? undefined,
    staleTime: fixtureSession ? Infinity : WORKSPACE_SHARED_STALE_TIME_MS,
  });

  useEffect(() => {
    sessionRefetchRef.current = async () => sessionQuery.refetch();
  }, [sessionQuery]);

  useEffect(() => {
    if (isFixtureSession || sessionQuery.isLoading || !sessionQuery.data) {
      return;
    }

    const querySession = sessionQuery.data;

    if (querySession.authState === "authenticated") {
      terminalStartupAuthStateRef.current = null;
      seededUserIdRef.current = querySession.user?.id ?? null;
      updateInitialAuthCheck("none");
      markInitialRestoreResolved("use-app-session.query.authenticated", {
        userId: querySession.user?.id ?? null,
        membershipCount: querySession.memberships.length,
        membershipError: querySession.membershipError ?? null,
      });

      optimisticSessionRef.current = querySession;
      setOptimisticSession(querySession);
      setAnonymousFallbackState("disabled");
      anonymousFallbackBaselineAtRef.current = 0;
      anonymousFallbackAttemptedAtRef.current = null;
      sessionErrorRetriedRef.current = false;

      if (querySession.membershipError) {
        if (!membershipErrorRetriedRef.current) {
          membershipErrorRetriedRef.current = true;
          scheduleSessionRefresh("use-app-session.query.membership-retry", {
            userId: querySession.user?.id ?? null,
            membershipError: querySession.membershipError,
          });
        }
        return;
      }

      membershipErrorRetriedRef.current = false;
      return;
    }

    updateInitialAuthCheck("none");

    if (querySession.authState === "invalid_session") {
      terminalStartupAuthStateRef.current = "invalid_session";
      seededUserIdRef.current = null;
      clearScheduledRetry();
      optimisticSessionRef.current = null;
      anonymousFallbackBaselineAtRef.current = 0;
      anonymousFallbackAttemptedAtRef.current = null;
      setOptimisticSession(null);
      setAnonymousFallbackState("disabled");
      resetRetryFlags();
      markInitialRestoreResolved("use-app-session.query.invalid-session");
      return;
    }

    if (querySession.authState === "session_error") {
      markInitialRestoreResolved("use-app-session.query.session-error");
      if (!sessionErrorRetriedRef.current) {
        sessionErrorRetriedRef.current = true;
        scheduleSessionRefresh("use-app-session.query.session-error-retry", {
          userId: optimisticSession?.user?.id ?? null,
        });
      }
      return;
    }

    markInitialRestoreResolved("use-app-session.query.anonymous");

    if (optimisticSession && anonymousFallbackState === "allowed") {
      if (sessionQuery.dataUpdatedAt <= anonymousFallbackBaselineAtRef.current) {
        return;
      }

      setAnonymousFallbackState("retrying");
      anonymousFallbackAttemptedAtRef.current = sessionQuery.dataUpdatedAt;
      scheduleSessionRefresh("use-app-session.query.anonymous-retry", {
        userId: optimisticSession?.user?.id ?? null,
      });
      return;
    }

    if (optimisticSession && anonymousFallbackState === "retrying") {
      if (anonymousFallbackAttemptedAtRef.current === sessionQuery.dataUpdatedAt) {
        return;
      }

      seededUserIdRef.current = null;
      optimisticSessionRef.current = null;
      anonymousFallbackBaselineAtRef.current = 0;
      anonymousFallbackAttemptedAtRef.current = null;
      setAnonymousFallbackState("disabled");
      setOptimisticSession(null);
      resetRetryFlags();
      return;
    }

    clearScheduledRetry();
    seededUserIdRef.current = null;
    optimisticSessionRef.current = null;
    anonymousFallbackBaselineAtRef.current = 0;
    anonymousFallbackAttemptedAtRef.current = null;
    setOptimisticSession(null);
    setAnonymousFallbackState("disabled");
    resetRetryFlags();
  }, [
    anonymousFallbackState,
    clearScheduledRetry,
    isFixtureSession,
    markInitialRestoreResolved,
    optimisticSession,
    resetRetryFlags,
    scheduleSessionRefresh,
    sessionQuery.data,
    sessionQuery.dataUpdatedAt,
    sessionQuery.isLoading,
    updateInitialAuthCheck,
  ]);

  const effectiveSession = useMemo<AppSessionData>(() => {
    if (fixtureSession) {
      return fixtureSession;
    }

    const querySession = sessionQuery.data;

    if (querySession?.authState === "authenticated") {
      return querySession;
    }

    if (querySession?.authState === "invalid_session") {
      return EMPTY_APP_SESSION;
    }

    if (querySession?.authState === "session_error" && optimisticSession) {
      return optimisticSession;
    }

    if (querySession?.authState === "anonymous" && optimisticSession && anonymousFallbackState !== "disabled") {
      return optimisticSession;
    }

    if (!querySession && optimisticSession) {
      return optimisticSession;
    }

    return querySession ?? EMPTY_APP_SESSION;
  }, [anonymousFallbackState, fixtureSession, optimisticSession, sessionQuery.data]);

  const memberships = effectiveSession.memberships ?? EMPTY_MEMBERSHIPS;
  const activeMembership: AppMembership | null = memberships[0] ?? null;
  const isAuthInitializing =
    !hasResolvedInitialRestore &&
    (initialAuthCheck === "present" || (initialAuthCheck === "checking" && startupHadStoredTokenRef.current));

  useEffect(() => {
    if (sessionQuery.isLoading) {
      return;
    }

    recordWorkspaceSessionDiagnostic("info", "use-app-session.derived-state", "Derived app-session hook state.", {
      authState: effectiveSession.authState,
      queryAuthState: sessionQuery.data?.authState ?? "anonymous",
      isVerifiedAuth: effectiveSession.isVerifiedAuth,
      userId: effectiveSession.user?.id ?? null,
      membershipCount: memberships.length,
      memberships: memberships.map((membership) => ({
        organizationId: membership.organizationId,
        role: membership.role,
      })),
      hasActiveMembership: Boolean(activeMembership),
      isAuthInitializing,
      membershipError: effectiveSession.membershipError ?? null,
    });
  }, [
    activeMembership,
    effectiveSession.authState,
    effectiveSession.isVerifiedAuth,
    effectiveSession.membershipError,
    effectiveSession.user?.id,
    isAuthInitializing,
    memberships,
    sessionQuery.data?.authState,
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

    clearScheduledRetry();
    resetRetryFlags();
    seededUserIdRef.current = null;
    optimisticSessionRef.current = null;
    anonymousFallbackBaselineAtRef.current = 0;
    anonymousFallbackAttemptedAtRef.current = null;
    setOptimisticSession(null);
    setAnonymousFallbackState("disabled");
    updateInitialAuthCheck("none");
    hasResolvedInitialRestoreRef.current = true;
    setHasResolvedInitialRestore(true);
    removeStoredSupabaseSession();
    queryClient.setQueryData(APP_SESSION_QUERY_KEY, EMPTY_APP_SESSION);

    if (accessToken) {
      void supabase.auth.admin.signOut(accessToken, "global").catch((error: unknown) => {
        console.warn("Failed to revoke remote auth session during sign out.", error);
      });
    }
  };

  return {
    ...sessionQuery,
    data: effectiveSession,
    user: effectiveSession.user,
    memberships,
    isVerifiedAuth: effectiveSession.isVerifiedAuth,
    authState: effectiveSession.authState,
    membershipError: effectiveSession.membershipError ?? null,
    isAuthInitializing,
    hasResolvedInitialAuth: hasResolvedInitialRestore,
    initialAuthCheck,
    activeOrganizationId: activeMembership?.organizationId ?? null,
    activeMembership,
    signOut,
  };
}
