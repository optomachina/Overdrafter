import type { User } from "@supabase/supabase-js";

const TRUSTED_SOCIAL_PROVIDERS = new Set(["apple", "azure", "google"]);

type UserAuthStatus = Pick<User, "app_metadata" | "confirmed_at" | "email_confirmed_at">;

export function getAuthProvider(user: UserAuthStatus | null | undefined): string | null {
  const provider = user?.app_metadata?.provider;
  return typeof provider === "string" ? provider : null;
}

export function hasVerifiedAuth(user: UserAuthStatus | null | undefined): boolean {
  if (!user) {
    return false;
  }

  return Boolean(
    user.email_confirmed_at ||
      user.confirmed_at ||
      TRUSTED_SOCIAL_PROVIDERS.has(getAuthProvider(user) ?? ""),
  );
}

export function isEmailConfirmationRequired(user: UserAuthStatus | null | undefined): boolean {
  return Boolean(user) && !hasVerifiedAuth(user);
}
