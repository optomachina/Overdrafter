import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseAuthStorageKey, useAppSession } from "@/hooks/use-app-session";
import { supabase } from "@/integrations/supabase/client";
import {
  resetStartupAuthBootstrapForTests,
  STARTUP_AUTH_TIMEOUT_MS,
} from "@/features/quotes/api/shared/startup-auth";

// A model of the supabase-js client the restore path really runs against
// (fetchAppSessionData and the startup bootstrap are NOT mocked):
// - every auth call runs under one serialised lock (GoTrueClient._acquireLock);
// - getUser() holds the lock for its whole network round trip;
// - every onAuthStateChange subscription replays INITIAL_SESSION under the lock;
// - each REST/RPC call reads the token through getSession() (fetchWithAuth),
//   so it queues behind the lock too, then makes its own round trip.
const LATENCY_MS = 2_000;
const auth = vi.hoisted(() => ({
  lock: Promise.resolve() as Promise<unknown>,
  network: "slow" as "slow" | "hung",
  held: [] as Array<() => void>,
  log: [] as Array<{ call: string; at: number }>,
  session: null as Session | null,
}));

function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = auth.lock.then(fn);
  auth.lock = run.then(() => undefined, () => undefined);
  return run;
}

function roundTrip<T>(call: string, value: T): Promise<T> {
  auth.log.push({ call, at: Date.now() });
  return new Promise<T>((resolve) => {
    const respond = () => setTimeout(() => resolve(value), LATENCY_MS);
    if (auth.network === "hung") auth.held.push(respond);
    else respond();
  });
}

function getSession() {
  return withLock(() => ({ data: { session: auth.session }, error: null }));
}

function restRequest(call: string, data: unknown) {
  return getSession().then(() => roundTrip(call, { data, error: null, status: 200 }));
}

vi.mock("@/integrations/supabase/client", () => {
  const builder = (table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        restRequest(`rest:${table}`, table === "organization_memberships" ? [{
          id: "membership-1",
          organization_id: "org-1",
          role: "client",
          organizations: { id: "org-1", name: "Fixture Org", slug: "fixture-org" },
        }] : []).then(onFulfilled, onRejected),
    };
    return chain;
  };
  return {
    supabase: {
      auth: {
        getSession: () => getSession(),
        // Without a session supabase-js answers locally, with no request.
        getUser: () => withLock(() => auth.session
          ? roundTrip("getUser", { data: { user: auth.session.user }, error: null })
          : { data: { user: null }, error: Object.assign(new Error("Auth session missing!"), { name: "AuthSessionMissingError" }) }),
        onAuthStateChange: (callback: (event: string, session: Session | null) => void) => {
          let active = true;
          void Promise.resolve().then(() => withLock(() => {
            if (active) callback("INITIAL_SESSION", auth.session);
          }));
          return { data: { subscription: { unsubscribe: () => { active = false; } } } };
        },
        signOut: () => withLock(() => ({ error: null })),
      },
      from: (table: string) => builder(table),
      rpc: (fn: string) => restRequest(`rpc:${fn}`, false),
    },
  };
});

function makeSession(): Session {
  return {
    access_token: "token-1",
    refresh_token: "refresh-token-1",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: {
      id: "user-1",
      email: "client@example.com",
      email_confirmed_at: "2026-03-11T00:00:00.000Z",
      app_metadata: {},
      user_metadata: {},
      aud: "authenticated",
      created_at: "2026-03-11T00:00:00.000Z",
    },
  } as Session;
}

function Probe({ name }: { name: string }) {
  const session = useAppSession();
  return (
    <div>
      <span data-testid={`${name}-initializing`}>{session.isAuthInitializing ? "yes" : "no"}</span>
      <span data-testid={`${name}-auth-state`}>{session.authState}</span>
      <span data-testid={`${name}-memberships`}>{session.memberships.length}</span>
      <span data-testid={`${name}-email`}>{session.isVerifiedAuth ? session.user?.email : "none"}</span>
      <button type="button" onClick={() => void session.refetch()}>{`${name} retry`}</button>
    </div>
  );
}

// Workspace reads on /parts start once a user is seeded; each one calls
// requireCurrentUser(), that is supabase.auth.getUser(), behind the same lock.
function useWorkspaceRead(key: string, userId: string | undefined) {
  return useQuery({ queryKey: ["workspace", key, userId], queryFn: () => supabase.auth.getUser(), enabled: Boolean(userId) });
}

function WorkspaceReads() {
  const { user } = useAppSession();
  useWorkspaceRead("projects", user?.id);
  useWorkspaceRead("archived-projects", user?.id);
  useWorkspaceRead("sidebar-pins", user?.id);
  return null;
}

