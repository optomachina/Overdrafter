import { supabase } from "@/integrations/supabase/client";

export type TotpFactor = {
  id: string;
  friendlyName: string;
  status: "verified" | "unverified";
  createdAt: string;
};

export type TotpEnrollment = {
  factorId: string;
  qrCode: string;
  secret: string;
  uri: string;
};

function requireData<T>(
  data: T | null,
  error: { message: string } | null,
  fallback: string,
): T {
  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error(fallback);
  }

  return data;
}

/**
 * Lists only TOTP factors because TOTP is the supported first-release
 * commercial-admin step-up method.
 */
export async function listTotpFactors(): Promise<TotpFactor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  const factors = requireData(
    data,
    error,
    "Multi-factor authentication factors were not returned.",
  );

  return factors.totp.map((factor) => ({
    id: factor.id,
    friendlyName: factor.friendly_name ?? "Authenticator app",
    status: factor.status,
    createdAt: factor.created_at,
  }));
}

/**
 * Starts enrollment for a new authenticator-app factor.
 */
export async function beginTotpEnrollment(): Promise<TotpEnrollment> {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "OverDrafter commercial admin",
  });
  const enrollment = requireData(
    data,
    error,
    "Multi-factor enrollment was not returned.",
  );

  return {
    factorId: enrollment.id,
    qrCode: enrollment.totp.qr_code,
    secret: enrollment.totp.secret,
    uri: enrollment.totp.uri,
  };
}

/**
 * Removes an abandoned authenticator enrollment so its secret is not lost
 * while an unusable, unverified factor remains attached to the account.
 */
export async function unenrollTotpFactor(factorId: string): Promise<void> {
  const { data, error } = await supabase.auth.mfa.unenroll({ factorId });

  requireData(data, error, "Multi-factor unenrollment was not returned.");
}

/**
 * Verifies an existing or newly enrolled authenticator-app factor and upgrades
 * the current Supabase session to AAL2.
 */
export async function verifyTotpCode(input: {
  factorId: string;
  code: string;
}): Promise<void> {
  const { data, error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: input.factorId,
    code: input.code.trim(),
  });

  requireData(data, error, "Multi-factor verification was not returned.");
}
