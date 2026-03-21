import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSupabaseAuthStorageKey,
  readStartupSupabaseSession,
  readStartupSupabaseUser,
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

  it("classifies a stored-token getSession timeout as invalid_session", async () => {
    storageMock.setItem(getSupabaseAuthStorageKey(), JSON.stringify({ access_token: "token-1" }));
    authGetSessionMock.mockReturnValue(new Promise(() => undefined));

    const readPromise = readStartupSupabaseSession();
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);

    await expect(readPromise).resolves.toEqual({
      status: "timed_out",
      authState: "invalid_session",
      hadStoredAccessToken: true,
    });
  });

  it("classifies a no-token getSession timeout as anonymous", async () => {
    authGetSessionMock.mockReturnValue(new Promise(() => undefined));

    const readPromise = readStartupSupabaseSession();
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);

    await expect(readPromise).resolves.toEqual({
      status: "timed_out",
      authState: "anonymous",
      hadStoredAccessToken: false,
    });
  });

  it("classifies a stored-token getUser timeout as invalid_session", async () => {
    authGetUserMock.mockReturnValue(new Promise(() => undefined));

    const readPromise = readStartupSupabaseUser(true);
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);

    await expect(readPromise).resolves.toEqual({
      status: "timed_out",
      authState: "invalid_session",
      hadStoredAccessToken: true,
    });
  });
});
