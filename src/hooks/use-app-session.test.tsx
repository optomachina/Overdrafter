import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAuthStorageKey, useAppSession } from "@/hooks/use-app-session";
import type { AppSessionData } from "@/features/quotes/types";
import {
  resetStartupAuthBootstrapForTests,
  STARTUP_AUTH_TIMEOUT_MS,
} from "@/features/quotes/api/shared/startup-auth";
import { AuthSessionMissingError, type Session } from "@supabase/supabase-js";

const fetchAppSessionDataMock = vi.fn<() => Promise<AppSessionData>>();
const onAuthStateChangeMock = vi.fn();
const signOutMock = vi.fn();
const getSessionMock = vi.fn();
const getUserMock = vi.fn();
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
      getSession: (...args: unknown[]) => getSessionMock(...args),
      getUser: (...args: unknown[]) => getUserMock(...args),
      onAuthStateChange: (...args: unknown[]) => onAuthStateChangeMock(...args),
      signOut: (...args: unknown[]) => signOutMock(...args),
    },
  },
}));

function SessionProbe() {
  const session = useAppSession();

  return (
    <div>
      <span data-testid="email">{session.user?.email ?? "anonymous"}</span>
      <span data-testid="auth-state">{session.authState}</span>
      <span data-testid="auth-initializing">{session.isAuthInitializing ? "yes" : "no"}</span>
      <span data-testid="has-cached-session">{session.hasCachedSession ? "yes" : "no"}</span>
      <span data-testid="membership-count">{session.memberships.length}</span>
      <span data-testid="membership-error">{session.membershipError ?? "none"}</span>
      {session.user ? (
        <button type="button" onClick={() => void session.signOut()}>
          Log out
        </button>
      ) : (
        <button type="button">Log in</button>
      )}
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

  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <SessionProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return {
    ...view,
    queryClient,
  };
}

function renderProbeWithQueryClient(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/internal/jobs/job-1"]}>
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

function makeLocalSession(): Session {
  return {
    access_token: "token-1",
    refresh_token: "refresh-token-1",
    expires_in: 3600,
    token_type: "bearer",
    user: {
      id: "user-1",
      email: "estimator@example.com",
      app_metadata: {},
      user_metadata: {},
      aud: "authenticated",
      created_at: "2026-03-11T00:00:00.000Z",
    },
  };
}

function makeRestoredSession(session: Session): AppSessionData {
  return {
    user: session.user,
    memberships: [{
      id: "membership-1",
      role: "internal_estimator",
      organizationId: "org-1",
      organizationName: "Estimator Org",
      organizationSlug: "estimator-org",
    }],
    isVerifiedAuth: true,
    authState: "authenticated",
  };
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
            unsubscribe: vi.fn(() => {
              authStateChangeCallbacks = authStateChangeCallbacks.filter((entry) => entry !== callback);
            }),
          },
        },
      };
    });
    storageMock = createStorageMock();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storageMock,
    });
    resetStartupAuthBootstrapForTests();
    getSessionMock.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    signOutMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "client@example.com",
        },
      },
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    storageMock.clear();
    resetStartupAuthBootstrapForTests();
    vi.useRealTimers();
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

  it("hydrates a local Supabase session before the network app-session fetch resolves", async () => {
    const deferred = deferredPromise<AppSessionData>();
    const localSession = {
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
    } as Session;

    getSessionMock.mockResolvedValueOnce({
      data: { session: localSession },
      error: null,
    });
    fetchAppSessionDataMock.mockReturnValueOnce(deferred.promise);

    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId("email")).toHaveTextContent("client@example.com");
      expect(screen.getByTestId("auth-state")).toHaveTextContent("authenticated");
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("yes");
    });
    expect(screen.queryByRole("button", { name: "Log in" })).not.toBeInTheDocument();

    deferred.resolve({
      user: localSession.user as AppSessionData["user"],
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

    await waitFor(() => {
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
    });
  });

  it("resolves restoration for every observer of the shared session query", async () => {
    const localSession = makeLocalSession();
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: "token-1" }));
    getSessionMock.mockResolvedValue({ data: { session: localSession }, error: null });
    const deferred = deferredPromise<AppSessionData>();
    fetchAppSessionDataMock.mockReturnValueOnce(deferred.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SessionProbe />
          <SessionProbe />
          <SessionProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("email")).toHaveLength(3);
      for (const email of screen.getAllByTestId("email")) {
        expect(email).toHaveTextContent("estimator@example.com");
      }
    });
    expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(1);

    await act(async () => deferred.resolve(makeRestoredSession(localSession)));

    await waitFor(() => {
      for (const gate of screen.getAllByTestId("auth-initializing")) {
        expect(gate).toHaveTextContent("no");
      }
      for (const count of screen.getAllByTestId("membership-count")) {
        expect(count).toHaveTextContent("1");
      }
    });
  });

  it.each(["authenticated", "invalid_session", "anonymous"] as const)("does not resolve restoration from a cancelled %s fetch before memberships arrive", async (authState) => {
    const localSession = makeLocalSession();
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: "token-1" }));
    getSessionMock.mockResolvedValue({ data: { session: localSession }, error: null });
    const first = deferredPromise<AppSessionData>();
    const second = deferredPromise<AppSessionData>();
    fetchAppSessionDataMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const renders: Array<{ initializing: boolean; userId?: string; memberships: number }> = [];

    function TrackingProbe() {
      const session = useAppSession();
      renders.push({
        initializing: session.isAuthInitializing,
        userId: session.user?.id,
        memberships: session.memberships.length,
      });
      return <span>{session.isAuthInitializing ? "restoring" : `ready: ${session.memberships.length}`}</span>;
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><TrackingProbe /></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(queryClient.getQueryData<AppSessionData>(["app-session"])?.user?.id).toBe("user-1");
    });
    act(() => {
      authStateChangeCallbacks.forEach((callback) => callback("TOKEN_REFRESHED", localSession));
    });
    await waitFor(() => expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      first.resolve(authState === "authenticated" ? makeRestoredSession(localSession) : {
        user: null, memberships: [], isVerifiedAuth: false, authState,
      });
      await first.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(renders).not.toContainEqual({ initializing: false, userId: "user-1", memberships: 0 });
    expect(screen.getByText("restoring")).toBeInTheDocument();

    await act(async () => second.resolve(makeRestoredSession(localSession)));
    expect(await screen.findByText("ready: 1")).toBeInTheDocument();
    expect(renders).not.toContainEqual({ initializing: false, userId: "user-1", memberships: 0 });
  });

  it.each([false, true])("gates account B and preserves its job route after switching (sign out first: %s)", async (signOutFirst) => {
    const first = makeLocalSession();
    const second = { ...first, access_token: "token-2", user: { ...first.user, id: "user-2", email: "second@example.com" } };
    const secondResult = makeRestoredSession(second);
    secondResult.memberships[0].organizationId = "org-2";
    const pending = deferredPromise<AppSessionData>();
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: first.access_token }));
    getSessionMock.mockResolvedValue({ data: { session: first }, error: null });
    fetchAppSessionDataMock.mockResolvedValueOnce(makeRestoredSession(first)).mockReturnValueOnce(pending.promise);
    const renders: Array<{ userId: string | undefined; ready: boolean; org: string | null }> = [];
    function JobGate() {
      const session = useAppSession();
      renders.push({ userId: session.user?.id, ready: !session.isAuthInitializing, org: session.activeOrganizationId });
      if (session.isAuthInitializing) return <span>Restoring job</span>;
      if (!session.activeMembership) return <Navigate to="/" />;
      return <span>Job for {session.user?.email}</span>;
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SessionProbe />
          <Routes>
            <Route path="/" element={<Link to="/internal/jobs/job-1">Open job</Link>} />
            <Route path="/internal/jobs/:jobId" element={<JobGate />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("membership-count")).toHaveTextContent("1"));
    await waitFor(() => expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no"));
    act(() => {
      if (signOutFirst) {
        storageMock.removeItem(getSupabaseAuthStorageKey());
        authStateChangeCallbacks.forEach((callback) => callback("SIGNED_OUT", null));
      }
      storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: second.access_token }));
      authStateChangeCallbacks.forEach((callback) => callback("SIGNED_IN", second));
    });
    await waitFor(() => {
      expect(screen.getByTestId("email")).toHaveTextContent("second@example.com");
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("yes");
    });
    // A seed for B cannot inherit A's completed projection or memberships.
    expect(queryClient.getQueryData<AppSessionData>(["app-session"])).toMatchObject({ restoreComplete: false, memberships: [] });
    await waitFor(() => expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(2));
    await act(async () => pending.resolve(secondResult));
    await waitFor(() => expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no"));
    // Mount another observer after the switch: startup bootstrap still contains A.
    fireEvent.click(screen.getByRole("link", { name: "Open job" }));
    await screen.findByText("Job for second@example.com");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.getByText("Job for second@example.com")).toBeInTheDocument();
    expect(screen.getByTestId("email")).toHaveTextContent("second@example.com");
    expect(renders.every((entry) => entry.userId === "user-2" && (!entry.ready || entry.org === "org-2"))).toBe(true);
  });

  it("revalidates when bootstrap seeds a different user over a completed cached projection", async () => {
    const first = makeLocalSession();
    const second = { ...first, access_token: "token-2", user: { ...first.user, id: "user-2", email: "second@example.com" } };
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: second.access_token }));
    getSessionMock.mockResolvedValue({ data: { session: second }, error: null });
    const pending = deferredPromise<AppSessionData>();
    fetchAppSessionDataMock.mockReturnValueOnce(pending.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["app-session"], { ...makeRestoredSession(first), restoreComplete: true });
    renderProbeWithQueryClient(queryClient);
    await waitFor(() => {
      expect(screen.getByTestId("email")).toHaveTextContent("second@example.com");
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("yes");
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(1);
    });
    expect(queryClient.getQueryData<AppSessionData>(["app-session"])).toMatchObject({ restoreComplete: false, memberships: [] });
    await act(async () => pending.resolve(makeRestoredSession(second)));
    await waitFor(() => {
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
      expect(screen.getByTestId("membership-count")).toHaveTextContent("1");
    });
  });

  it("does not accept a fresh idle bootstrap seed as a completed cached projection", async () => {
    const localSession = makeLocalSession();
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: localSession.access_token }));
    getSessionMock.mockResolvedValue({ data: { session: localSession }, error: null });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["app-session"], { ...makeRestoredSession(localSession), memberships: [], restoreComplete: false });
    const pending = deferredPromise<AppSessionData>();
    fetchAppSessionDataMock.mockReturnValueOnce(pending.promise);
    renderProbeWithQueryClient(queryClient);
    await waitFor(() => expect(getSessionMock).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByTestId("auth-initializing")).toHaveTextContent("yes");
    expect(fetchAppSessionDataMock).not.toHaveBeenCalled();
    act(() => { void queryClient.invalidateQueries({ queryKey: ["app-session"] }); });
    await waitFor(() => expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(1));
    // Even a cache update cannot open this observer before the active fetch settles.
    await act(async () => {
      queryClient.setQueryData(["app-session"], { ...makeRestoredSession(localSession), restoreComplete: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("auth-initializing")).toHaveTextContent("yes");
    await act(async () => pending.resolve(makeRestoredSession(localSession)));
    await waitFor(() => expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no"));
  });

  it.each(["before bootstrap", "after seed with retries"])("resolves a thrown session fetch to sign-in %s and can recover", async (timing) => {
    const localSession = makeLocalSession();
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: localSession.access_token }));
    const bootstrap = deferredPromise<{ data: { session: Session }; error: null }>();
    getSessionMock.mockReturnValue(bootstrap.promise);
    const pending = deferredPromise<AppSessionData>();
    const error = new Error("Session RPC timed out");
    fetchAppSessionDataMock.mockImplementation(() => timing === "before bootstrap" ? Promise.reject(error) : pending.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: timing === "before bootstrap" ? false : 3, retryDelay: 1 } } });
    renderProbeWithQueryClient(queryClient);
    if (timing === "before bootstrap") {
      await waitFor(() => expect(queryClient.getQueryState(["app-session"])?.status).toBe("error"));
      await act(async () => bootstrap.resolve({ data: { session: localSession }, error: null }));
    } else {
      await act(async () => bootstrap.resolve({ data: { session: localSession }, error: null }));
      await waitFor(() => expect(screen.getByTestId("email")).toHaveTextContent(localSession.user.email!));
      await act(async () => pending.reject(error));
    }
    await waitFor(() => {
      expect(queryClient.getQueryState(["app-session"])?.status).toBe("error");
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
      expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
      expect(screen.getByTestId("membership-count")).toHaveTextContent("0");
      expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    });
    expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(timing === "before bootstrap" ? 1 : 4);
    expect(storageMock.getItem(getSupabaseAuthStorageKey())).not.toBeNull();
    fetchAppSessionDataMock.mockResolvedValue(makeRestoredSession(localSession));
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["app-session"] }); });
    await waitFor(() => {
      expect(screen.getByTestId("email")).toHaveTextContent(localSession.user.email!);
      expect(screen.getByTestId("membership-count")).toHaveTextContent("1");
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
    });
  });

  it("clears the pending transition for an observer whose shared query ran in an unmounted sibling", async () => {
    const localSession = makeLocalSession();
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: localSession.access_token }));
    getSessionMock.mockResolvedValue({ data: { session: localSession }, error: null });
    const refreshed = deferredPromise<AppSessionData>();
    fetchAppSessionDataMock.mockResolvedValueOnce(makeRestoredSession(localSession)).mockImplementation(() => refreshed.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Observers({ route }: { route: boolean }) {
      return <QueryClientProvider client={queryClient}><MemoryRouter><SessionProbe />{route && <SessionProbe />}</MemoryRouter></QueryClientProvider>;
    }
    const view = render(<Observers route />);
    await waitFor(() => screen.getAllByTestId("auth-initializing").forEach((gate) => expect(gate).toHaveTextContent("no")));
    act(() => authStateChangeCallbacks.forEach((callback) => callback("TOKEN_REFRESHED", localSession)));
    await waitFor(() => expect(fetchAppSessionDataMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => refreshed.resolve(makeRestoredSession(localSession)));
    await waitFor(() => expect(queryClient.getQueryState(["app-session"])?.fetchStatus).toBe("idle"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    view.rerender(<Observers route={false} />);
    expect(authStateChangeCallbacks).toHaveLength(1);
    act(() => {
      storageMock.removeItem(getSupabaseAuthStorageKey());
      authStateChangeCallbacks.forEach((callback) => callback("SIGNED_OUT", null));
    });
    await waitFor(() => {
      expect(screen.getByTestId("email")).toHaveTextContent("anonymous");
      expect(screen.getByTestId("membership-count")).toHaveTextContent("0");
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
    });
  });

  it("exposes auth initialization only when a restorable local session exists during startup", async () => {
    const deferred = deferredPromise<{ data: { session: Session | null }; error: null }>();
    const tokenKey = getSupabaseAuthStorageKey();
    storageMock.setItem(tokenKey, JSON.stringify({ access_token: "token-1" }));
    getSessionMock.mockReturnValueOnce(deferred.promise);
    fetchAppSessionDataMock.mockResolvedValue({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
    });

    renderProbe();

    expect(screen.getByTestId("auth-initializing")).toHaveTextContent("yes");
    // A fresh page load has an empty query cache; the persisted token alone marks a cached session,
    // while the user stays unverified (data queries are gated on it).
    expect(screen.getByTestId("has-cached-session")).toHaveTextContent("yes");
    expect(screen.getByTestId("email")).toHaveTextContent("anonymous");

    deferred.resolve({ data: { session: null }, error: null });

    await waitFor(() => {
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
    });
  });

  it("finishes restoration from a fresh cached projection after a route remount", async () => {
    const tokenKey = getSupabaseAuthStorageKey();
    const localSession = {
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
    } as Session;
    const cachedSession: AppSessionData = {
      user: localSession.user as AppSessionData["user"],
      memberships: [
        {
          id: "membership-1",
          role: "internal_admin",
          organizationId: "org-1",
          organizationName: "Client Org",
          organizationSlug: "client-org",
        },
      ],
      isVerifiedAuth: true,
      isPlatformAdmin: true,
      authState: "authenticated",
      restoreComplete: true,
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    storageMock.setItem(tokenKey, JSON.stringify({ access_token: "token-1" }));
    getSessionMock.mockResolvedValueOnce({
      data: { session: localSession },
      error: null,
    });
    queryClient.setQueryData(["app-session"], cachedSession);

    renderProbeWithQueryClient(queryClient);

    await waitFor(() => {
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
      expect(screen.getByTestId("membership-count")).toHaveTextContent("1");
    });
    expect(fetchAppSessionDataMock).not.toHaveBeenCalled();
  });

  it("keeps restoration gated while a stale cached projection revalidates", async () => {
    const deferred = deferredPromise<AppSessionData>();
    const tokenKey = getSupabaseAuthStorageKey();
    const localSession = {
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
    } as Session;
    const cachedSession: AppSessionData = {
      user: localSession.user as AppSessionData["user"],
      memberships: [
        {
          id: "membership-1",
          role: "internal_admin",
          organizationId: "org-1",
          organizationName: "Client Org",
          organizationSlug: "client-org",
        },
      ],
      isVerifiedAuth: true,
      isPlatformAdmin: true,
      authState: "authenticated",
      restoreComplete: true,
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    storageMock.setItem(tokenKey, JSON.stringify({ access_token: "token-1" }));
    getSessionMock.mockResolvedValueOnce({
      data: { session: localSession },
      error: null,
    });
    fetchAppSessionDataMock.mockReturnValueOnce(deferred.promise);
    queryClient.setQueryData(["app-session"], cachedSession, {
      updatedAt: Date.now() - 60_000,
    });

    renderProbeWithQueryClient(queryClient);

    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("yes");
    });

    deferred.resolve(cachedSession);

    await waitFor(() => {
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
      expect(screen.getByTestId("membership-count")).toHaveTextContent("1");
    });
  });

  it("does not clear local storage when a stored-token startup read times out", async () => {
    vi.useFakeTimers();
    const deferred = deferredPromise<AppSessionData>();
    const tokenKey = getSupabaseAuthStorageKey();
    storageMock.setItem(tokenKey, JSON.stringify({ access_token: "token-1" }));
    getSessionMock.mockReturnValueOnce(new Promise(() => undefined));
    fetchAppSessionDataMock.mockReturnValueOnce(deferred.promise);

    renderProbe();

    expect(screen.getByTestId("auth-initializing")).toHaveTextContent("yes");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);
    });

    expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");

    vi.useRealTimers();

    await act(async () => {
      deferred.resolve({
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "session_error",
      });
    });

    expect(storageMock.getItem(tokenKey)).not.toBeNull();
  });

  it("does not report auth initialization for a cold anonymous startup without a local session", async () => {
    fetchAppSessionDataMock.mockResolvedValue({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
    });

    renderProbe();

    expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
  });

  it("supports signing out and then signing back in from the same tab", async () => {
    fetchAppSessionDataMock
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
      expect(screen.getByTestId("auth-state")).toHaveTextContent("authenticated");
      expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => {
      expect(signOutMock).toHaveBeenCalledWith({ scope: "global" });
      expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
      expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    });

    act(() => {
      authStateChangeCallbacks.forEach((callback) =>
        callback("SIGNED_IN", {
          access_token: "token-2",
          refresh_token: "refresh-token-2",
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
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("auth-state")).toHaveTextContent("authenticated");
      expect(screen.queryByRole("button", { name: "Log in" })).not.toBeInTheDocument();
    });
  });

  it("purges subject-bound query data before publishing a different signed-in user", async () => {
    const userTwoSessionData = deferredPromise<AppSessionData>();
    fetchAppSessionDataMock
      .mockResolvedValueOnce({
        user: {
          id: "user-1",
          email: "first@example.com",
        } as AppSessionData["user"],
        memberships: [
          {
            id: "membership-1",
            role: "client",
            organizationId: "org-1",
            organizationName: "First Org",
            organizationSlug: "first-org",
          },
        ],
        isVerifiedAuth: true,
        authState: "authenticated",
      })
      .mockReturnValueOnce(userTwoSessionData.promise);

    const { queryClient } = renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId("email")).toHaveTextContent(
        "first@example.com",
      );
    });

    const userOneJobsKey = ["client-jobs", "user-one-scope"] as const;
    const userOneQuotesKey = [
      "client-quote-workspace",
      "user-one-scope",
    ] as const;
    queryClient.setQueryData(userOneJobsKey, [{ id: "job-a" }]);
    queryClient.setQueryData(userOneQuotesKey, [{ id: "quote-a" }]);

    act(() => {
      authStateChangeCallbacks.forEach((callback) =>
        callback("SIGNED_IN", {
          access_token: "token-2",
          refresh_token: "refresh-token-2",
          expires_in: 3600,
          token_type: "bearer",
          user: {
            id: "user-2",
            email: "second@example.com",
            app_metadata: {},
            user_metadata: {},
            aud: "authenticated",
            created_at: "2026-03-11T00:00:00.000Z",
          },
        } as Session),
      );
    });

    expect(queryClient.getQueryData(userOneJobsKey)).toBeUndefined();
    expect(queryClient.getQueryData(userOneQuotesKey)).toBeUndefined();
    expect(screen.getByTestId("email")).toHaveTextContent(
      "second@example.com",
    );

    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      userTwoSessionData.resolve({
        user: {
          id: "user-2",
          email: "second@example.com",
        } as AppSessionData["user"],
        memberships: [
          {
            id: "membership-2",
            role: "client",
            organizationId: "org-2",
            organizationName: "Second Org",
            organizationSlug: "second-org",
          },
        ],
        isVerifiedAuth: true,
        authState: "authenticated",
      });
    });
  });

  it("purges subject-bound query data synchronously on sign-out", async () => {
    fetchAppSessionDataMock.mockResolvedValueOnce({
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

    const { queryClient } = renderProbe();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    });

    const sensitiveKey = ["part-detail", "part-a", "user-one-scope"] as const;
    queryClient.setQueryData(sensitiveKey, { id: "part-a" });

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    expect(queryClient.getQueryData(sensitiveKey)).toBeUndefined();
    await waitFor(() => {
      expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
    });
  });

  it("treats an already-missing session during sign-out as a completed logout", async () => {
    const tokenKey = getSupabaseAuthStorageKey();
    storageMock.setItem(tokenKey, JSON.stringify({ access_token: "token-1" }));
    fetchAppSessionDataMock.mockResolvedValueOnce({
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
    signOutMock.mockResolvedValueOnce({
      error: new AuthSessionMissingError(),
    });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => {
      expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
      expect(storageMock.getItem(tokenKey)).toBeNull();
    });
  });

  it("keeps logout complete when the remote sign-out call fails", async () => {
    const tokenKey = getSupabaseAuthStorageKey();
    storageMock.setItem(tokenKey, JSON.stringify({ access_token: "token-1" }));
    fetchAppSessionDataMock.mockResolvedValueOnce({
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
    signOutMock.mockResolvedValueOnce({
      error: new Error("network down"),
    });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => {
      expect(signOutMock).toHaveBeenCalledWith({ scope: "global" });
      expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
      expect(storageMock.getItem(tokenKey)).toBeNull();
    });
  });

  it("keeps the local session visible during startup session_error retries without restoring the gate", async () => {
    const retryDeferred = deferredPromise<AppSessionData>();
    const localSession = {
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
    } as Session;

    getSessionMock.mockResolvedValueOnce({
      data: { session: localSession },
      error: null,
    });
    fetchAppSessionDataMock
      .mockResolvedValueOnce({
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "session_error",
      })
      .mockReturnValueOnce(retryDeferred.promise);
    renderProbe();

    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("email")).toHaveTextContent("client@example.com");
      expect(screen.getByTestId("auth-state")).toHaveTextContent("authenticated");
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("yes");
    });

    await act(async () => {
      retryDeferred.resolve({
        user: localSession.user as AppSessionData["user"],
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
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
    });
  });

  it("keeps the local session visible during startup membership retries without restoring the gate", async () => {
    const retryDeferred = deferredPromise<AppSessionData>();
    const localSession = {
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
    } as Session;

    getSessionMock.mockResolvedValueOnce({
      data: { session: localSession },
      error: null,
    });
    fetchAppSessionDataMock
      .mockResolvedValueOnce({
        user: localSession.user as AppSessionData["user"],
        memberships: [],
        isVerifiedAuth: true,
        authState: "authenticated",
        membershipError: "temporary membership fetch failure",
      })
      .mockReturnValueOnce(retryDeferred.promise);

    renderProbe();

    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("email")).toHaveTextContent("client@example.com");
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("yes");
    });

    await act(async () => {
      retryDeferred.resolve({
        user: localSession.user as AppSessionData["user"],
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
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
    });
  });

  it("clears a stored token only when the session is explicitly invalid", async () => {
    const tokenKey = getSupabaseAuthStorageKey();
    storageMock.setItem(tokenKey, JSON.stringify({ access_token: "token-1" }));
    const localSession = {
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
    } as Session;
    getSessionMock.mockResolvedValueOnce({
      data: { session: localSession },
      error: null,
    });
    fetchAppSessionDataMock.mockResolvedValueOnce({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "invalid_session",
    });

    renderProbe();

    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("auth-initializing")).toHaveTextContent("no");
    });

    await waitFor(() => {
      expect(storageMock.getItem(tokenKey)).toBeNull();
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
      expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
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
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(storageMock.getItem(tokenKey)).toBeNull();
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
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

  it("clears memberships and membershipError when a signed-in auth event seeds a different user", async () => {
    const deferred = deferredPromise<AppSessionData>();
    fetchAppSessionDataMock
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
        membershipError: "Failed to load memberships",
      })
      .mockReturnValueOnce(deferred.promise);

    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId("email")).toHaveTextContent("client@example.com");
      expect(screen.getByTestId("membership-count")).toHaveTextContent("1");
      expect(screen.getByTestId("membership-error")).toHaveTextContent("Failed to load memberships");
    });

    act(() => {
      authStateChangeCallbacks.forEach((callback) =>
        callback("SIGNED_IN", {
          access_token: "token-2",
          refresh_token: "refresh-token-2",
          expires_in: 3600,
          token_type: "bearer",
          user: {
            id: "user-2",
            email: "other@example.com",
            app_metadata: {},
            user_metadata: {},
            aud: "authenticated",
            created_at: "2026-03-11T00:00:00.000Z",
          },
        } as Session),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("email")).toHaveTextContent("other@example.com");
      expect(screen.getByTestId("auth-state")).toHaveTextContent("authenticated");
      expect(screen.getByTestId("membership-count")).toHaveTextContent("0");
      expect(screen.getByTestId("membership-error")).toHaveTextContent("none");
    });

    await act(async () => {
      deferred.resolve({
        user: {
          id: "user-2",
          email: "other@example.com",
        } as AppSessionData["user"],
        memberships: [],
        isVerifiedAuth: true,
        authState: "authenticated",
      });
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
