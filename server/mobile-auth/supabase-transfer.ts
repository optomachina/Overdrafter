import { createClient } from "@supabase/supabase-js";
import { MOBILE_AUTH_LIMITS } from "./contract.js";
import { createMobileAuthUpstreamFetch } from "./upstream-fetch.js";

export interface TransferSessionMaterial {
  accessToken: string;
  refreshToken: string;
}

export interface VerifiedTransferSession extends TransferSessionMaterial {
  userId: string;
  sessionId: string;
}

interface AuthUser {
  id: string;
}

interface AuthSession {
  access_token: string;
  refresh_token: string;
  user: AuthUser;
}

interface TransferAuthClient {
  auth: {
    getUser: (accessToken: string) => Promise<{
      data: { user: AuthUser | null };
      error: unknown;
    }>;
    refreshSession: (session: { refresh_token: string }) => Promise<{
      data: { session: AuthSession | null; user: AuthUser | null };
      error: unknown;
    }>;
  };
}

export interface TransferSessionVerifier {
  verifyAndRotate: (material: TransferSessionMaterial) => Promise<VerifiedTransferSession | null>;
  verifyForBootstrap: (
    material: TransferSessionMaterial,
    expected: { userId: string; sessionId: string },
  ) => Promise<boolean>;
}

interface TransferVerifierDependencies {
  createAuthClient?: (url: string, publishableKey: string) => TransferAuthClient;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createIsolatedClient(url: string, publishableKey: string): TransferAuthClient {
  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      fetch: createMobileAuthUpstreamFetch(),
    },
  }) as unknown as TransferAuthClient;
}

function readSessionId(accessToken: string): string | null {
  const segments = accessToken.split(".");
  if (segments.length !== 3) {
    return null;
  }

  const payloadSegment = segments[1];
  if (!payloadSegment || !/^[A-Za-z0-9_-]+$/.test(payloadSegment)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as {
      session_id?: unknown;
    };
    if (typeof payload.session_id !== "string" || !UUID_PATTERN.test(payload.session_id)) {
      return null;
    }

    return payload.session_id.toLowerCase();
  } catch {
    return null;
  }
}

function hasUsableMaterial(material: TransferSessionMaterial): boolean {
  return (
    material.accessToken.length > 0 &&
    material.accessToken.length <= MOBILE_AUTH_LIMITS.accessTokenBytes &&
    material.refreshToken.length > 0 &&
    material.refreshToken.length <= MOBILE_AUTH_LIMITS.refreshTokenBytes
  );
}

/**
 * Creates the isolated Supabase verifier used only by the mobile transfer
 * boundary. It never persists a session or enables automatic refresh.
 */
export function createTransferSessionVerifier(
  url: string,
  publishableKey: string,
  dependencies: TransferVerifierDependencies = {},
): TransferSessionVerifier {
  const createAuthClient = dependencies.createAuthClient ?? createIsolatedClient;

  return {
    async verifyAndRotate(material) {
      if (!hasUsableMaterial(material)) {
        return null;
      }

      const originalSessionId = readSessionId(material.accessToken);
      if (!originalSessionId) {
        return null;
      }

      const client = createAuthClient(url, publishableKey);
      const originalUserResult = await client.auth.getUser(material.accessToken);
      if (originalUserResult.error || !originalUserResult.data.user) {
        return null;
      }

      const refreshResult = await client.auth.refreshSession({
        refresh_token: material.refreshToken,
      });
      const rotatedSession = refreshResult.data.session;
      const rotatedUser = refreshResult.data.user ?? rotatedSession?.user ?? null;
      if (refreshResult.error || !rotatedSession || !rotatedUser) {
        return null;
      }

      const rotatedSessionId = readSessionId(rotatedSession.access_token);
      if (
        !rotatedSessionId ||
        rotatedSessionId !== originalSessionId ||
        rotatedUser.id !== originalUserResult.data.user.id
      ) {
        return null;
      }

      const rotatedUserResult = await client.auth.getUser(rotatedSession.access_token);
      if (
        rotatedUserResult.error ||
        rotatedUserResult.data.user?.id !== rotatedUser.id
      ) {
        return null;
      }

      return {
        accessToken: rotatedSession.access_token,
        refreshToken: rotatedSession.refresh_token,
        sessionId: rotatedSessionId,
        userId: rotatedUser.id,
      };
    },

    async verifyForBootstrap(material, expected) {
      if (!hasUsableMaterial(material)) {
        return false;
      }

      const sessionId = readSessionId(material.accessToken);
      if (!sessionId || sessionId !== expected.sessionId.toLowerCase()) {
        return false;
      }

      const client = createAuthClient(url, publishableKey);
      const userResult = await client.auth.getUser(material.accessToken);
      return (
        !userResult.error &&
        userResult.data.user !== null &&
        userResult.data.user.id === expected.userId
      );
    },
  };
}

export const transferSessionInternals = {
  readSessionId,
};
