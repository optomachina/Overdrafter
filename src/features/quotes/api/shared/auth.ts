import { supabase } from "@/integrations/supabase/client";

export async function requireCurrentUser() {
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

  return user;
}
