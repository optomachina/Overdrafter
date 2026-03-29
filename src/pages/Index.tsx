import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import NorthStarPreviewHome from "@/pages/NorthStarPreviewHome";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { useAppSession } from "@/hooks/use-app-session";
import { resolveWorkspaceUiVariant } from "@/lib/workspace-ui-variant";

const Index = () => {
  const location = useLocation();
  const { user, activeMembership, isAuthInitializing } = useAppSession();

  const workspaceUiVariant = useMemo(
    () =>
      resolveWorkspaceUiVariant({
        role: activeMembership?.role,
        searchParams: new URLSearchParams(location.search),
        enableNorthStarUiEnv: import.meta.env.VITE_ENABLE_NORTH_STAR_UI,
      }),
    [activeMembership?.role, location.search],
  );

  if (isAuthInitializing && !user) {
    return <AuthBootstrapScreen message="Restoring your workspace." />;
  }

  if (activeMembership?.role === "internal_admin" || activeMembership?.role === "internal_estimator") {
    return <InternalHome />;
  }

  if (workspaceUiVariant === "north_star_preview") {
    return <NorthStarPreviewHome />;
  }

  return <ClientHome />;
};

export default Index;
