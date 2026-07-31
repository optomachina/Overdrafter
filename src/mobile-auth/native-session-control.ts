import { fetchAppSessionData } from "@/features/quotes/api/session-access";
import { removeStoredSupabaseSession } from "@/features/quotes/api/shared/startup-auth";
import type { AppSessionData } from "@/features/quotes/types";
import { supabase } from "@/integrations/supabase/client";

export type NativeSessionStatus =
  | {
      version: 1;
      status: "authenticated" | "signed_out";
    }
  | {
      version: 1;
      status: "error";
      code:
        | "mobile_auth_network_failed"
        | "mobile_auth_session_invalid"
        | "mobile_auth_logout_failed";
    };

type NativeSessionAction = "probe" | "logout";

type NativeSessionAuthClient = {
  auth: {
    signOut(options: { scope: "local" }): Promise<{
      error: unknown;
    }>;
  };
};

type NativeSessionDependencies = {
  client?: NativeSessionAuthClient;
  readAppSession?: () => Promise<AppSessionData>;
  clearPersistedSession?: () => void;
  reportStatus?: (status: NativeSessionStatus) => boolean | void;
};

type MobileAuthMessageHandler = {
  postMessage(message: NativeSessionStatus): void;
};

type WebKitWindow = Window & {
  webkit?: {
    messageHandlers?: {
      mobileAuth?: MobileAuthMessageHandler;
    };
  };
};

/**
 * Detects the fixed bridge installed by the native shell. Unlike `?app=ios`,
 * this remains true when client-side navigation drops query parameters.
 */
export function hasNativeMobileAuthHandler(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const webKitWindow = window as WebKitWindow;
  return Boolean(webKitWindow.webkit?.messageHandlers?.mobileAuth);
}

/**
 * Sends a credential-free native session result through the fixed iOS bridge.
 */
export function reportNativeSessionStatus(status: NativeSessionStatus): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const webKitWindow = window as WebKitWindow;
  const handler = webKitWindow.webkit?.messageHandlers?.mobileAuth;
  if (!handler) {
    return false;
  }

  try {
    handler.postMessage(status);
    return true;
  } catch {
    return false;
  }
}

function networkErrorStatus(): NativeSessionStatus {
  return {
    version: 1,
    status: "error",
    code: "mobile_auth_network_failed",
  };
}

/**
 * Probes or clears the browser-owned Supabase session without exposing session
 * credentials to native code.
 */
export async function runNativeSessionAction(
  action: NativeSessionAction,
  dependencies: NativeSessionDependencies = {},
): Promise<NativeSessionStatus> {
  const client = dependencies.client ?? (supabase as unknown as NativeSessionAuthClient);
  const readAppSession = dependencies.readAppSession ?? fetchAppSessionData;
  const clearPersistedSession =
    dependencies.clearPersistedSession ?? removeStoredSupabaseSession;
  const reportStatus = dependencies.reportStatus ?? reportNativeSessionStatus;

  let status: NativeSessionStatus;

  if (action === "logout") {
    let logoutFailed = false;

    try {
      const result = await client.auth.signOut({ scope: "local" });
      logoutFailed = Boolean(result.error);
    } catch {
      logoutFailed = true;
    } finally {
      clearPersistedSession();
    }

    status = logoutFailed
      ? {
          version: 1,
          status: "error",
          code: "mobile_auth_logout_failed",
        }
      : {
          version: 1,
          status: "signed_out",
        };
  } else {
    try {
      const auth = await readAppSession();

      if (
        auth.authState === "authenticated"
        && auth.isVerifiedAuth
        && !auth.membershipError
      ) {
        status = {
          version: 1,
          status: "authenticated",
        };
      } else if (auth.authState === "anonymous" || auth.authState === "invalid_session") {
        clearPersistedSession();
        status = {
          version: 1,
          status: "signed_out",
        };
      } else {
        status = networkErrorStatus();
      }
    } catch {
      status = networkErrorStatus();
    }
  }

  reportStatus(status);
  return status;
}
