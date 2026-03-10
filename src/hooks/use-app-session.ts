import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import type { AppMembership, AppSessionData } from "@/features/quotes/types";
import { getFixtureSessionDataForSearch } from "@/features/quotes/client-workspace-fixtures";
import { fetchAppSessionData } from "@/features/quotes/api";
import { WORKSPACE_SHARED_STALE_TIME_MS } from "@/features/quotes/workspace-navigation";
import { supabase } from "@/integrations/supabase/client";
import { hasVerifiedAuth } from "@/lib/auth-status";

const APP_SESSION_QUERY_KEY = ["app-session"] as const;
const EMPTY_MEMBERSHIPS: AppMembership[] = [];
const EMPTY_APP_SESSION: AppSessionData = {
  user: null,
  memberships: [],
  isVerifiedAuth: false,
};
const SUPABASE_AUTH_STORAGE_KEY = (() => {
  try {
    const authUrl = new URL(import.meta.env.VITE_SUPABASE_URL);
    return `sb-${authUrl.hostname.split(".")[0]}-auth-token`;
  } catch {
    return "supabase.auth.token";
  }
})();

type SupabaseAuthSessionStorage = {
  access_token?: string;
};

function getStoredAccessToken(): string | null {
  try {
    const rawSession = window.localStorage.getItem(SUPABASE_AUTH_STORAGE_KEY);

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
    window.localStorage.removeItem(SUPABASE_AUTH_STORAGE_KEY);
    window.localStorage.removeItem(`${SUPABASE_AUTH_STORAGE_KEY}-code-verifier`);
    window.localStorage.removeItem(`${SUPABASE_AUTH_STORAGE_KEY}-user`);
  } catch {
    // Ignore storage removal failures in unsupported or private contexts.
  }
}

export function useAppSession() {
  const location = useLocation();
  const queryClient = useQueryClient();
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
        queryClient.setQueryData(APP_SESSION_QUERY_KEY, EMPTY_APP_SESSION);
        return;
      }

      // Avoid priming an incomplete user+membership snapshot on startup.
      // Let fetchAppSessionData hydrate both values together for INITIAL_SESSION.
      if (event === "INITIAL_SESSION") {
        scheduleSessionRefresh();
        return;
      }

      const currentSession = queryClient.getQueryData<AppSessionData>(APP_SESSION_QUERY_KEY);
      if (!currentSession || currentSession.user?.id !== session.user.id) {
        scheduleSessionRefresh();
        return;
      }

      queryClient.setQueryData<AppSessionData>(APP_SESSION_QUERY_KEY, (current) => ({
        user: session.user,
        memberships: current?.memberships ?? EMPTY_MEMBERSHIPS,
        isVerifiedAuth: hasVerifiedAuth(session.user),
      }));
      scheduleSessionRefresh();
    });

    return () => {
      if (refreshTimeoutId !== null && typeof window !== "undefined") {
        window.clearTimeout(refreshTimeoutId);
      }

      subscription.unsubscribe();
    };
  }, [isFixtureSession, queryClient]);

  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    queryFn: () => (fixtureSession ? Promise.resolve(fixtureSession) : fetchAppSessionData()),
    initialData: fixtureSession ?? undefined,
    staleTime: fixtureSession ? Infinity : WORKSPACE_SHARED_STALE_TIME_MS,
  });

  const memberships = sessionQuery.data?.memberships ?? EMPTY_MEMBERSHIPS;

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

  const activeMembership: AppMembership | null = memberships[0] ?? null;

  return {
    ...sessionQuery,
    user: sessionQuery.data?.user ?? null,
    memberships,
    isVerifiedAuth: sessionQuery.data?.isVerifiedAuth ?? false,
    activeOrganizationId: activeMembership?.organizationId ?? null,
    activeMembership,
    signOut,
  };
}
