import { lazy, Suspense, useEffect, useState } from "react";
import { useAppSession } from "@/hooks/use-app-session";
import { callRpc } from "@/features/quotes/api/shared/rpc";
import NotFound from "./NotFound";

// Loaded only after the server admits the caller, so non-admins never fetch the engineering chunk.
const EngineeringInbox = lazy(() => import("./EngineeringInbox"));

type Admission = "checking" | "admitted" | "denied";

/**
 * Hosted `/engineering` entry. The server-side platform admin allowlist decides admission on every
 * visit; cached client session flags are never consulted. Signed-out and non-admin callers see the
 * ordinary not found page. Conversation data stays behind its own RLS and operator allowlist.
 */
export default function EngineeringAdminRoute() {
  const session = useAppSession();
  const userId = session.authState === "authenticated" ? session.user?.id ?? null : null;
  const [admission, setAdmission] = useState<{ readonly userId: string; readonly state: Admission } | null>(null);

  useEffect(() => {
    if (!userId) return;
    let live = true;
    setAdmission({ userId, state: "checking" });
    callRpc("api_get_is_platform_admin")
      .then((result) => result.error === null && result.data === true)
      .catch(() => false)
      .then((admitted) => {
        if (live) setAdmission({ userId, state: admitted ? "admitted" : "denied" });
      });
    return () => {
      live = false;
    };
  }, [userId]);

  if (session.isAuthInitializing) return null;
  if (!userId) return <NotFound />;
  if (admission?.userId !== userId || admission.state === "checking") return null;
  if (admission.state === "denied") return <NotFound />;
  return (
    <Suspense fallback={null}>
      <EngineeringInbox />
    </Suspense>
  );
}
