import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { DiagnosticsPanel } from "@/components/debug/DiagnosticsPanel";
import { useAppSession } from "@/hooks/use-app-session";
import {
  installDiagnostics,
  setDiagnosticsEnabled,
  setDiagnosticsPanelOpen,
  updateDiagnosticsContext,
} from "@/lib/diagnostics";

export function DiagnosticsBootstrap() {
  const location = useLocation();
  const { user, activeMembership } = useAppSession();

  useEffect(() => {
    installDiagnostics();
  }, []);

  useEffect(() => {
    const route = `${location.pathname}${location.search}${location.hash}`;
    const params = new URLSearchParams(location.search);
    const debugValue = params.get("debug");

    updateDiagnosticsContext({
      route,
      href: typeof window !== "undefined" ? window.location.href : route,
    });

    if (debugValue === "1") {
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

  return <DiagnosticsPanel />;
}
