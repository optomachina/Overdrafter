import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  getStoredSupabaseAccessToken,
  getVerifiedUserForStoredToken,
  rememberVerifiedUser,
} from "./startup-auth";

let inFlightUserRead: { accessToken: string; promise: Promise<User> } | null = null;

async function readCurrentUser(accessToken: string | null): Promise<User> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    throw error;
  }

  if (!user) {
    throw new Error("You must be signed in to continue.");
  }

  if (accessToken) {
    rememberVerifiedUser(accessToken, user);
  }

  return user;
}

/**
 * Returns the signed-in user for API reads and writes.
 *
 * supabase-js serialises getUser() under its auth lock, one network round trip
 * each, so a workspace load that verified the user once per query paints only
 * after all of them. A user already verified over the network for the exact
 * stored access token (by the session restore or an earlier call) is reused,
 * and concurrent reads for the same token share one getUser(). Any change of
 * stored token (sign-out, account switch, refresh) or an expired token makes
 * the next call verify over the network again.
 */
export async function requireCurrentUser(): Promise<User> {
  const verified = getVerifiedUserForStoredToken();
  if (verified) {
    return verified;
  }

  const accessToken = getStoredSupabaseAccessToken();
  if (!accessToken) {
    return readCurrentUser(null);
  }

  if (inFlightUserRead?.accessToken === accessToken) {
    return inFlightUserRead.promise;
  }

  const entry = { accessToken, promise: readCurrentUser(accessToken) };
  inFlightUserRead = entry;
  const settle = () => {
    if (inFlightUserRead === entry) {
      inFlightUserRead = null;
    }
  };
  entry.promise.then(settle, settle);
  return entry.promise;
}

export function resetCurrentUserReadForTests(): void {
  inFlightUserRead = null;
}
