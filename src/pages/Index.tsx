import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { useAppSession } from "@/hooks/use-app-session";
import { resolveWorkspaceUiVariant } from "@/lib/workspace-ui-variant";

const Index = () => {
  const { user, activeMembership, isAuthInitializing } = useAppSession();

  if (isAuthInitializing && !user) {
    return <AuthBootstrapScreen message="Restoring your workspace." />;
  }

  const isInternalUser =
    activeMembership?.role === "internal_admin" || activeMembership?.role === "internal_estimator";

  if (isInternalUser) {
    return <InternalHome />;
  }

  const variant = resolveWorkspaceUiVariant({
    envEnableNorthStarUi: import.meta.env.VITE_ENABLE_NORTH_STAR_UI,
    urlSearch: typeof window === "undefined" ? "" : window.location.search,
    isInternalUser,
  });

  if (variant === "north_star_preview") {
    return <ClientHome />;
  }

  return <ClientHome />;
};

export default Index;