// The real app mounts more observers once the seeded identity appears (shell
// chrome, account menu). Each new subscription replays INITIAL_SESSION.
function App({ showSignIn = false }: { showSignIn?: boolean }) {
  const session = useAppSession();
  return (
    <>
      <Probe name="page" />
      <WorkspaceReads />
      {session.data?.user ? <Probe name="chrome" /> : null}
      {showSignIn ? <Probe name="signin" /> : null}
    </>
  );
}

function renderApp(queryClient: QueryClient, showSignIn = false) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/parts"]}>
        <App showSignIn={showSignIn} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// Step the clock in separate act() scopes so React commits between steps, as
// the browser does; one long act() would defer every render to its end.
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(100, ms - elapsed)); });
  }
}

const countCalls = (call: string) => auth.log.filter((entry) => entry.call === call).length;

describe("useAppSession against a serialised supabase-js auth lock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_ENABLE_FIXTURE_MODE", "0");
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() { return values.size; },
        key: (index: number) => [...values.keys()][index] ?? null,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
        clear: () => values.clear(),
      },
    });
    auth.lock = Promise.resolve();
    auth.network = "slow";
    auth.held = [];
    auth.log = [];
    auth.session = makeSession();
    window.localStorage.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: auth.session.access_token }));
    resetStartupAuthBootstrapForTests();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("restores with one getUser() before the membership read when every round trip takes 2 s", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(renderApp(queryClient));

    await advance(4_500);

    for (const name of ["page", "chrome"]) {
      expect(screen.getByTestId(`${name}-initializing`)).toHaveTextContent("no");
      expect(screen.getByTestId(`${name}-auth-state`)).toHaveTextContent("authenticated");
      expect(screen.getByTestId(`${name}-memberships`)).toHaveTextContent("1");
      expect(screen.getByTestId(`${name}-email`)).toHaveTextContent("client@example.com");
    }
    const membershipRead = auth.log.findIndex((entry) => entry.call === "rest:organization_memberships");
    // One verified user read is what a restore needs. Each extra one queues a
    // further 2 s behind the lock before the membership read can start.
    expect(auth.log.slice(0, membershipRead).filter((entry) => entry.call === "getUser")).toHaveLength(1);
    expect(countCalls("rest:organization_memberships")).toBe(1);

    // Nothing restarts the restore afterwards.
    await advance(10_000);
    expect(countCalls("rest:organization_memberships")).toBe(1);
    expect(screen.getByTestId("page-auth-state")).toHaveTextContent("authenticated");
  });

  it("leaves the splash for every observer at the deadline when the restore hangs, then restores on Retry under 2 s latency", async () => {
    auth.network = "hung";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(renderApp(queryClient));

    await advance(STARTUP_AUTH_TIMEOUT_MS - 100);
    expect(screen.getByTestId("page-initializing")).toHaveTextContent("yes");
    await advance(200);
    expect(screen.getByTestId("page-initializing")).toHaveTextContent("no");
    expect(screen.getByTestId("page-auth-state")).toHaveTextContent("session_error");
    expect(screen.getByTestId("page-email")).toHaveTextContent("none");

    // Opening the Sign in panel mounts another observer; it must not reopen the splash.
    view.rerender(renderApp(queryClient, true));
    expect(screen.getByTestId("signin-initializing")).toHaveTextContent("no");
    expect(screen.getByTestId("page-initializing")).toHaveTextContent("no");

    // The network comes back slow: held requests answer after 2 s, new ones take 2 s.
    auth.network = "slow";
    auth.held.splice(0).forEach((respond) => respond());
    const before = countCalls("rest:organization_memberships");
    fireEvent.click(screen.getByRole("button", { name: "signin retry" }));
    await advance(STARTUP_AUTH_TIMEOUT_MS + 1_000);

    expect(screen.getByTestId("page-auth-state")).toHaveTextContent("authenticated");
    expect(screen.getByTestId("page-memberships")).toHaveTextContent("1");
    expect(screen.getByTestId("page-email")).toHaveTextContent("client@example.com");
    expect(countCalls("rest:organization_memberships") - before).toBeGreaterThanOrEqual(1);
  });

  it("goes straight to anonymous without a stored token or any network read", async () => {
    window.localStorage.clear();
    auth.session = null;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(renderApp(queryClient));

    await advance(10);
    expect(screen.getByTestId("page-initializing")).toHaveTextContent("no");
    expect(screen.getByTestId("page-auth-state")).toHaveTextContent("anonymous");
    expect(auth.log).toEqual([]);
  });
});
