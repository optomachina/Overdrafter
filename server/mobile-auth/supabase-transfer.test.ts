import { describe, expect, it, vi } from "vitest";
import {
  createTransferSessionVerifier,
  transferSessionInternals,
  type TransferSessionMaterial,
} from "./supabase-transfer";

const USER_ID = "0190f3d0-7f34-7e19-8da9-1132a848e042";
const SESSION_ID = "0190f3d0-81d4-7f5f-9a31-792c0ef7f8b8";

function token(sessionId = SESSION_ID): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ session_id: sessionId })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function clientFor(options?: {
  originalUserId?: string;
  rotatedUserId?: string;
  rotatedSessionId?: string;
  originalError?: unknown;
  refreshError?: unknown;
}) {
  const originalToken = token();
  const rotatedToken = token(options?.rotatedSessionId);
  const getUser = vi
    .fn()
    .mockResolvedValueOnce({
      data: options?.originalError
        ? { user: null }
        : { user: { id: options?.originalUserId ?? USER_ID } },
      error: options?.originalError ?? null,
    })
    .mockResolvedValueOnce({
      data: { user: { id: options?.rotatedUserId ?? USER_ID } },
      error: null,
    });
  const refreshSession = vi.fn().mockResolvedValue({
    data: options?.refreshError
      ? { session: null, user: null }
      : {
          session: {
            access_token: rotatedToken,
            refresh_token: "rotated-refresh-token",
            user: { id: options?.rotatedUserId ?? USER_ID },
          },
          user: { id: options?.rotatedUserId ?? USER_ID },
        },
    error: options?.refreshError ?? null,
  });

  return {
    client: { auth: { getUser, refreshSession } },
    material: {
      accessToken: originalToken,
      refreshToken: "original-refresh-token",
    } satisfies TransferSessionMaterial,
    getUser,
    refreshSession,
  };
}

describe("transfer Supabase session verification", () => {
  it("verifies the original session, rotates it, and verifies the rotated user", async () => {
    const fixture = clientFor();
    const verifier = createTransferSessionVerifier("https://example.supabase.co", "publishable", {
      createAuthClient: () => fixture.client,
    });

    await expect(verifier.verifyAndRotate(fixture.material)).resolves.toEqual({
      accessToken: token(),
      refreshToken: "rotated-refresh-token",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    expect(fixture.getUser).toHaveBeenCalledTimes(2);
    expect(fixture.refreshSession).toHaveBeenCalledWith({
      refresh_token: "original-refresh-token",
    });
  });

  it("rejects a refresh result for a different user or session", async () => {
    const wrongUser = clientFor({
      rotatedUserId: "0190f3d0-92e1-7af9-92bc-6067299048af",
    });
    const wrongSession = clientFor({
      rotatedSessionId: "0190f3d0-a08b-70fa-825e-11755dfd757b",
    });

    const wrongUserVerifier = createTransferSessionVerifier("https://example.supabase.co", "key", {
      createAuthClient: () => wrongUser.client,
    });
    const wrongSessionVerifier = createTransferSessionVerifier(
      "https://example.supabase.co",
      "key",
      {
        createAuthClient: () => wrongSession.client,
      },
    );

    await expect(wrongUserVerifier.verifyAndRotate(wrongUser.material)).resolves.toBeNull();
    await expect(wrongSessionVerifier.verifyAndRotate(wrongSession.material)).resolves.toBeNull();
  });

  it("rejects malformed JWT payloads before contacting Supabase", async () => {
    const createAuthClient = vi.fn();
    const verifier = createTransferSessionVerifier("https://example.supabase.co", "key", {
      createAuthClient,
    });

    await expect(
      verifier.verifyAndRotate({
        accessToken: "not-a-jwt",
        refreshToken: "refresh",
      }),
    ).resolves.toBeNull();
    expect(createAuthClient).not.toHaveBeenCalled();
    expect(transferSessionInternals.readSessionId("a.eyJub3QiOiJzZXNzaW9uIn0.c")).toBeNull();
  });

  it("checks the bound user and session again before bootstrap", async () => {
    const fixture = clientFor();
    fixture.getUser.mockReset();
    fixture.getUser.mockResolvedValue({
      data: { user: { id: USER_ID } },
      error: null,
    });
    const verifier = createTransferSessionVerifier("https://example.supabase.co", "key", {
      createAuthClient: () => fixture.client,
    });

    await expect(
      verifier.verifyForBootstrap(fixture.material, {
        sessionId: SESSION_ID,
        userId: USER_ID,
      }),
    ).resolves.toBe(true);
    await expect(
      verifier.verifyForBootstrap(fixture.material, {
        sessionId: "0190f3d0-a08b-70fa-825e-11755dfd757b",
        userId: USER_ID,
      }),
    ).resolves.toBe(false);
  });
});
