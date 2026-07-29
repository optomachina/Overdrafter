import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export const BOOTSTRAP_CONFIG_ELEMENT_ID = "overdrafter-mobile-auth-bootstrap-config";

export type MobileAuthErrorCode =
  | "mobile_auth_cancelled"
  | "mobile_auth_invalid_request"
  | "mobile_auth_provider_failed"
  | "mobile_auth_network_failed"
  | "mobile_auth_state_mismatch"
  | "mobile_auth_expired"
  | "mobile_auth_replayed"
  | "mobile_auth_pkce_failed"
  | "mobile_auth_session_invalid"
  | "mobile_auth_bootstrap_failed"
  | "mobile_auth_logout_failed"
  | "mobile_auth_rate_limited"
  | "mobile_auth_service_unavailable";

export type BootstrapConfig =
  | {
      version: 1;
      state: string;
      returnTo: string;
      session: {
        accessToken: string;
        refreshToken: string;
      };
    }
  | {
      version: 1;
      state: string;
      error: {
        code: MobileAuthErrorCode;
        retry: MobileAuthRetryInstruction;
      };
    };

export type MobileAuthRetryInstruction = "none" | "network" | "restart" | "later";

export type BootstrapReadyStatus = {
  version: 1;
  status: "ready";
  state: string;
  returnTo: string;
};

export type BootstrapErrorStatus = {
  version: 1;
  status: "error";
  state: string;
  code: MobileAuthErrorCode;
  retry: MobileAuthRetryInstruction;
};

export type BootstrapStatus = BootstrapReadyStatus | BootstrapErrorStatus;

type BootstrapAuthClient = {
  auth: {
    setSession(credentials: {
      access_token: string;
      refresh_token: string;
    }): Promise<{
      data: {
        session: Session | null;
      };
      error: unknown | null;
    }>;
    getUser(): Promise<{
      data: {
        user: {
          id: string;
        } | null;
      };
      error: unknown | null;
    }>;
    signOut(options: { scope: "local" }): Promise<unknown>;
  };
};

export type BootstrapStatusReporter = (status: BootstrapStatus) => boolean | void;

type BootstrapDependencies = {
  document?: Document;
  client?: BootstrapAuthClient;
  reportStatus?: BootstrapStatusReporter;
  clearPersistedSession?: () => void;
  hasNativeHost?: () => boolean;
};

type MobileAuthMessageHandler = {
  postMessage(message: BootstrapStatus): void;
};

type WebKitWindow = Window & {
  webkit?: {
    messageHandlers?: {
      mobileAuth?: MobileAuthMessageHandler;
    };
  };
};

const MOBILE_AUTH_ERROR_CODES = new Set<MobileAuthErrorCode>([
  "mobile_auth_cancelled",
  "mobile_auth_invalid_request",
  "mobile_auth_provider_failed",
  "mobile_auth_network_failed",
  "mobile_auth_state_mismatch",
  "mobile_auth_expired",
  "mobile_auth_replayed",
  "mobile_auth_pkce_failed",
  "mobile_auth_session_invalid",
  "mobile_auth_bootstrap_failed",
  "mobile_auth_logout_failed",
  "mobile_auth_rate_limited",
  "mobile_auth_service_unavailable",
]);
const RETURN_ROUTE_MAX_CHARACTERS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function isCanonicalState(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isAllowedReturnRoute(value: unknown): value is string {
  if (
    !isBoundedString(value, RETURN_ROUTE_MAX_CHARACTERS) ||
    value.includes("%") ||
    value.includes("\\")
  ) {
    return false;
  }

  return /^\/(?:parts(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,127})?|quotes(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,127})?|search|projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.test(
    value,
  );
}

function isMobileAuthErrorCode(value: unknown): value is MobileAuthErrorCode {
  return typeof value === "string" && MOBILE_AUTH_ERROR_CODES.has(value as MobileAuthErrorCode);
}

function isRetryInstruction(value: unknown): value is MobileAuthRetryInstruction {
  return value === "none" || value === "network" || value === "restart" || value === "later";
}

