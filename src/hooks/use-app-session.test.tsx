import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAuthStorageKey, useAppSession } from "@/hooks/use-app-session";
import type { AppSessionData } from "@/features/quotes/types";
import type { Session } from "@supabase/supabase-js";

const fetchAppSessionDataMock = vi.fn<() => Promise<AppSessionData>>();
const onAuthStateChangeMock = vi.fn();
const adminSignOutMock = vi.fn();
let authStateChangeCallbacks: Array<(event: string, session: Session | null) => void> = [];

vi.mock("@/features/quotes/api", () => ({
  fetchAppSessionData: () => fetchAppSessionDataMock(),
}));
vi.mock("@/features/quotes/api/session-access", () => ({
  fetchAppSessionData: () => fetchAppSessionDataMock(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (...args: unknown[]) => onAuthStateChangeMock(...args),
      admin: {
        signOut: (...args: unknown[]) => adminSignOutMock(...args),
      },
    },
  },
}));

function SessionProbe() {
  const session = useAppSession();

  return (
    <div>
      <span data-testid="email">{session.user?.email ?? "anonymous"}</span>
      <span data-testid="auth-state">{session.authState}</span>
      {session.user ? null : <button type="button">Log in</button>}
    </div>
  );
}

function renderProbe() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <SessionProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createStorageMock() {
  const values = new Map<string, string>();

  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => {
      values.clear();
    }),
  };
}

describe("useAppSession", () => {
  let storageMock: ReturnType<typeof createStorageMock>;

  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://test-project.supabase.co");
    vi.stubEnv("VITE_ENABLE_FIXTURE_MODE", "0");
    authStateChangeCallbacks = [];
    onAuthStateChangeMock.mockImplementation((callback: (event: string, session: Session | null) => void) => {
      authStateChangeCallbacks.push(callback);

      return {
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      };
    });
    storageMock = createStorageMock();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storageMock,
    });
  });

  afterEach(() => {
    cleanup();
    storageMock.clear();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("hydrates the user immediately from a signed-in auth event before the session refetch completes", async () => {
    const deferred = deferredPromise<AppSessionData>();
    fetchAppSessionDataMock
      .mockResolvedValueOnce({
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "anonymous",
      })
      .mockReturnValueOnce(deferred.promise);

    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
    });
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();

    act(() => {
      authStateChangeCallbacks.forEach((callback) =>
        callback("SIGNED_IN", {
          access_token: "token-1",
          refresh_token: "refresh-token-1",
          expires_in: 3600,
          token_type: "bearer",
          user: {
            id: "user-1",
            email: "client@example.com",
            app_metadata: {},
            user_metadata: {},
            aud: "authenticated",
            created_at: "2026-03-11T00:00:00.000Z",
          },
        } as Session),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("email")).toHaveTextContent("client@example.com");
      expect(screen.getByTestId("auth-state")).toHaveTextContent("authenticated");
    });
    expect(screen.queryByRole("button", { name: "Log in" })).not.toBeInTheDocument();

    deferred.resolve({
      user: {
        id: "user-1",
        email: "client@example.com",
      } as AppSessionData["user"],
      memberships: [],
      isVerifiedAuth: true,
      authState: "authenticated",
    });

    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(2);
    });
  });

  it("clears a stored token only when the session is explicitly invalid", async () => {
    const tokenKey = getSupabaseAuthStorageKey();
    storageMock.setItem(tokenKey, JSON.stringify({ access_token: "token-1" }));
    fetchAppSessionDataMock.mockResolvedValueOnce({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "invalid_session",
    });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId("auth-state")).toHaveTextContent("invalid_session");
    });

    await waitFor(() => {
      expect(storageMock.getItem(tokenKey)).toBeNull();
    });
  });

  it("does not clear localStorage when getUser() fails transiently (session_error) with a stored token", async () => {
    const tokenKey = getSupabaseAuthStorageKey();
    storageMock.setItem(tokenKey, JSON.stringify({ access_token: "token-1" }));
    fetchAppSessionDataMock
      .mockResolvedValueOnce({
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "session_error",
      })
      .mockResolvedValueOnce({
        user: {
          id: "user-1",
          email: "client@example.com",
        } as AppSessionData["user"],
        memberships: [
          {
            id: "membership-1",
            role: "client",
            organizationId: "org-1",
            organizationName: "Client Org",
            organizationSlug: "client-org",
          },
        ],
        isVerifiedAuth: true,
        authState: "authenticated",
      });

    renderProbe();

    // Wait for the retry to resolve
    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(2);
    });

    // localStorage must NOT have been cleared — transient errors are not permanent logouts
    expect(storageMock.getItem(tokenKey)).not.toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId("auth-state")).toHaveTextContent("authenticated");
    });
  });

  it("clears localStorage on a truly terminal invalid_session but not on session_error", async () => {
    const tokenKey = getSupabaseAuthStorageKey();
    storageMock.setItem(tokenKey, JSON.stringify({ access_token: "token-1" }));
    fetchAppSessionDataMock.mockResolvedValueOnce({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "invalid_session",
    });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId("auth-state")).toHaveTextContent("invalid_session");
    });

    await waitFor(() => {
      expect(storageMock.getItem(tokenKey)).toBeNull();
    });
  });

  it("stays authenticated with empty memberships when membership query fails, then retries", async () => {
    fetchAppSessionDataMock
      .mockResolvedValueOnce({
        user: {
          id: "user-1",
          email: "client@example.com",
        } as AppSessionData["user"],
        memberships: [],
        isVerifiedAuth: true,
        authState: "authenticated",
        membershipError: "Failed to load memberships",
      })
      .mockResolvedValueOnce({
        user: {
          id: "user-1",
          email: "client@example.com",
        } as AppSessionData["user"],
        memberships: [
          {
            id: "membership-1",
            role: "client",
            organizationId: "org-1",
            organizationName: "Client Org",
            organizationSlug: "client-org",
          },
        ],
        isVerifiedAuth: true,
        authState: "authenticated",
      });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId("email")).toHaveTextContent("client@example.com");
      expect(screen.getByTestId("auth-state")).toHaveTextContent("authenticated");
    });

    // Retry should have been scheduled
    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps the authenticated UI during one transient anonymous refetch after sign-in", async () => {
    fetchAppSessionDataMock
      .mockResolvedValueOnce({
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "anonymous",
      })
      .mockResolvedValueOnce({
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "anonymous",
      })
      .mockResolvedValueOnce({
        user: {
          id: "user-1",
          email: "client@example.com",
        } as AppSessionData["user"],
        memberships: [
          {
            id: "membership-1",
            role: "client",
            organizationId: "org-1",
            organizationName: "Client Org",
            organizationSlug: "client-org",
          },
        ],
        isVerifiedAuth: true,
        authState: "authenticated",
      });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    });

    act(() => {
      authStateChangeCallbacks.forEach((callback) =>
        callback("SIGNED_IN", {
          access_token: "token-1",
          refresh_token: "refresh-token-1",
          expires_in: 3600,
          token_type: "bearer",
          user: {
            id: "user-1",
            email: "client@example.com",
            app_metadata: {},
            user_metadata: {},
            aud: "authenticated",
            created_at: "2026-03-11T00:00:00.000Z",
          },
        } as Session),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("email")).toHaveTextContent("client@example.com");
      expect(screen.queryByRole("button", { name: "Log in" })).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(3);
    });

    expect(screen.getByTestId("email")).toHaveTextContent("client@example.com");
    expect(screen.getByTestId("auth-state")).toHaveTextContent("authenticated");
  });
});
