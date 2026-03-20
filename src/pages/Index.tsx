import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import { useAppSession } from "@/hooks/use-app-session";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";

const Index = () => {
  const { activeMembership, isAuthInitializing } = useAppSession();

  if (isAuthInitializing) {
    return <AuthBootstrapScreen message="Restoring your workspace." />;
  }

  if (activeMembership?.role === "internal_admin" || activeMembership?.role === "internal_estimator") {
    return <InternalHome />;
  }

  return <ClientHome />;
};

export default Index;
