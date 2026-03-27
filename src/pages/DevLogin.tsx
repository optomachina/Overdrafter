import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import NotFound from "@/pages/NotFound";
import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_AUTHENTICATED_REDIRECT, sanitizeInternalRedirect } from "@/lib/internal-redirect";

type DevLoginResponse = {
  actionLink?: unknown;
};

export default function DevLogin() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    const redirectPath = sanitizeInternalRedirect(
      new URL(window.location.href).searchParams.get("redirect"),
      DEFAULT_AUTHENTICATED_REDIRECT,
    );

    let cancelled = false;

    void (async () => {
      const { data, error } = await supabase.functions.invoke("dev-login", {
        body: {
          redirectPath,
          appOrigin: window.location.origin,
        },
      });

      if (cancelled) {
        return;
      }

      if (error) {
        setErrorMessage(error.message);
        return;
      }

      const actionLink = (data as DevLoginResponse | null)?.actionLink;

      if (typeof actionLink !== "string" || actionLink.length === 0) {
        setErrorMessage("Dev login returned an invalid response.");
        return;
      }

      // The Edge Function only exists for local development and returns a
      // one-time Supabase auth link for the existing demo user.
      window.location.assign(actionLink);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!import.meta.env.DEV) {
    return <NotFound />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {errorMessage ?? "Creating a local development session for dmrifles@gmail.com..."}
        </p>
      </div>
    </div>
  );
}
