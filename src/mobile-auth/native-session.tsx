import { useEffect, useState } from "react";
import { removeStoredSupabaseSession } from "@/features/quotes/api/shared/startup-auth";
import { supabase } from "@/integrations/supabase/client";
import {
  hasNativeMobileAuthHandler,
  reportNativeSessionStatus,
  runNativeSessionAction,
} from "./native-session-control";

type NativeSessionAction = "probe" | "logout";

function isIosNativeRequest(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get("app") === "ios";
}

function parseNativeSessionAction(): NativeSessionAction | null {
  if (typeof window === "undefined") {
    return null;
  }

  const action = new URLSearchParams(window.location.search).get("action");
  return action === "probe" || action === "logout" ? action : null;
}

/**
 * Same-origin control page used by the native shell for session restoration and
 * app-local logout.
 */
export function NativeSessionRoute() {
  const [label, setLabel] = useState("Checking session…");

  useEffect(() => {
    if (!isIosNativeRequest() || !hasNativeMobileAuthHandler()) {
      setLabel("Open this page from OverDrafter for iOS.");
      return;
    }

    const action = parseNativeSessionAction();
    if (!action) {
      reportNativeSessionStatus({
        version: 1,
        status: "error",
        code: "mobile_auth_session_invalid",
      });
      setLabel("Unable to complete the session request.");
      return;
    }

    let cancelled = false;

    void runNativeSessionAction(action).then((status) => {
      if (cancelled) {
        return;
      }

      setLabel(status.status === "authenticated" ? "Session restored." : "Session check complete.");
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <output className="text-sm text-muted-foreground">
        {label}
      </output>
    </main>
  );
}

/**
 * Notifies the native shell when an ordinary workspace action signs the shared
 * browser session out.
 */
export function NativeSessionSignOutObserver() {
  useEffect(() => {
    if (
      !hasNativeMobileAuthHandler() ||
      window.location.pathname === "/auth/mobile/native-session"
    ) {
      return;
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT") {
        return;
      }

      removeStoredSupabaseSession();
      reportNativeSessionStatus({
        version: 1,
        status: "signed_out",
      });
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  return null;
}