function clearPersistedBootstrapSession() {
  if (typeof window === "undefined") {
    return;
  }

  let storageKey = "supabase.auth.token";
  try {
    const authUrl = new URL(import.meta.env.VITE_SUPABASE_URL);
    storageKey = `sb-${authUrl.hostname.split(".")[0]}-auth-token`;
  } catch {
    // Keep cleanup bounded when no project URL is available.
  }

  try {
    window.localStorage.removeItem(storageKey);
    window.localStorage.removeItem(`${storageKey}-code-verifier`);
    window.localStorage.removeItem(`${storageKey}-user`);
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
}

function resolveDocument(dependencies: BootstrapDependencies): Document | null {
  if (dependencies.document) {
    return dependencies.document;
  }

  if (typeof document === "undefined") {
    return null;
  }

  return document;
}

/**
 * Removes and parses the server-rendered inert bootstrap payload.
 */
export function readBootstrapConfig(
  sourceDocument: Document,
  elementId = BOOTSTRAP_CONFIG_ELEMENT_ID,
): BootstrapConfig | null {
  const element = sourceDocument.getElementById(elementId);
  if (!element) {
    return null;
  }

  const serializedConfig = element.textContent;
  element.remove();

  if (!serializedConfig) {
    return null;
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(serializedConfig);
  } catch {
    return null;
  }

  if (!isRecord(candidate) || candidate.version !== 1 || !isCanonicalState(candidate.state)) {
    return null;
  }

  if (isRecord(candidate.session)) {
    if (!isAllowedReturnRoute(candidate.returnTo)) {
      return null;
    }

    if (
      !isBoundedString(candidate.session.accessToken, 16_384) ||
      !isBoundedString(candidate.session.refreshToken, 8_192)
    ) {
      return null;
    }

    return {
      version: 1,
      state: candidate.state,
      returnTo: candidate.returnTo,
      session: {
        accessToken: candidate.session.accessToken,
        refreshToken: candidate.session.refreshToken,
      },
    };
  }

  if (!isRecord(candidate.error)) {
    return null;
  }

  if (
    !isMobileAuthErrorCode(candidate.error.code) ||
    !isRetryInstruction(candidate.error.retry)
  ) {
    return null;
  }

  return {
    version: 1,
    state: candidate.state,
    error: {
      code: candidate.error.code,
      retry: candidate.error.retry,
    },
  };
}

/**
 * Sends a redacted bootstrap result through the fixed native message handler.
 */
export function reportBootstrapStatus(status: BootstrapStatus): boolean {
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

function hasMobileAuthNativeHost(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const webKitWindow = window as WebKitWindow;
  return Boolean(webKitWindow.webkit?.messageHandlers?.mobileAuth);
}

async function clearPartialAuthState(
  client: BootstrapAuthClient,
  clearPersistedSession: () => void,
) {
  try {
    await client.auth.signOut({ scope: "local" });
  } catch {
    // The persisted session is still removed below.
  } finally {
    clearPersistedSession();
  }
}

function isVerifiedSession(session: Session | null | undefined): session is Session {
  return Boolean(session);
}

/**
 * Persists a transferred session in the shared web client before notifying iOS.
 */
export async function runBootstrapEntry(
  dependencies: BootstrapDependencies = {},
): Promise<BootstrapStatus | null> {
  const sourceDocument = resolveDocument(dependencies);
  if (!sourceDocument) {
    return null;
  }

  const config = readBootstrapConfig(sourceDocument);
  if (!config) {
    return null;
  }

  const hasNativeHost = dependencies.hasNativeHost ?? hasMobileAuthNativeHost;
  if (!hasNativeHost()) {
    if ("session" in config) {
      config.session.accessToken = "";
      config.session.refreshToken = "";
    }
    return null;
  }

  const client = dependencies.client ?? (supabase as unknown as BootstrapAuthClient);
  const reportStatus = dependencies.reportStatus ?? reportBootstrapStatus;
  const clearPersistedSession =
    dependencies.clearPersistedSession ?? clearPersistedBootstrapSession;

  if ("error" in config) {
    const status: BootstrapErrorStatus = {
      version: 1,
      status: "error",
      state: config.state,
      code: config.error.code,
      retry: config.error.retry,
    };
    reportStatus(status);
    return status;
  }

  const credentials = config.session;

  try {
    const result = await client.auth.setSession({
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
    });

    if (result.error || !isVerifiedSession(result.data.session)) {
      throw new Error("Mobile authentication bootstrap failed.");
    }

    const authenticatedUser = await client.auth.getUser();
    if (
      authenticatedUser.error ||
      !authenticatedUser.data.user ||
      authenticatedUser.data.user.id !== result.data.session.user.id
    ) {
      throw new Error("Mobile authentication bootstrap failed.");
    }

    const status: BootstrapReadyStatus = {
      version: 1,
      status: "ready",
      state: config.state,
      returnTo: config.returnTo,
    };
    reportStatus(status);
    return status;
  } catch {
    await clearPartialAuthState(client, clearPersistedSession);

    const status: BootstrapErrorStatus = {
      version: 1,
      status: "error",
      state: config.state,
      code: "mobile_auth_bootstrap_failed",
      retry: "restart",
    };
    reportStatus(status);
    return status;
  } finally {
    credentials.accessToken = "";
    credentials.refreshToken = "";
  }
}
