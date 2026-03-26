import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";
import { DEFAULT_AUTHENTICATED_REDIRECT, sanitizeInternalRedirect } from "@/lib/internal-redirect";

/**
 * Landing page for the OAuth PKCE callback.
 *
 * After Supabase redirects back here with `?code=…`, the Supabase client
 * automatically exchanges the code for a session (because `flowType: 'pkce'`
 * and `detectSessionInUrl: true` are both set). We simply wait for the
 * `SIGNED_IN` event and then navigate to the app root.
 */
export default function AuthCallback() {
  const navigate = useNavigate();
  const hasRedirected = useRef(false);
  const redirectPath = sanitizeInternalRedirect(
    typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get("redirect"),
    DEFAULT_AUTHENTICATED_REDIRECT,
  );

  useEffect(() => {
    // Check whether we already have an active session (e.g. the exchange
    // completed synchronously before this effect ran).
    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (session && !hasRedirected.current) {
        hasRedirected.current = true;
        navigate(redirectPath, { replace: true });
        return;
      }

      // If there's no code in the URL either, bail out to sign-in.
      const code = new URL(window.location.href).searchParams.get("code");
      if (!code && !hasRedirected.current) {
        hasRedirected.current = true;
        navigate("/signin", { replace: true });
      }
    });

    // Listen for the SIGNED_IN event fired once the code exchange completes.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (hasRedirected.current) return;

      if (event === "SIGNED_IN" && session) {
        hasRedirected.current = true;
        navigate(redirectPath, { replace: true });
      } else if (event === "SIGNED_OUT") {
        hasRedirected.current = true;
        navigate("/signin", { replace: true });
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [navigate, redirectPath]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Signing you in…</p>
      </div>
    </div>
  );
}
