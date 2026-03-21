import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSupabaseAuthStorageKey,
  readLiveSupabaseBootstrap,
  readStartupSupabaseBootstrap,
  resetStartupAuthBootstrapForTests,
  STARTUP_AUTH_TIMEOUT_MS,
} from "./startup-auth";

const authGetSessionMock = vi.fn();
const authGetUserMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => authGetSessionMock(...args),
      getUser: (...args: unknown[]) => authGetUserMock(...args),
    },
  },
}));

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

describe("startup auth helpers", () => {
  let storageMock: ReturnType<typeof createStorageMock>;

  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://test-project.supabase.co");
    vi.useFakeTimers();
    storageMock = createStorageMock();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storageMock,
    });
    resetStartupAuthBootstrapForTests();
    authGetSessionMock.mockReset();
    authGetUserMock.mockReset();
  });

  afterEach(() => {
    storageMock.clear();
    resetStartupAuthBootstrapForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("classifies a stored-token getSession timeout as session_error without clearing auth context", async () => {
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: "token-1" }));
    authGetSessionMock.mockReturnValue(new Promise(() => undefined));

    const readPromise = readStartupSupabaseBootstrap();
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);

    await expect(readPromise).resolves.toEqual({
      authState: "session_error",
      session: null,
      user: null,
      hadStoredAccessToken: true,
    });
  });

  it("classifies a no-token getSession timeout as anonymous", async () => {
    authGetSessionMock.mockReturnValue(new Promise(() => undefined));

    const readPromise = readStartupSupabaseBootstrap();
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);

    await expect(readPromise).resolves.toEqual({
      authState: "anonymous",
      session: null,
      user: null,
      hadStoredAccessToken: false,
    });
  });

  it("classifies a stored-token getUser timeout as session_error and preserves the resolved session", async () => {
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: "token-1" }));
    authGetSessionMock.mockResolvedValue({
      data: {
        session: {
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
            created_at: "2026-03-20T00:00:00.000Z",
          },
        },
      },
      error: null,
    });
    authGetUserMock.mockReturnValue(new Promise(() => undefined));

    const readPromise = readStartupSupabaseBootstrap();
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);

    await expect(readPromise).resolves.toMatchObject({
      authState: "session_error",
      session: expect.objectContaining({
        access_token: "token-1",
        user: expect.objectContaining({
          id: "user-1",
        }),
      }),
      user: null,
      hadStoredAccessToken: true,
    });
  });

  it("classifies a terminal getSession invalid refresh token failure as invalid_session", async () => {
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: "token-1" }));
    authGetSessionMock.mockResolvedValue({
      data: { session: null },
      error: {
        name: "AuthApiError",
        message: "Invalid Refresh Token: Refresh Token Not Found",
      },
    });

    await expect(readStartupSupabaseBootstrap()).resolves.toEqual({
      authState: "invalid_session",
      session: null,
      user: null,
      hadStoredAccessToken: true,
    });
  });

  it("classifies a terminal getSession deleted-user failure as invalid_session", async () => {
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: "token-1" }));
    authGetSessionMock.mockResolvedValue({
      data: { session: null },
      error: {
        code: "user_not_found",
        message: "User from sub claim in JWT does not exist",
        name: "AuthApiError",
      },
    });

    await expect(readStartupSupabaseBootstrap()).resolves.toEqual({
      authState: "invalid_session",
      session: null,
      user: null,
      hadStoredAccessToken: true,
    });
  });

  it("keeps invalid refresh token failures terminal", async () => {
    authGetSessionMock.mockResolvedValue({
      data: {
        session: {
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
            created_at: "2026-03-20T00:00:00.000Z",
          },
        },
      },
      error: null,
    });
    authGetUserMock.mockResolvedValue({
      data: { user: null },
      error: {
        name: "AuthApiError",
        message: "Invalid Refresh Token: Refresh Token Not Found",
      },
    });

    await expect(readStartupSupabaseBootstrap()).resolves.toEqual({
      authState: "invalid_session",
      session: null,
      user: null,
      hadStoredAccessToken: false,
    });
  });

  it("keeps deleted-user failures terminal", async () => {
    authGetSessionMock.mockResolvedValue({
      data: {
        session: {
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
            created_at: "2026-03-20T00:00:00.000Z",
          },
        },
      },
      error: null,
    });
    authGetUserMock.mockResolvedValue({
      data: { user: null },
      error: {
        code: "user_not_found",
        message: "User from sub claim in JWT does not exist",
        name: "AuthApiError",
      },
    });

    await expect(readStartupSupabaseBootstrap()).resolves.toEqual({
      authState: "invalid_session",
      session: null,
      user: null,
      hadStoredAccessToken: false,
    });
  });

  it("uses live auth reads instead of reusing the memoized startup snapshot", async () => {
    authGetSessionMock
      .mockResolvedValueOnce({
        data: { session: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          session: {
            access_token: "token-2",
            refresh_token: "refresh-token-2",
            expires_in: 3600,
            token_type: "bearer",
            user: {
              id: "user-2",
              email: "client@example.com",
              app_metadata: {},
              user_metadata: {},
              aud: "authenticated",
              created_at: "2026-03-20T00:00:00.000Z",
            },
          },
        },
        error: null,
      });
    authGetUserMock.mockResolvedValue({
      data: {
        user: {
          id: "user-2",
          email: "client@example.com",
        },
      },
      error: null,
    });

    await expect(readStartupSupabaseBootstrap()).resolves.toEqual({
      authState: "anonymous",
      hadStoredAccessToken: false,
      session: null,
      user: null,
    });

    await expect(readLiveSupabaseBootstrap()).resolves.toMatchObject({
      authState: "authenticated",
      hadStoredAccessToken: false,
      session: expect.objectContaining({
        access_token: "token-2",
      }),
      user: expect.objectContaining({
        id: "user-2",
        email: "client@example.com",
      }),
    });
  });
});
