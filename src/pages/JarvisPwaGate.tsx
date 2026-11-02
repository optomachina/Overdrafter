import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { MfaStepUpDialog } from "@/components/auth/MfaStepUpDialog";
import { loadJarvisPwaSession, type JarvisPwaClientResult } from "@/features/jarvis/pwa-client";
import { getStoredSupabaseAccessToken } from "@/features/quotes/api/shared/startup-auth";
import { supabase } from "@/integrations/supabase/client";
import NotFound from "./NotFound";

const JarvisPwaShell = lazy(() => import("./JarvisPwaShell"));

async function defaultReadToken(): Promise<string | null> {
  const stored = getStoredSupabaseAccessToken();
  if (stored) return stored;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export default function JarvisPwaGate({
  readToken = defaultReadToken,
}: {
  readonly readToken?: () => Promise<string | null>;
} = {}) {
  const [result, setResult] = useState<JarvisPwaClientResult | "checking">("checking");
  const [stepUpOpen, setStepUpOpen] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // Read the stored token during render so a later auth cleanup cannot drop it first.
  // `attempt` is part of the read so a finished authenticator step asks the server again.
  const tokenPromise = useMemo(
    () => readToken().then((token) => (attempt >= 0 ? token : null)).catch(() => null),
    [attempt, readToken],
  );

  useEffect(() => {
    let live = true;
    setResult("checking");
    void tokenPromise
      .then((token) => loadJarvisPwaSession(token))
      .then((next) => {
        if (live) setResult(next);
      })
      .catch(() => {
        if (live) setResult({ kind: "absent" });
      });
    return () => {
      live = false;
    };
  }, [tokenPromise]);

  if (result === "checking") return null;
  if (result.kind === "signed_out") return <Navigate to="/?auth=signin" replace />;
  if (result.kind === "absent") return <NotFound />;
  if (result.kind === "step_up") {
    return (
      <main style={{ background: "#0E0E10", color: "#F2F1EE", minHeight: "100dvh", padding: 24 }}>
        <h1 style={{ fontSize: 20 }}>Confirm it is you</h1>
        <p>Enter the code from your authenticator app. The thread stays closed until that code is accepted.</p>
        <button type="button" style={{ minHeight: 44, minWidth: 44 }} onClick={() => setStepUpOpen(true)}>
          Enter authenticator code
        </button>
        <MfaStepUpDialog
          open={stepUpOpen}
          onOpenChange={setStepUpOpen}
          onVerified={() => {
            setStepUpOpen(false);
            setAttempt((value) => value + 1);
          }}
          title="Confirm it is you"
          description="Enter the code from your authenticator app."
        />
      </main>
    );
  }
  return (
    <Suspense fallback={null}>
      <JarvisPwaShell />
    </Suspense>
  );
}
