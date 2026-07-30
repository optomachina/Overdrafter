import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { useAppSession } from "@/hooks/use-app-session";
import { Navigate, useLocation } from "react-router-dom";

const Index = () => {
  const { user, activeMembership, isAuthInitializing } = useAppSession();
  const { search, hash } = useLocation();

  if (isAuthInitializing && !user) {
    return <AuthBootstrapScreen message="Restoring your workspace." />;
  }

  if (activeMembership?.role === "internal_admin" || activeMembership?.role === "internal_estimator") {
    return <InternalHome />;
  }

  if (activeMembership?.role === "client") {
    return <Navigate to={{ pathname: "/parts", search, hash }} replace />;
  }

  return <ClientHome />;
};

export default Index;
