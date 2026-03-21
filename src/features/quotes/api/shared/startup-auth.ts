import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";
import { isAuthError } from "@supabase/supabase-js";
import { isDeletedAuthUserError, isInvalidRefreshTokenError } from "./schema-errors";

export const STARTUP_AUTH_TIMEOUT_MS = 5_000;

type SupabaseAuthSessionStorage = {
  access_token?: string;
};

type TimeoutClassification = "anonymous" | "invalid_session";

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

export type StartupSessionReadResult =
  | {
      status: "resolved";
      session: Session | null;
      sessionErrorMessage: string | null;
      hadStoredAccessToken: boolean;
    }
  | {
      status: "timed_out";
      authState: TimeoutClassification;
      hadStoredAccessToken: boolean;
    };

export type StartupUserReadResult =
  | {
      status: "resolved";
      user: User | null;
      userError: unknown | null;
      hadStoredAccessToken: boolean;
    }
  | {
      status: "timed_out";
      authState: TimeoutClassification;
      hadStoredAccessToken: boolean;
    };

export type StartupAuthBootstrapResult =
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
      session: Session;
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

export function getSupabaseAuthStorageKey() {
  try {
    const authUrl = new URL(import.meta.env.VITE_SUPABASE_URL);
    return `sb-${authUrl.hostname.split(".")[0]}-auth-token`;
  } catch {
    return "supabase.auth.token";
  }
}

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
  return hadStoredAccessToken ? "invalid_session" : "anonymous";
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

export async function readStartupSupabaseSession(): Promise<StartupSessionReadResult> {
  if (startupSessionReadPromise) {
    return startupSessionReadPromise;
  }

  startupSessionReadPromise = (async () => {
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

    const resolvedResult = result.value;
    const {
      data: { session },
      error,
    } = resolvedResult;

    if (error) {
      recordWorkspaceSessionDiagnostic(
        "warn",
        "startup-auth.get-session.error",
        "Supabase getSession() failed during startup auth bootstrap.",
        {
          error: error.message,
          hadStoredAccessToken,
        },
      );
    }

    return {
      status: "resolved",
      session,
      sessionErrorMessage: error?.message ?? null,
      hadStoredAccessToken,
    };
  })();

  return startupSessionReadPromise;
}

export async function readStartupSupabaseUser(
  hadStoredAccessToken: boolean,
): Promise<StartupUserReadResult> {
  if (startupUserReadPromise) {
    return startupUserReadPromise;
  }

  startupUserReadPromise = (async () => {
    const result = await withStartupTimeout(supabase.auth.getUser());

    if (!isResolvedTimedResult(result)) {
      const authState = classifyTimeout(hadStoredAccessToken);
      recordWorkspaceSessionDiagnostic(
        "warn",
        "startup-auth.get-user.timeout",
        "Timed out while verifying the Supabase user during startup auth bootstrap.",
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

    const resolvedResult = result.value;
    const {
      data: { user },
      error,
    } = resolvedResult;

    if (error) {
      recordWorkspaceSessionDiagnostic(
        "warn",
        "startup-auth.get-user.error",
        "Supabase getUser() failed during startup auth bootstrap.",
        {
          error: error.message,
          hadStoredAccessToken,
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

  return startupUserReadPromise;
}

export async function readStartupSupabaseBootstrap(): Promise<StartupAuthBootstrapResult> {
  if (startupAuthBootstrapPromise) {
    return startupAuthBootstrapPromise;
  }

  startupAuthBootstrapPromise = (async () => {
    const sessionRead = await readStartupSupabaseSession();

    if (sessionRead.status === "timed_out") {
      return {
        authState: sessionRead.authState,
        hadStoredAccessToken: sessionRead.hadStoredAccessToken,
        session: null,
        user: null,
      };
    }

    if (!sessionRead.session) {
      return {
        authState: "anonymous",
        hadStoredAccessToken: sessionRead.hadStoredAccessToken,
        session: null,
        user: null,
      };
    }

    const userRead = await readStartupSupabaseUser(sessionRead.hadStoredAccessToken);

    if (userRead.status === "timed_out") {
      return {
        authState: userRead.authState,
        hadStoredAccessToken: userRead.hadStoredAccessToken,
        session: null,
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

  return startupAuthBootstrapPromise;
}

export function resetStartupAuthBootstrapForTests() {
  startupSessionReadPromise = null;
  startupUserReadPromise = null;
  startupAuthBootstrapPromise = null;
}
