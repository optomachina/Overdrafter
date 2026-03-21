import { isAuthError, type Session, type User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";
import { isDeletedAuthUserError, isInvalidRefreshTokenError } from "./schema-errors";

/**
 * Hard timeout, in milliseconds, for browser-side Supabase auth reads used by
 * the startup restore path and by live auth snapshots.
 *
 * Timed-out reads are classified as:
 * - `anonymous` when no persisted browser access token exists
 * - `session_error` when a persisted browser access token exists
 */
export const STARTUP_AUTH_TIMEOUT_MS = 5_000;

type SupabaseAuthSessionStorage = {
  access_token?: string;
};

type TimeoutClassification = "anonymous" | "session_error";

type TimedResult<T> =
  | {
      timedOut: false;
      value: T;
    }
  | {
      timedOut: true;
    };

function isResolvedTimedResult<T>(
  result: TimedResult<T>,
): result is {
  timedOut: false;
  value: T;
} {
  return result.timedOut === false;
}

/**
 * Result of reading the persisted Supabase session from the browser.
 *
 * `resolved` means `supabase.auth.getSession()` returned before
 * {@link STARTUP_AUTH_TIMEOUT_MS}. `timed_out` means the read exceeded the
 * deadline and was classified from local storage state.
 */
type StartupSessionReadResult =
  | {
      status: "resolved";
      session: Session | null;
      sessionError: unknown | null;
      hadStoredAccessToken: boolean;
    }
  | {
      status: "timed_out";
      authState: TimeoutClassification;
      hadStoredAccessToken: boolean;
    };

/**
 * Result of resolving the authenticated Supabase user from the current browser
 * session. Timeout classification matches {@link STARTUP_AUTH_TIMEOUT_MS}.
 */
type StartupUserReadResult =
  | {
      status: "resolved";
      user: User | null;
      userError: unknown | null;
      hadStoredAccessToken: boolean;
    }
  | {
      status: "timed_out";
      authState: "session_error";
      hadStoredAccessToken: boolean;
    };

/**
 * Normalized auth snapshot consumed by startup restoration and session-fetch
 * code.
 *
 * Shapes:
 * - `authenticated`: includes both `session` and `user`
 * - `session_error`: includes `session` but no verified `user`
 * - `anonymous` / `invalid_session`: both return `session: null` and `user: null`
 */
type StartupAuthBootstrapResult =
  | {
      authState: "anonymous";
      hadStoredAccessToken: boolean;
      session: null;
      user: null;
    }
  | {
      authState: "invalid_session";
      hadStoredAccessToken: boolean;
      session: null;
      user: null;
    }
  | {
      authState: "session_error";
      hadStoredAccessToken: boolean;
      session: Session | null;
      user: null;
    }
  | {
      authState: "authenticated";
      hadStoredAccessToken: boolean;
      session: Session;
      user: User;
    };

let startupSessionReadPromise: Promise<StartupSessionReadResult> | null = null;
let startupUserReadPromise: Promise<StartupUserReadResult> | null = null;
let startupAuthBootstrapPromise: Promise<StartupAuthBootstrapResult> | null = null;

/**
 * Returns the localStorage key used by the Supabase browser client to persist
 * auth state for the configured project. Falls back to `supabase.auth.token`
 * when `VITE_SUPABASE_URL` is unavailable or malformed.
 */
export function getSupabaseAuthStorageKey() {
  try {
    const authUrl = new URL(import.meta.env.VITE_SUPABASE_URL);
    return `sb-${authUrl.hostname.split(".")[0]}-auth-token`;
  } catch {
    return "supabase.auth.token";
  }
}

/**
 * Reads the persisted Supabase access token from browser localStorage.
 *
 * Returns `null` when the token is absent, malformed, or inaccessible.
 */
export function getStoredSupabaseAccessToken(): string | null {
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

/**
 * Removes the Supabase session payload and related helper keys from browser
 * localStorage.
 *
 * Side effects:
 * - removes `${getSupabaseAuthStorageKey()}`
 * - removes `${getSupabaseAuthStorageKey()}-code-verifier`
 * - removes `${getSupabaseAuthStorageKey()}-user`
 */
export function removeStoredSupabaseSession() {
  try {
    const storageKey = getSupabaseAuthStorageKey();
    window.localStorage.removeItem(storageKey);
    window.localStorage.removeItem(`${storageKey}-code-verifier`);
    window.localStorage.removeItem(`${storageKey}-user`);
  } catch {
    // Ignore storage removal failures in unsupported or private contexts.
  }
}

function classifyTimeout(hadStoredAccessToken: boolean): TimeoutClassification {
  return hadStoredAccessToken ? "session_error" : "anonymous";
}

function withStartupTimeout<T>(promise: Promise<T>): Promise<TimedResult<T>> {
  return new Promise<TimedResult<T>>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      resolve({ timedOut: true });
    }, STARTUP_AUTH_TIMEOUT_MS);

    void promise
      .then((value) => {
        globalThis.clearTimeout(timeoutId);
        resolve({
          timedOut: false,
          value,
        });
      })
      .catch((error: unknown) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      });
  });
}

