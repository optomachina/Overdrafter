import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import type { AppMembership, AppSessionData } from "@/features/quotes/types";
import { getFixtureSessionDataForSearch } from "@/features/quotes/client-workspace-fixtures";
import { fetchAppSessionData } from "@/features/quotes/api";
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
  const fixtureSession = getFixtureSessionDataForSearch(location.search);
  const isFixtureSession = fixtureSession !== null;
  const sessionQueryKey = isFixtureSession
    ? [...APP_SESSION_QUERY_KEY, "fixture", location.pathname, location.search]
    : APP_SESSION_QUERY_KEY;

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
      if (!session) {
        pendingAuthTransitionRef.current = false;
        clearAnonymousRetryTimeout();
        queryClient.setQueryData(APP_SESSION_QUERY_KEY, EMPTY_APP_SESSION);
        return;
      }

      pendingAuthTransitionRef.current = true;
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
      scheduleSessionRefresh();
    });

    return () => {
      if (refreshTimeoutId !== null && typeof window !== "undefined") {
        window.clearTimeout(refreshTimeoutId);
      }
      clearAnonymousRetryTimeout();

      subscription.unsubscribe();
    };
  }, [isFixtureSession, queryClient]);

  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    queryFn: async () => {
      if (fixtureSession) {
        return fixtureSession;
      }

      const result = await fetchAppSessionData();
      const currentSession = queryClient.getQueryData<AppSessionData>(APP_SESSION_QUERY_KEY);

      if (result.authState === "authenticated" || result.authState === "invalid_session") {
        pendingAuthTransitionRef.current = false;
        return result;
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

      return result;
    },
    initialData: fixtureSession ?? undefined,
    staleTime: fixtureSession ? Infinity : WORKSPACE_SHARED_STALE_TIME_MS,
  });

  const memberships = sessionQuery.data?.memberships ?? EMPTY_MEMBERSHIPS;
  const activeMembership: AppMembership | null = memberships[0] ?? null;

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
    });
  }, [
    activeMembership,
    memberships,
    sessionQuery.data?.authState,
    sessionQuery.data?.isVerifiedAuth,
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
    activeOrganizationId: activeMembership?.organizationId ?? null,
    activeMembership,
    signOut,
  };
}
