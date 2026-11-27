import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { DiagnosticsPanel } from "@/components/debug/DiagnosticsPanel";
import { resolveDiagnosticsRouteMode } from "@/components/debug/diagnostics-route-mode";
import { UploadBatchOutcome } from "@/features/quotes/UploadBatchOutcome";
import { clearUploadBatch } from "@/features/quotes/upload-batch-store";
import { useAppSession } from "@/hooks/use-app-session";
import {
  installDiagnostics,
  setDiagnosticsEnabled,
  setDiagnosticsPanelOpen,
  setDiagnosticsUiSuppressed,
  updateDiagnosticsContext,
} from "@/lib/diagnostics";

export function DiagnosticsBootstrap() {
  const location = useLocation();
  const { user, activeMembership } = useAppSession();
  const userId = user?.id ?? null;
  const previousUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (previousUserId.current && previousUserId.current !== userId) {
      clearUploadBatch();
    }
    previousUserId.current = userId;
  }, [userId]);

  useEffect(() => {
    installDiagnostics();
  }, []);

  useEffect(() => {
    const route = `${location.pathname}${location.search}${location.hash}`;
    const { debugValue, embedded } = resolveDiagnosticsRouteMode(location.search);

    updateDiagnosticsContext({
      route,
      href: typeof window !== "undefined" ? window.location.href : route,
    });

    setDiagnosticsUiSuppressed(true);

    if (embedded) {
      setDiagnosticsPanelOpen(false);
    } else if (debugValue === "1") {
      setDiagnosticsEnabled(true);
      setDiagnosticsPanelOpen(true);
    } else if (debugValue === "0") {
      setDiagnosticsEnabled(false);
      setDiagnosticsPanelOpen(false);
    }
  }, [location.hash, location.pathname, location.search]);

  useEffect(() => {
    updateDiagnosticsContext({
      userId: user?.id ?? null,
      userEmail: user?.email ?? null,
      organizationId: activeMembership?.organizationId ?? null,
      membershipRole: activeMembership?.role ?? null,
      sessionState: user ? "signed_in" : "anonymous",
    });
  }, [activeMembership?.organizationId, activeMembership?.role, user]);

  return (
    <>
      <UploadBatchOutcome />
      <DiagnosticsPanel />
    </>
  );
}