async function readSupabaseSessionSnapshot(options: {
  memoize: boolean;
}): Promise<StartupSessionReadResult> {
  if (options.memoize && startupSessionReadPromise) {
    return startupSessionReadPromise;
  }

  const readPromise: Promise<StartupSessionReadResult> = (async (): Promise<StartupSessionReadResult> => {
    const hadStoredAccessToken = Boolean(getStoredSupabaseAccessToken());
    const result = await withStartupTimeout(supabase.auth.getSession());

    if (!isResolvedTimedResult(result)) {
      const authState = classifyTimeout(hadStoredAccessToken);
      recordWorkspaceSessionDiagnostic(
        "warn",
        "startup-auth.get-session.timeout",
        "Timed out while reading the browser-persisted Supabase session during startup.",
        {
          timeoutMs: STARTUP_AUTH_TIMEOUT_MS,
          hadStoredAccessToken,
          authState,
        },
      );
      return {
        status: "timed_out",
        authState,
        hadStoredAccessToken,
      };
    }

    const {
      data: { session },
      error,
    } = result.value;

    if (error) {
      recordWorkspaceSessionDiagnostic(
        "warn",
        "startup-auth.get-session.error",
        "Supabase getSession() failed during auth snapshot resolution.",
        {
          error: error.message,
          hadStoredAccessToken,
          memoized: options.memoize,
        },
      );
    }

    return {
      status: "resolved",
      session,
      sessionError: error ?? null,
      hadStoredAccessToken,
    };
  })();

  if (options.memoize) {
    startupSessionReadPromise = readPromise;
  }

  return readPromise;
}

async function readSupabaseUserSnapshot(
  hadStoredAccessToken: boolean,
  options: {
    memoize: boolean;
  },
): Promise<StartupUserReadResult> {
  if (options.memoize && startupUserReadPromise) {
    return startupUserReadPromise;
  }

  const readPromise: Promise<StartupUserReadResult> = (async (): Promise<StartupUserReadResult> => {
    const result = await withStartupTimeout(supabase.auth.getUser());

    if (!isResolvedTimedResult(result)) {
      const authState: TimeoutClassification = "session_error";
      recordWorkspaceSessionDiagnostic(
        "warn",
        "startup-auth.get-user.timeout",
        "Timed out while verifying the Supabase user during auth snapshot resolution.",
        {
          timeoutMs: STARTUP_AUTH_TIMEOUT_MS,
          hadStoredAccessToken,
          authState,
        },
      );
      return {
        status: "timed_out",
        authState,
        hadStoredAccessToken,
      };
    }

    const {
      data: { user },
      error,
    } = result.value;

    if (error) {
      recordWorkspaceSessionDiagnostic(
        "warn",
        "startup-auth.get-user.error",
        "Supabase getUser() failed during auth snapshot resolution.",
        {
          error: error.message,
          hadStoredAccessToken,
          memoized: options.memoize,
        },
      );
    }

    return {
      status: "resolved",
      user,
      userError: error,
      hadStoredAccessToken,
    };
  })();

  if (options.memoize) {
    startupUserReadPromise = readPromise;
  }

  return readPromise;
}

