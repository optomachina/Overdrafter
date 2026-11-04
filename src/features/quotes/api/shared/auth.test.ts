import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireCurrentUser, resetCurrentUserReadForTests } from "./auth";
import {
  getSupabaseAuthStorageKey,
  readLiveSupabaseBootstrap,
  rememberVerifiedUser,
  removeStoredSupabaseSession,
  resetStartupAuthBootstrapForTests,
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

function base64Url(value: object): string {
  return btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeToken(sub: string, expiresInSeconds = 3600): string {
  return `${base64Url({ alg: "HS256", typ: "JWT" })}.${base64Url({ sub, exp: Math.floor(Date.now() / 1000) + expiresInSeconds })}.sig`;
}

function storeToken(token: string | null) {
  const key = getSupabaseAuthStorageKey();
  if (token) window.localStorage.setItem(key, JSON.stringify({ access_token: token }));
  else window.localStorage.removeItem(key);
}

const userOne = { id: "user-1", email: "one@example.com" };
const userTwo = { id: "user-2", email: "two@example.com" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("requireCurrentUser", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://test-project.supabase.co");
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
        clear: () => values.clear(),
      },
    });
    resetStartupAuthBootstrapForTests();
    resetCurrentUserReadForTests();
    authGetSessionMock.mockReset();
    authGetUserMock.mockReset();
  });

  afterEach(() => {
    resetStartupAuthBootstrapForTests();
    resetCurrentUserReadForTests();
    vi.unstubAllEnvs();
  });

  it("reuses the user the session restore verified for the stored token without another getUser()", async () => {
    const token = makeToken("user-1");
    storeToken(token);
    authGetSessionMock.mockResolvedValue({ data: { session: { access_token: token, user: userOne } }, error: null });
    authGetUserMock.mockResolvedValue({ data: { user: userOne }, error: null });

    await expect(readLiveSupabaseBootstrap()).resolves.toMatchObject({ authState: "authenticated" });
    expect(authGetUserMock).toHaveBeenCalledTimes(1);

    await expect(Promise.all([requireCurrentUser(), requireCurrentUser(), requireCurrentUser()]))
      .resolves.toEqual([userOne, userOne, userOne]);
    expect(authGetUserMock).toHaveBeenCalledTimes(1);
  });

  it("verifies over the network again after an account switch and never returns the previous account", async () => {
    const tokenOne = makeToken("user-1");
    storeToken(tokenOne);
    rememberVerifiedUser(tokenOne, userOne as never);

    storeToken(makeToken("user-2"));
    authGetUserMock.mockResolvedValue({ data: { user: userTwo }, error: null });

    await expect(requireCurrentUser()).resolves.toEqual(userTwo);
    expect(authGetUserMock).toHaveBeenCalledTimes(1);
    // The new account is now the verified one for its token.
    await expect(requireCurrentUser()).resolves.toEqual(userTwo);
    expect(authGetUserMock).toHaveBeenCalledTimes(1);
  });

  it("verifies over the network after sign-out and rejects without a user", async () => {
    const token = makeToken("user-1");
    storeToken(token);
    rememberVerifiedUser(token, userOne as never);
    await expect(requireCurrentUser()).resolves.toEqual(userOne);

    storeToken(null);
    authGetUserMock.mockResolvedValue({ data: { user: null }, error: null });
    await expect(requireCurrentUser()).rejects.toThrow("You must be signed in to continue.");
    expect(authGetUserMock).toHaveBeenCalledTimes(1);

    // Signing back in with the very same token string does not resurrect the
    // cache either: removing the stored session forgot it.
    storeToken(token);
    rememberVerifiedUser(token, userOne as never);
    removeStoredSupabaseSession();
    storeToken(token);
    authGetUserMock.mockResolvedValue({ data: { user: userOne }, error: null });
    await expect(requireCurrentUser()).resolves.toEqual(userOne);
    expect(authGetUserMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a user for an expired token, a token for another subject, or a non-stored token", async () => {
    authGetUserMock.mockResolvedValue({ data: { user: userOne }, error: null });

    const expired = makeToken("user-1", -60);
    storeToken(expired);
    rememberVerifiedUser(expired, userOne as never);
    await requireCurrentUser();
    expect(authGetUserMock).toHaveBeenCalledTimes(1);

    const otherSubject = makeToken("user-2");
    storeToken(otherSubject);
    rememberVerifiedUser(otherSubject, userOne as never);
    authGetUserMock.mockResolvedValue({ data: { user: userTwo }, error: null });
    await expect(requireCurrentUser()).resolves.toEqual(userTwo);
    expect(authGetUserMock).toHaveBeenCalledTimes(2);

    storeToken(makeToken("user-1"));
    rememberVerifiedUser(makeToken("user-1", 7200), userOne as never);
    authGetUserMock.mockResolvedValue({ data: { user: userOne }, error: null });
    await requireCurrentUser();
    expect(authGetUserMock).toHaveBeenCalledTimes(3);
  });

  it("does not remember a user returned for a token that changed while getUser() was in flight", async () => {
    const tokenOne = makeToken("user-1");
    storeToken(tokenOne);
    const pending = deferred<{ data: { user: typeof userTwo }; error: null }>();
    authGetUserMock.mockReturnValueOnce(pending.promise);

    const read = requireCurrentUser();
    storeToken(makeToken("user-2"));
    pending.resolve({ data: { user: userTwo }, error: null });
    await read;

    authGetUserMock.mockResolvedValue({ data: { user: userTwo }, error: null });
    await requireCurrentUser();
    expect(authGetUserMock).toHaveBeenCalledTimes(2);
  });

  it("shares one getUser() between concurrent callers of the same token only", async () => {
    const tokenOne = makeToken("user-1");
    storeToken(tokenOne);
    const first = deferred<{ data: { user: typeof userOne }; error: null }>();
    authGetUserMock.mockReturnValueOnce(first.promise);

    const a = requireCurrentUser();
    const b = requireCurrentUser();
    expect(authGetUserMock).toHaveBeenCalledTimes(1);

    // A caller after an account switch must not join the other account's read.
    storeToken(makeToken("user-2"));
    authGetUserMock.mockResolvedValueOnce({ data: { user: userTwo }, error: null });
    const c = requireCurrentUser();
    expect(authGetUserMock).toHaveBeenCalledTimes(2);

    first.resolve({ data: { user: userOne }, error: null });
    await expect(Promise.all([a, b, c])).resolves.toEqual([userOne, userOne, userTwo]);
  });

  it("does not share a failed read with a later caller", async () => {
    storeToken(makeToken("user-1"));
    authGetUserMock.mockResolvedValueOnce({ data: { user: null }, error: new Error("Failed to fetch") });
    await expect(requireCurrentUser()).rejects.toThrow("Failed to fetch");

    authGetUserMock.mockResolvedValueOnce({ data: { user: userOne }, error: null });
    await expect(requireCurrentUser()).resolves.toEqual(userOne);
    expect(authGetUserMock).toHaveBeenCalledTimes(2);
  });

  it("keeps verifying over the network when the browser cannot persist a token", async () => {
    authGetUserMock.mockResolvedValue({ data: { user: userOne }, error: null });
    await Promise.all([requireCurrentUser(), requireCurrentUser()]);
    expect(authGetUserMock).toHaveBeenCalledTimes(2);
  });
});
