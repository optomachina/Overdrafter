import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseAuthStorageKey, useAppSession } from "@/hooks/use-app-session";
import { requireCurrentUser, resetCurrentUserReadForTests } from "@/features/quotes/api/shared/auth";
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
  // Per-call latency overrides for getUser(), consumed in order.
  userDelays: [] as number[],
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
  const latency = (call === "getUser" ? auth.userDelays.shift() : undefined) ?? LATENCY_MS;
  return new Promise<T>((resolve) => {
    const respond = () => setTimeout(() => resolve(value), latency);
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

function makeAccessToken(sub: string): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
}

function makeSession(): Session {
  return {
    access_token: makeAccessToken("user-1"),
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

// Workspace reads on /parts start once a user is seeded; each one calls the
// real requireCurrentUser() and then makes its own REST round trip.
function useWorkspaceRead(key: string, userId: string | undefined) {
  return useQuery({
    queryKey: ["workspace", key, userId],
    queryFn: async () => {
      const user = await requireCurrentUser();
      await restRequest(`rest:${key}`, []);
      return user.id;
    },
    enabled: Boolean(userId),
  });
}

function WorkspaceReads() {
  const { user } = useAppSession();
  const reads = [
    useWorkspaceRead("projects", user?.id),
    useWorkspaceRead("archived-projects", user?.id),
    useWorkspaceRead("sidebar-pins", user?.id),
  ];
  return <span data-testid="workspace-loaded">{reads.filter((read) => read.data === user?.id && read.isSuccess).length}</span>;
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
    auth.userDelays = [];
    auth.log = [];
    auth.session = makeSession();
    resetCurrentUserReadForTests();
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

  it("loads the workspace on the restore's verified user instead of one serialised getUser() per query", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(renderApp(queryClient));

    let loadedAt: number | null = null;
    for (let at = 100; at <= 20_000 && loadedAt === null; at += 100) {
      await advance(100);
      if (screen.getByTestId("workspace-loaded").textContent === "3") loadedAt = at;
    }

    // The restore's one getUser() verified this token; workspace queries reuse
    // it instead of each holding the auth lock for its own 2 s round trip.
    expect(countCalls("getUser")).toBe(1);
    expect(loadedAt).not.toBeNull();
    expect(loadedAt!).toBeLessThanOrEqual(4_500);
    expect(screen.getByTestId("page-memberships")).toHaveTextContent("1");
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

  it("adopts a timed-out restore that lands late instead of reseeding the splash from queued INITIAL_SESSION replays", async () => {
    // The first /auth/v1/user hangs until 5.2 s; every later round trip takes 2 s.
    auth.userDelays = [5_200];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(renderApp(queryClient));

    await advance(STARTUP_AUTH_TIMEOUT_MS + 100);
    expect(screen.getByTestId("page-initializing")).toHaveTextContent("no");
    expect(screen.getByTestId("page-auth-state")).toHaveTextContent("session_error");

    // The getUser() lands at 5.2 s and releases the queued INITIAL_SESSION
    // replays. They carry the session that restore already read, so the splash
    // stays down for every observer while the late restore completes.
    const reopened: number[] = [];
    let restoredAt: number | null = null;
    for (let at = STARTUP_AUTH_TIMEOUT_MS + 200; at <= 15_000; at += 100) {
      await advance(100);
      for (const probe of screen.queryAllByTestId(/-initializing$/)) {
        if (probe.textContent === "yes") reopened.push(at);
      }
      if (restoredAt === null && screen.getByTestId("page-memberships").textContent === "1") restoredAt = at;
    }
    expect(reopened).toEqual([]);
    // 5.2 s user read, then one 2 s round trip for the membership read.
    expect(restoredAt).not.toBeNull();
    expect(restoredAt!).toBeLessThanOrEqual(7_500);

    // No Retry: the restore that was still pending at the deadline is adopted.
    for (const name of ["page", "chrome"]) {
      expect(screen.getByTestId(`${name}-auth-state`)).toHaveTextContent("authenticated");
      expect(screen.getByTestId(`${name}-memberships`)).toHaveTextContent("1");
      expect(screen.getByTestId(`${name}-email`)).toHaveTextContent("client@example.com");
    }
    // The late success is the restore; nothing queues a second one.
    expect(countCalls("rest:organization_memberships")).toBe(1);
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