async function readSupabaseBootstrap(options: {
  memoize: boolean;
}): Promise<StartupAuthBootstrapResult> {
  if (options.memoize && startupAuthBootstrapPromise) {
    return startupAuthBootstrapPromise;
  }

  const bootstrapPromise: Promise<StartupAuthBootstrapResult> = (async (): Promise<StartupAuthBootstrapResult> => {
    const sessionRead = await readSupabaseSessionSnapshot({ memoize: options.memoize });

    if (sessionRead.status === "timed_out") {
      return {
        authState: sessionRead.authState,
        hadStoredAccessToken: sessionRead.hadStoredAccessToken,
        session: null,
        user: null,
      };
    }

    if (!sessionRead.session) {
      if (
        sessionRead.sessionError &&
        (isDeletedAuthUserError(sessionRead.sessionError) || isInvalidRefreshTokenError(sessionRead.sessionError))
      ) {
        return {
          authState: "invalid_session",
          hadStoredAccessToken: sessionRead.hadStoredAccessToken,
          session: null,
          user: null,
        };
      }

      if (sessionRead.sessionError && sessionRead.hadStoredAccessToken) {
        return {
          authState: "session_error",
          hadStoredAccessToken: sessionRead.hadStoredAccessToken,
          session: null,
          user: null,
        };
      }

      return {
        authState: "anonymous",
        hadStoredAccessToken: sessionRead.hadStoredAccessToken,
        session: null,
        user: null,
      };
    }

    const userRead = await readSupabaseUserSnapshot(sessionRead.hadStoredAccessToken, {
      memoize: options.memoize,
    });

    if (userRead.status === "timed_out") {
      return {
        authState: userRead.authState,
        hadStoredAccessToken: userRead.hadStoredAccessToken,
        session: sessionRead.session,
        user: null,
      };
    }

    const userError = userRead.userError;

    if (userError) {
      const authErrorName =
        typeof (userError as { name?: unknown })?.name === "string"
          ? (userError as { name: string }).name
          : userError instanceof Error
            ? userError.name
            : "";

      const isTerminalError = isDeletedAuthUserError(userError) || isInvalidRefreshTokenError(userError);
      const isSessionMissingError =
        (isAuthError(userError) && authErrorName === "AuthSessionMissingError") ||
        authErrorName === "AuthSessionMissingError";

      if (isTerminalError) {
        return {
          authState: "invalid_session",
          hadStoredAccessToken: sessionRead.hadStoredAccessToken,
          session: null,
          user: null,
        };
      }

      if (isSessionMissingError || isAuthError(userError)) {
        return {
          authState: "session_error",
          hadStoredAccessToken: sessionRead.hadStoredAccessToken,
          session: sessionRead.session,
          user: null,
        };
      }

      return {
        authState: "session_error",
        hadStoredAccessToken: sessionRead.hadStoredAccessToken,
        session: sessionRead.session,
        user: null,
      };
    }

    if (!userRead.user) {
      return {
        authState: "anonymous",
        hadStoredAccessToken: sessionRead.hadStoredAccessToken,
        session: null,
        user: null,
      };
    }

    return {
      authState: "authenticated",
      hadStoredAccessToken: sessionRead.hadStoredAccessToken,
      session: sessionRead.session,
      user: userRead.user,
    };
  })();

  if (options.memoize) {
    startupAuthBootstrapPromise = bootstrapPromise;
  }

  return bootstrapPromise;
}

/**
 * Returns the memoized one-time startup auth snapshot used while the app decides
 * whether to restore a workspace or show the anonymous landing page.
 *
 * This function intentionally reuses the first successful or timed-out bootstrap
 * promise until the page reloads or {@link resetStartupAuthBootstrapForTests} is
 * called.
 */
export async function readStartupSupabaseBootstrap(): Promise<StartupAuthBootstrapResult> {
  return readSupabaseBootstrap({ memoize: true });
}

/**
 * Returns a live, uncached auth snapshot for steady-state session fetches after
 * the initial restore has completed.
 *
 * Expected caller: `fetchAppSessionData()`, where sign-in and sign-out refetches
 * must observe current browser auth state instead of the memoized startup
 * result.
 */
export async function readLiveSupabaseBootstrap(): Promise<StartupAuthBootstrapResult> {
  return readSupabaseBootstrap({ memoize: false });
}

/**
 * Clears the memoized startup auth promises so tests can exercise multiple
 * startup scenarios in one process.
 */
export function resetStartupAuthBootstrapForTests() {
  startupSessionReadPromise = null;
  startupUserReadPromise = null;
  startupAuthBootstrapPromise = null;
}
