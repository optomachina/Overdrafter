import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import type { AppMembership, AppSessionData } from "@/features/quotes/types";
import { getFixtureSessionDataForSearch } from "@/features/quotes/client-workspace-fixtures";
import { fetchAppSessionData } from "@/features/quotes/api/session-access";
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

export function getSupabaseAuthStorageKey() {
  try {
    const authUrl = new URL(import.meta.env.VITE_SUPABASE_URL);
    return `sb-${authUrl.hostname.split(".")[0]}-auth-token`;
  } catch {
    return "supabase.auth.token";
  }
}

type SupabaseAuthSessionStorage = {
  access_token?: string;
};

type InitialAuthCheckState = "checking" | "none" | "present";

function getStoredAccessToken(): string | null {
  try {
    const storageKey = getSupabaseAuthStorageKey();
    const rawSession = window.localStorage.getItem(storageKey);

    if (!rawSession) {
      return null;
    }

    const parsedSession = JSON.parse(rawSession) as SupabaseAuthSessionStorage | null;
    return typeof parsedSession?.access_token === "string" ? parsedSession.access_token : null;
  } catch {
    return null;
  }
}

function removeLocalSupabaseSession() {
  try {
    const storageKey = getSupabaseAuthStorageKey();
    window.localStorage.removeItem(storageKey);
    window.localStorage.removeItem(`${storageKey}-code-verifier`);
    window.localStorage.removeItem(`${storageKey}-user`);
  } catch {
    // Ignore storage removal failures in unsupported or private contexts.
  }
}

