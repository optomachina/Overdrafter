import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ConceptsGallery } from "@/concepts/ConceptsGallery";
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

  const workspaceUiVariant = resolveWorkspaceUiVariant(window.location.search);

  if (workspaceUiVariant === "northstar") {
    return <ConceptsGallery />;
  }

  return <ClientHome />;
};

export default Index;
