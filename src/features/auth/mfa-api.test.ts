import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginTotpEnrollment,
  listTotpFactors,
  unenrollTotpFactor,
  verifyTotpCode,
} from "./mfa-api";

const supabaseMock = vi.hoisted(() => ({
  challengeAndVerify: vi.fn(),
  enroll: vi.fn(),
  listFactors: vi.fn(),
  unenroll: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      mfa: {
        challengeAndVerify: supabaseMock.challengeAndVerify,
        enroll: supabaseMock.enroll,
        listFactors: supabaseMock.listFactors,
        unenroll: supabaseMock.unenroll,
      },
    },
  },
}));

describe("mfa-api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes only TOTP factors and supplies the fallback friendly name", async () => {
    supabaseMock.listFactors.mockResolvedValue({
      data: {
        all: [
          {
            id: "phone-1",
            factor_type: "phone",
            status: "verified",
          },
        ],
        phone: [
          {
            id: "phone-1",
            status: "verified",
          },
        ],
        totp: [
          {
            id: "totp-verified",
            friendly_name: "Blaine's authenticator",
            status: "verified",
            created_at: "2026-07-01T12:00:00.000Z",
          },
          {
            id: "totp-unverified",
            friendly_name: null,
            status: "unverified",
            created_at: "2026-07-02T12:00:00.000Z",
          },
        ],
      },
      error: null,
    });

    await expect(listTotpFactors()).resolves.toEqual([
      {
        id: "totp-verified",
        friendlyName: "Blaine's authenticator",
        status: "verified",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
      {
        id: "totp-unverified",
        friendlyName: "Authenticator app",
        status: "unverified",
        createdAt: "2026-07-02T12:00:00.000Z",
      },
    ]);
    expect(supabaseMock.listFactors).toHaveBeenCalledWith();
  });

  it("maps enrollment data and uses the fixed commercial-admin enrollment label", async () => {
    supabaseMock.enroll.mockResolvedValue({
      data: {
        id: "factor-new",
        type: "totp",
        totp: {
          qr_code: "data:image/svg+xml;base64,qr-code",
          secret: "TOTP-SECRET-123",
          uri: "otpauth://totp/OverDrafter",
        },
      },
      error: null,
    });

    await expect(beginTotpEnrollment()).resolves.toEqual({
      factorId: "factor-new",
      qrCode: "data:image/svg+xml;base64,qr-code",
      secret: "TOTP-SECRET-123",
      uri: "otpauth://totp/OverDrafter",
    });
    expect(supabaseMock.enroll).toHaveBeenCalledWith({
      factorType: "totp",
      friendlyName: "OverDrafter commercial admin",
    });
  });

  it("trims the code and passes the exact factor to challenge-and-verify", async () => {
    supabaseMock.challengeAndVerify.mockResolvedValue({
      data: {
        access_token: "access-token",
        expires_at: 1_785_000_000,
      },
      error: null,
    });

    await expect(
      verifyTotpCode({
        factorId: "factor-verified",
        code: "  123456  ",
      }),
    ).resolves.toBeUndefined();
    expect(supabaseMock.challengeAndVerify).toHaveBeenCalledWith({
      factorId: "factor-verified",
      code: "123456",
    });
  });

  it("removes the exact abandoned authenticator factor", async () => {
    supabaseMock.unenroll.mockResolvedValue({
      data: { id: "factor-abandoned" },
      error: null,
    });

    await expect(
      unenrollTotpFactor("factor-abandoned"),
    ).resolves.toBeUndefined();
    expect(supabaseMock.unenroll).toHaveBeenCalledWith({
      factorId: "factor-abandoned",
    });
  });

  it("rejects missing factor-list data", async () => {
    supabaseMock.listFactors.mockResolvedValue({ data: null, error: null });

    await expect(listTotpFactors()).rejects.toThrow(
      "Multi-factor authentication factors were not returned.",
    );
  });

  it("rejects missing enrollment data", async () => {
    supabaseMock.enroll.mockResolvedValue({ data: null, error: null });

    await expect(beginTotpEnrollment()).rejects.toThrow(
      "Multi-factor enrollment was not returned.",
    );
  });

  it("rejects missing verification data", async () => {
    supabaseMock.challengeAndVerify.mockResolvedValue({
      data: null,
      error: null,
    });

    await expect(
      verifyTotpCode({ factorId: "factor-1", code: "123456" }),
    ).rejects.toThrow("Multi-factor verification was not returned.");
  });

  it("rejects missing unenrollment data", async () => {
    supabaseMock.unenroll.mockResolvedValue({ data: null, error: null });

    await expect(unenrollTotpFactor("factor-1")).rejects.toThrow(
      "Multi-factor unenrollment was not returned.",
    );
  });

  it.each([
    ["factor listing", "listFactors", listTotpFactors],
    ["enrollment", "enroll", beginTotpEnrollment],
  ] as const)("propagates the Supabase %s error", async (_label, method, call) => {
    const apiError = { message: `${method} failed`, status: 500 };
    supabaseMock[method].mockResolvedValue({ data: null, error: apiError });

    await expect(call()).rejects.toBe(apiError);
  });

  it("propagates the Supabase verification error", async () => {
    const apiError = { message: "challenge failed", status: 422 };
    supabaseMock.challengeAndVerify.mockResolvedValue({
      data: null,
      error: apiError,
    });

    await expect(
      verifyTotpCode({ factorId: "factor-1", code: "123456" }),
    ).rejects.toBe(apiError);
  });

  it("propagates the Supabase unenrollment error", async () => {
    const apiError = { message: "unenroll failed", status: 500 };
    supabaseMock.unenroll.mockResolvedValue({
      data: null,
      error: apiError,
    });

    await expect(unenrollTotpFactor("factor-1")).rejects.toBe(apiError);
  });
});
