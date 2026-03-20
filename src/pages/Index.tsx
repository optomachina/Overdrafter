import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { useAppSession } from "@/hooks/use-app-session";

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
