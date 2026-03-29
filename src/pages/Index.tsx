import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import NorthStarWorkspacePreview from "@/pages/NorthStarWorkspacePreview";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { useAppSession } from "@/hooks/use-app-session";
import { resolveWorkspaceUiVariant } from "@/lib/workspace-ui-variant";

const Index = () => {
  const { user, activeMembership, isAuthInitializing } = useAppSession();

  if (isAuthInitializing && !user) {
    return <AuthBootstrapScreen message="Restoring your workspace." />;
  }

  if (activeMembership?.role === "internal_admin" || activeMembership?.role === "internal_estimator") {
    return <InternalHome />;
  }

  const variant = resolveWorkspaceUiVariant({
    role: activeMembership?.role ?? null,
    enableNorthStarUiEnv: import.meta.env.VITE_ENABLE_NORTH_STAR_UI,
    search: window.location.search,
  });

  if (variant === "north_star_preview") {
    return <NorthStarWorkspacePreview />;
  }

  return <ClientHome />;
};

export default Index;
