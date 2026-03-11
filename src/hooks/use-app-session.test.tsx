import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAuthStorageKey, useAppSession } from "@/hooks/use-app-session";
import type { AppSessionData } from "@/features/quotes/types";

const fetchAppSessionDataMock = vi.fn<() => Promise<AppSessionData>>();
const onAuthStateChangeMock = vi.fn();
const adminSignOutMock = vi.fn();

vi.mock("@/features/quotes/api", () => ({
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
    onAuthStateChangeMock.mockReturnValue({
      data: {
        subscription: {
          unsubscribe: vi.fn(),
        },
      },
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

  it("does not clear a stored token while a valid signed-in session is still resolving", async () => {
    const tokenKey = getSupabaseAuthStorageKey();
    storageMock.setItem(tokenKey, JSON.stringify({ access_token: "token-1" }));
    const deferred = deferredPromise<AppSessionData>();
    fetchAppSessionDataMock.mockReturnValueOnce(deferred.promise);

    renderProbe();

    expect(storageMock.getItem(tokenKey)).toContain("token-1");

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
      expect(screen.getByTestId("email")).toHaveTextContent("client@example.com");
    });

    expect(storageMock.getItem(tokenKey)).toContain("token-1");
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
});
