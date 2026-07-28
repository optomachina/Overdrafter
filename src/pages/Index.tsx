import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { useAppSession } from "@/hooks/use-app-session";
import { Navigate } from "react-router-dom";

const Index = () => {
  const { user, activeMembership, isAuthInitializing } = useAppSession();

  if (isAuthInitializing && !user) {
    return <AuthBootstrapScreen message="Restoring your workspace." />;
  }

  if (activeMembership?.role === "internal_admin" || activeMembership?.role === "internal_estimator") {
    return <InternalHome />;
  }

  if (activeMembership?.role === "client") {
    return <Navigate to="/parts" replace />;
  }

  return <ClientHome />;
};

export default Index;