export function useAppSession() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const pendingAuthTransitionRef = useRef(false);
  const anonymousRetryTimeoutRef = useRef<number | null>(null);
  const initialAuthCheckRef = useRef<InitialAuthCheckState>("checking");
  const hasResolvedInitialRestoreRef = useRef(false);
  const fixtureSession = getFixtureSessionDataForSearch(location.search);
  const isFixtureSession = fixtureSession !== null;
  const startupHadStoredTokenRef = useRef(Boolean(fixtureSession ? false : getStoredAccessToken()));
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

  const seedSessionFromSupabaseSession = useCallback(
    (session: Session, source: string) => {
      const currentSession = queryClient.getQueryData<AppSessionData>(APP_SESSION_QUERY_KEY);
      queryClient.setQueryData<AppSessionData>(APP_SESSION_QUERY_KEY, (current) => ({
        user: session.user,
        memberships:
          current?.user?.id === session.user.id
            ? current.memberships
            : currentSession?.memberships ?? EMPTY_MEMBERSHIPS,
        isVerifiedAuth: hasVerifiedAuth(session.user),
        authState: "authenticated",
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

    void supabase.auth
      .getSession()
      .then(({ data: { session }, error }) => {
        if (cancelled) {
          return;
        }

        if (error) {
          pendingAuthTransitionRef.current = false;
          updateInitialAuthCheck("none");
          markInitialRestoreResolved("use-app-session.initial-check.error", {
            error: error.message,
          });
          return;
        }

        if (!session) {
          pendingAuthTransitionRef.current = false;
          updateInitialAuthCheck("none");
          markInitialRestoreResolved("use-app-session.initial-check.no-session");
          return;
        }

        pendingAuthTransitionRef.current = true;
        updateInitialAuthCheck("present");
        seedSessionFromSupabaseSession(session, "use-app-session.initial-check.seed");
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
  }, [isFixtureSession, markInitialRestoreResolved, queryClient, seedSessionFromSupabaseSession, updateInitialAuthCheck]);

  useEffect(() => {
    if (isFixtureSession) {
      return;
    }

    let refreshTimeoutId: number | null = null;

    const clearAnonymousRetryTimeout = () => {
      if (anonymousRetryTimeoutRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(anonymousRetryTimeoutRef.current);
        anonymousRetryTimeoutRef.current = null;
      }
    };

    const scheduleSessionRefresh = () => {
      // Supabase fires auth callbacks while holding an internal lock.
      // Deferring the refetch avoids re-entering auth APIs during sign-in/out.
      if (typeof window === "undefined") {
        void queryClient.invalidateQueries({ queryKey: APP_SESSION_QUERY_KEY });
        return;
      }

      if (refreshTimeoutId !== null) {
        window.clearTimeout(refreshTimeoutId);
      }

      refreshTimeoutId = window.setTimeout(() => {
        refreshTimeoutId = null;
        void queryClient.invalidateQueries({ queryKey: APP_SESSION_QUERY_KEY });
      }, 0);
    };

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
          updateInitialAuthCheck("none");
          markInitialRestoreResolved("use-app-session.auth-state-change.signed-out");
          clearAnonymousRetryTimeout();
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
      updateInitialAuthCheck("present");
      seedSessionFromSupabaseSession(session, "use-app-session.auth-state-change.seed");
      scheduleSessionRefresh();
    });

    return () => {
      if (refreshTimeoutId !== null && typeof window !== "undefined") {
        window.clearTimeout(refreshTimeoutId);
      }
      clearAnonymousRetryTimeout();

      subscription.unsubscribe();
    };
  }, [isFixtureSession, markInitialRestoreResolved, queryClient, seedSessionFromSupabaseSession, updateInitialAuthCheck]);

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
          if (typeof window === "undefined") {
            void queryClient.invalidateQueries({ queryKey: APP_SESSION_QUERY_KEY });
          } else if (anonymousRetryTimeoutRef.current === null) {
            anonymousRetryTimeoutRef.current = window.setTimeout(() => {
              anonymousRetryTimeoutRef.current = null;
              void queryClient.invalidateQueries({ queryKey: APP_SESSION_QUERY_KEY });
            }, 0);
          }

          return result;
        }

        pendingAuthTransitionRef.current = false;
        markInitialRestoreResolved("use-app-session.query.authenticated", {
          userId: result.user?.id ?? null,
          membershipCount: result.memberships.length,
        });
        return result;
      }

      if (result.authState === "invalid_session") {
        pendingAuthTransitionRef.current = false;
        updateInitialAuthCheck("none");
        markInitialRestoreResolved("use-app-session.query.invalid-session");
        return result;
      }

      if (result.authState === "session_error") {
        if (typeof window === "undefined") {
          void queryClient.invalidateQueries({ queryKey: APP_SESSION_QUERY_KEY });
        } else if (anonymousRetryTimeoutRef.current === null) {
          anonymousRetryTimeoutRef.current = window.setTimeout(() => {
            anonymousRetryTimeoutRef.current = null;
            void queryClient.invalidateQueries({ queryKey: APP_SESSION_QUERY_KEY });
          }, 0);
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

        if (typeof window === "undefined") {
          void queryClient.invalidateQueries({ queryKey: APP_SESSION_QUERY_KEY });
        } else if (anonymousRetryTimeoutRef.current === null) {
          anonymousRetryTimeoutRef.current = window.setTimeout(() => {
            anonymousRetryTimeoutRef.current = null;
            void queryClient.invalidateQueries({ queryKey: APP_SESSION_QUERY_KEY });
          }, 0);
        }

        return currentSession;
      }

      pendingAuthTransitionRef.current = false;
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

    if (!getStoredAccessToken()) {
      return;
    }

    recordWorkspaceSessionDiagnostic(
      "warn",
      "use-app-session.invalid-session-clear",
      "Clearing local Supabase session storage after terminal invalid_session classification.",
    );
    removeLocalSupabaseSession();
    queryClient.setQueryData(APP_SESSION_QUERY_KEY, EMPTY_APP_SESSION);
  }, [isFixtureSession, queryClient, sessionQuery.data?.authState, sessionQuery.isLoading]);

  const signOut = async () => {
    if (isFixtureSession) {
      queryClient.setQueryData(sessionQueryKey, EMPTY_APP_SESSION);
      return;
    }

    void queryClient.cancelQueries({ queryKey: APP_SESSION_QUERY_KEY });
    const accessToken = getStoredAccessToken();

    recordWorkspaceSessionDiagnostic(
      "info",
      "use-app-session.sign-out",
      "Signing out the current user and clearing local Supabase session storage.",
      {
        hasAccessToken: Boolean(accessToken),
      },
    );

    updateInitialAuthCheck("none");
    hasResolvedInitialRestoreRef.current = true;
    setHasResolvedInitialRestore(true);
    removeLocalSupabaseSession();
    queryClient.setQueryData(APP_SESSION_QUERY_KEY, EMPTY_APP_SESSION);

    if (accessToken) {
      void supabase.auth.admin.signOut(accessToken, "global").catch((error: unknown) => {
        console.warn("Failed to revoke remote auth session during sign out.", error);
      });
    }
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
